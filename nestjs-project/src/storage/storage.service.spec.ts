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
    let readFileSpy: jest.SpyInstance;
    beforeEach(() => {
      readFileSpy = jest
        .spyOn(fs.promises, 'readFile')
        .mockResolvedValue(Buffer.from('test') as any);
    });
    afterEach(() => {
      readFileSpy.mockRestore();
    });

    it('should call PutObjectCommand', async () => {
      (s3ClientMock.send as jest.Mock).mockResolvedValueOnce({} as any);
      await service.uploadFile('test-key', '/tmp/file.mp4', 'video/mp4');
      expect(s3ClientMock.send).toHaveBeenCalled();
    });
  });
});
