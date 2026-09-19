import { Injectable, Inject } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { pipeline } from 'stream/promises';

@Injectable()
export class StorageService {
  private s3Client: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private config: ConfigType<typeof storageConfig>,
  ) {
    if (!this.config.accessKey || !this.config.secretKey) {
      throw new Error(
        'Storage credentials (accessKey or secretKey) are missing. Check environment variables and Joi validation.',
      );
    }

    this.s3Client = new S3Client({
      endpoint: this.config.endpoint,
      region: this.config.region,
      credentials: {
        accessKeyId: this.config.accessKey,
        secretAccessKey: this.config.secretKey,
      },
      forcePathStyle: this.config.forcePathStyle,
    });
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const command = new CreateMultipartUploadCommand({
      Bucket: this.config.bucketName,
      Key: key,
      ContentType: contentType,
    });
    const result = await this.s3Client.send(command);
    return result.UploadId as string;
  }

  async getPresignedPartUrls(
    key: string,
    uploadId: string,
    partCount: number,
  ): Promise<string[]> {
    const urls: string[] = [];
    for (let i = 1; i <= partCount; i++) {
      const command = new UploadPartCommand({
        Bucket: this.config.bucketName,
        Key: key,
        UploadId: uploadId,
        PartNumber: i,
      });
      const url = await getSignedUrl(this.s3Client, command, {
        expiresIn: 7200,
      });
      urls.push(url);
    }
    return urls;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: { PartNumber: number; ETag: string }[],
  ): Promise<void> {
    const command = new CompleteMultipartUploadCommand({
      Bucket: this.config.bucketName,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts,
      },
    });
    await this.s3Client.send(command);
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const command = new AbortMultipartUploadCommand({
      Bucket: this.config.bucketName,
      Key: key,
      UploadId: uploadId,
    });
    await this.s3Client.send(command);
  }

  async getPresignedDownloadUrl(
    key: string,
    options?: { responseContentDisposition?: string; expiresIn?: number },
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.config.bucketName,
      Key: key,
      ResponseContentDisposition: options?.responseContentDisposition,
    });
    return getSignedUrl(this.s3Client, command, {
      expiresIn: options?.expiresIn || 7200,
    });
  }

  async downloadFile(key: string, localPath: string): Promise<void> {
    const command = new GetObjectCommand({
      Bucket: this.config.bucketName,
      Key: key,
    });
    const result = await this.s3Client.send(command);

    if (!result.Body) {
      throw new Error(`File not found: ${key}`);
    }

    await pipeline(result.Body as any, fs.createWriteStream(localPath));
  }

  async uploadFile(
    key: string,
    localPath: string,
    contentType: string,
  ): Promise<void> {
    const stat = await fsp.stat(localPath);
    const command = new PutObjectCommand({
      Bucket: this.config.bucketName,
      Key: key,
      Body: fs.createReadStream(localPath),
      ContentType: contentType,
      ContentLength: stat.size,
    });
    await this.s3Client.send(command);
  }
}
