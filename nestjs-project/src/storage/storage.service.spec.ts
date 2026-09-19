// eslint-disable-next-line @typescript-eslint/no-require-imports
import fs = require('fs');
import { Test, TestingModule } from '@nestjs/testing';
import { StorageService } from './storage.service';
import storageConfig from '../config/storage.config';
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as fsp from 'fs/promises';

jest.mock('@aws-sdk/client-s3');
jest.mock('@aws-sdk/s3-request-presigner');

describe('StorageService', () => {
  let service: StorageService;
  let s3ClientMock: jest.Mocked<S3Client>;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageService,
        {
          provide: storageConfig.KEY,
          useValue: {
            endpoint: 'http://localhost:9000',
            region: 'us-east-1',
            accessKey: 'minioadmin',
            secretKey: 'minioadmin',
            bucketName: 'streamtube-videos',
            forcePathStyle: true,
          },
        },
      ],
    }).compile();

    service = module.get<StorageService>(StorageService);
    s3ClientMock = (S3Client as unknown as jest.Mock).mock
      .instances[0] as jest.Mocked<S3Client>;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create a multipart upload and return UploadId', async () => {
    (s3ClientMock.send as jest.Mock).mockResolvedValueOnce({
      UploadId: 'test-upload-id',
    });

    const uploadId = await service.createMultipartUpload(
      'test-key',
      'video/mp4',
    );

    expect(uploadId).toBe('test-upload-id');
    expect(s3ClientMock.send).toHaveBeenCalledTimes(1);
    expect(CreateMultipartUploadCommand).toHaveBeenCalledWith({
      Bucket: 'streamtube-videos',
      Key: 'test-key',
      ContentType: 'video/mp4',
    });
  });

  it('should generate presigned part URLs', async () => {
    (getSignedUrl as jest.Mock).mockResolvedValue('http://presigned-url');

    const urls = await service.getPresignedPartUrls(
      'test-key',
      'test-upload-id',
      2,
    );

    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe('http://presigned-url');
    expect(getSignedUrl).toHaveBeenCalledTimes(2);
    expect(UploadPartCommand).toHaveBeenCalledWith({
      Bucket: 'streamtube-videos',
      Key: 'test-key',
      UploadId: 'test-upload-id',
      PartNumber: 1,
    });
  });

  it('should complete multipart upload', async () => {
    (s3ClientMock.send as jest.Mock).mockResolvedValueOnce({} as any);

    await service.completeMultipartUpload('test-key', 'test-upload-id', [
      { PartNumber: 1, ETag: 'etag1' },
    ]);

    expect(s3ClientMock.send).toHaveBeenCalledTimes(1);
    expect(CompleteMultipartUploadCommand).toHaveBeenCalledWith({
      Bucket: 'streamtube-videos',
      Key: 'test-key',
      UploadId: 'test-upload-id',
      MultipartUpload: {
        Parts: [{ PartNumber: 1, ETag: 'etag1' }],
      },
    });
  });

  it('should abort multipart upload', async () => {
    (s3ClientMock.send as jest.Mock).mockResolvedValueOnce({} as any);

    await service.abortMultipartUpload('test-key', 'test-upload-id');

    expect(s3ClientMock.send).toHaveBeenCalledTimes(1);
    expect(AbortMultipartUploadCommand).toHaveBeenCalledWith({
      Bucket: 'streamtube-videos',
      Key: 'test-key',
      UploadId: 'test-upload-id',
    });
  });

  it('should generate presigned download URL', async () => {
    (getSignedUrl as jest.Mock).mockResolvedValue('http://download-url');

    const url = await service.getPresignedDownloadUrl('test-key', {
      responseContentDisposition: 'attachment; filename="test.mp4"',
      expiresIn: 3600,
    });

    expect(url).toBe('http://download-url');
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
    expect(GetObjectCommand).toHaveBeenCalledWith({
      Bucket: 'streamtube-videos',
      Key: 'test-key',
      ResponseContentDisposition: 'attachment; filename="test.mp4"',
    });
    expect((getSignedUrl as jest.Mock).mock.calls[0][2]).toEqual({
      expiresIn: 3600,
    });
  });

  describe('downloadFile', () => {
    it('should throw an error if body is missing', async () => {
      (s3ClientMock.send as jest.Mock).mockResolvedValueOnce({} as any);
      await expect(
        service.downloadFile('test-key', '/tmp/file.mp4'),
      ).rejects.toThrow('File not found: test-key');
    });
  });

  describe('uploadFile', () => {
    let statSpy: jest.SpyInstance;
    let createReadStreamSpy: jest.SpyInstance;
    let mockStream: any;

    beforeEach(() => {
      statSpy = jest.spyOn(fs.promises, 'stat').mockResolvedValue({ size: 100 } as any);
      
      // Criamos um mock de stream que suporta handlers de eventos reais (como 'on')
      mockStream = {
        handlers: {},
        on(event: string, callback: any) {
          this.handlers[event] = callback;
        },
        emit(event: string, ...args: any[]) {
          if (this.handlers[event]) {
            this.handlers[event](...args);
          }
        },
      };

      createReadStreamSpy = jest.spyOn(fs, 'createReadStream').mockReturnValue(mockStream);
    });

    afterEach(() => {
      statSpy.mockRestore();
      createReadStreamSpy.mockRestore();
    });

    it('should resolve when s3Client.send resolves without stream errors', async () => {
      (s3ClientMock.send as jest.Mock).mockResolvedValueOnce({});
      await expect(
        service.uploadFile('test-key', '/tmp/file.mp4', 'video/mp4')
      ).resolves.toBeUndefined();
      
      expect(s3ClientMock.send).toHaveBeenCalled();
    });

    it('should reject when fileStream emits an error during transmission', async () => {
      // Mock s3Client.send para retornar uma promise que nunca resolve (pendente),
      // simulando um upload em progresso lento.
      (s3ClientMock.send as jest.Mock).mockImplementationOnce(() => new Promise(() => {}));

      const uploadPromise = service.uploadFile('test-key', '/tmp/file.mp4', 'video/mp4');

      // Aguarda a promise do `fsp.stat` resolver para que a stream seja criada e o listener
      // .on('error') seja devidamente atachado antes de emitirmos o erro.
      await new Promise(resolve => setTimeout(resolve, 0));

      // Simulamos um erro assíncrono emitido pelo stream (ex: erro de leitura no disco)
      const streamError = new Error('Disk read error during stream');
      mockStream.emit('error', streamError);

      await expect(uploadPromise).rejects.toThrow('Disk read error during stream');
    });

    it('should reject when s3Client.send rejects', async () => {
      const s3Error = new Error('S3 Upload Failed');
      (s3ClientMock.send as jest.Mock).mockRejectedValueOnce(s3Error);

      await expect(
        service.uploadFile('test-key', '/tmp/file.mp4', 'video/mp4')
      ).rejects.toThrow('S3 Upload Failed');
    });
  });
});
