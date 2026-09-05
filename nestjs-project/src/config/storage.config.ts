import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT,
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKey: process.env.STORAGE_ACCESS_KEY,
  secretKey: process.env.STORAGE_SECRET_KEY,
  bucketName: process.env.STORAGE_BUCKET_NAME || 'streamtube-videos',
  forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE !== 'false',
}));
