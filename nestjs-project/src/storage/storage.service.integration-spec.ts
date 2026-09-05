import { Test, TestingModule } from '@nestjs/testing';
import { StorageService } from './storage.service';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';

describe('StorageService (Integration)', () => {
  let service: StorageService;
  let s3Client: S3Client;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [storageConfig],
          ignoreEnvFile: false,
          isGlobal: true,
        }),
      ],
      providers: [StorageService],
    }).compile();

    service = module.get<StorageService>(StorageService);
    
    // Create bucket if not exists
    s3Client = new S3Client({
      endpoint: process.env.STORAGE_ENDPOINT || 'http://localhost:9000',
      region: process.env.STORAGE_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY || 'minioadmin',
        secretAccessKey: process.env.STORAGE_SECRET_KEY || 'minioadmin',
      },
      forcePathStyle: true,
    });

    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: 'streamtube-videos' }));
    } catch (e) {
      await s3Client.send(new CreateBucketCommand({ Bucket: 'streamtube-videos' }));
    }
  });

  it('should run a complete multipart upload lifecycle and get presigned URL', async () => {
    // 1. Create upload
    const key = `integration-test-${Date.now()}.txt`;
    const uploadId = await service.createMultipartUpload(key, 'text/plain');
    expect(uploadId).toBeDefined();

    // 2. Get part URLs
    const urls = await service.getPresignedPartUrls(key, uploadId, 1);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('X-Amz-Signature');

    // 3. Upload a part using fetch
    const partContent = 'Hello MinIO Multipart!';
    const response = await fetch(urls[0], {
      method: 'PUT',
      body: partContent,
    });
    expect(response.ok).toBe(true);
    const etag = response.headers.get('etag');
    expect(etag).toBeDefined();

    // 4. Complete upload
    await service.completeMultipartUpload(key, uploadId, [{ PartNumber: 1, ETag: etag as string }]);

    // 5. Get presigned download URL
    const downloadUrl = await service.getPresignedDownloadUrl(key, { responseContentDisposition: 'attachment; filename="test.txt"' });
    expect(downloadUrl).toContain('X-Amz-Signature');
    expect(downloadUrl).toContain('response-content-disposition=attachment');

    // 6. Download the part and verify content
    const downloadResponse = await fetch(downloadUrl);
    expect(downloadResponse.ok).toBe(true);
    const downloadedText = await downloadResponse.text();
    expect(downloadedText).toBe(partContent);
  });
});
