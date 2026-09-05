import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from './storage.config';

describe('StorageConfig', () => {
  let moduleRef: TestingModule;

  beforeEach(() => {
    process.env.STORAGE_ENDPOINT = 'http://localhost:9000';
    process.env.STORAGE_REGION = 'us-west-1';
    process.env.STORAGE_ACCESS_KEY = 'minioadmin';
    process.env.STORAGE_SECRET_KEY = 'minioadmin';
    process.env.STORAGE_BUCKET_NAME = 'my-bucket';
    process.env.STORAGE_FORCE_PATH_STYLE = 'true';
  });

  afterEach(() => {
    delete process.env.STORAGE_ENDPOINT;
    delete process.env.STORAGE_REGION;
    delete process.env.STORAGE_ACCESS_KEY;
    delete process.env.STORAGE_SECRET_KEY;
    delete process.env.STORAGE_BUCKET_NAME;
    delete process.env.STORAGE_FORCE_PATH_STYLE;
  });

  it('should return loaded configuration', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ load: [storageConfig] })],
    }).compile();

    const config = moduleRef.get('CONFIGURATION_TOKEN');
    // Using load from @nestjs/config provides values via ConfigService.
    // We can just invoke the factory to test the unit logic
    const configResult = storageConfig();

    expect(configResult).toEqual({
      endpoint: 'http://localhost:9000',
      region: 'us-west-1',
      accessKey: 'minioadmin',
      secretKey: 'minioadmin',
      bucketName: 'my-bucket',
      forcePathStyle: true,
    });
  });

  it('should use default values if env variables are not provided', () => {
    delete process.env.STORAGE_REGION;
    delete process.env.STORAGE_BUCKET_NAME;
    delete process.env.STORAGE_FORCE_PATH_STYLE;

    const configResult = storageConfig();

    expect(configResult.region).toBe('us-east-1');
    expect(configResult.bucketName).toBe('streamtube-videos');
    expect(configResult.forcePathStyle).toBe(true);
  });
});
