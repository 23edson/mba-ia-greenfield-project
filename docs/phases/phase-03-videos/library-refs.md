---
libs:
  bullmq:
    id: "/taskforcesh/bullmq"
    query: "How to configure a BullMQ Queue and Worker with retries and exponential backoff in Node.js"
    version: "^5.x"
  "@nestjs/bullmq":
    id: "/nestjs/bull"
    query: "How to configure and use NestJS BullMQ module (Queue and Processor decorators)"
    version: "^11.x"
  ioredis:
    id: "/redis/ioredis"
    query: "ioredis connection options and AOF/Redis client configuration"
    version: "^5.x"
  "@aws-sdk/client-s3":
    id: "/aws/aws-sdk-js-v3"
    query: "AWS SDK v3 S3 multipart upload (CreateMultipartUpload, UploadPart, CompleteMultipartUpload) and generating presigned URLs"
    version: "^3.x"
  "@aws-sdk/s3-request-presigner":
    id: "/aws/aws-sdk-js-v3"
    query: "AWS SDK v3 S3 multipart upload (CreateMultipartUpload, UploadPart, CompleteMultipartUpload) and generating presigned URLs"
    version: "^3.x"
  fluent-ffmpeg:
    id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    query: "fluent-ffmpeg how to extract metadata (duration) via ffprobe and generate thumbnail image from frame"
    version: "^2.1.x"
  "@types/fluent-ffmpeg":
    id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    query: "fluent-ffmpeg TypeScript type declarations"
    version: "^2.1.x"
  nanoid:
    id: "/ai/nanoid"
    query: "How to generate a customized NanoID (12 characters, custom alphabet) in Node.js"
    version: "^5.x"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-29T17:19:47-03:00"
---

# Library Reference: phase-03-videos

This document serves as the technical reference guide containing exact code recipes, connection objects, and best-practice patterns for all libraries chosen in Phase 03.

---

### @nestjs/bullmq (Official NestJS Integration — Recommended Recipe)

The official NestJS integration module for BullMQ queues, workers, and lifecycle events.

#### 1. Queue Configuration Module (`video-processing-queue.module.ts`)
```typescript
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { VideoProcessingProcessor } from './video-processing.processor';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get<string>('REDIS_PASSWORD', undefined),
          maxRetriesPerRequest: null, // Required by BullMQ for blocking commands
        },
      }),
    }),
    BullModule.registerQueue({
      name: 'video-processing',
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 60000, // 1 minute initial backoff
        },
        removeOnComplete: true,
        removeOnFail: false, // Preserves failed jobs in Redis for DLQ inspection
      },
    }),
  ],
  providers: [VideoProcessingProcessor],
  exports: [BullModule],
})
export class VideoProcessingQueueModule {}
```

#### 2. Worker Processor (`video-processing.processor.ts`)
```typescript
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';

export interface VideoProcessingJobPayload {
  videoId: string;    // Internal UUID v7
  storageKey: string; // S3/MinIO original MP4 key
}

@Processor('video-processing', { concurrency: 1 })
@Injectable()
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  async process(job: Job<VideoProcessingJobPayload, any, string>): Promise<void> {
    const { videoId, storageKey } = job.data;
    this.logger.log(`Processing job ${job.id} for video ${videoId} (storage: ${storageKey})`);
    
    // Idempotency check -> state transition to 'processing' -> FFmpeg pipeline -> transition to 'ready'
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<VideoProcessingJobPayload>, error: Error) {
    this.logger.error(
      `Job ${job.id} (Video ${job.data?.videoId}) failed on attempt ${job.attemptsMade}: ${error.message}`,
      error.stack,
    );
  }
}
```

#### 3. Producer / Job Dispatching Service Example
```typescript
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { VideoProcessingJobPayload } from './video-processing.processor';

@Injectable()
export class VideoQueueService {
  constructor(
    @InjectQueue('video-processing')
    private readonly videoQueue: Queue<VideoProcessingJobPayload>,
  ) {}

  async enqueueVideoProcessing(videoId: string, storageKey: string) {
    return await this.videoQueue.add(
      'process',
      { videoId, storageKey },
      { jobId: videoId }, // Deduplication / idempotency key
    );
  }
}
```

---

### bullmq (Low-Level / Standalone API Reference)

> **Note**: Within the NestJS backend and worker services, all queue producer and consumer implementations MUST follow the `@nestjs/bullmq` pattern above. The direct `bullmq` primitives (`Queue`, `Worker`, `Job`) are referenced here solely for low-level typing, queue inspection, or testing utilities.

```typescript
import { Queue, Job } from 'bullmq';
import { VideoProcessingJobPayload } from './video-processing.processor';

// Direct queue reference for inspection or testing scripts:
export function createDirectQueueRef(host: string, port: number) {
  return new Queue<VideoProcessingJobPayload>('video-processing', {
    connection: {
      host,
      port,
      maxRetriesPerRequest: null, // Required by BullMQ for blocking commands
    },
  });
}
```

---

### ioredis

High-performance Redis client with support for Redis 7.2 AOF persistence and connection pooling.

```typescript
import Redis from 'ioredis';

export const redisConnection = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  maxRetriesPerRequest: null, // Required for BullMQ
  enableReadyCheck: false,
});
```

---

### @aws-sdk/client-s3

S3 client for MinIO / AWS S3 interaction, supporting multipart upload initiation, part assembly, and presigned streaming.

```typescript
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';

export const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  endpoint: process.env.MINIO_URL || 'http://localhost:9000',
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretAccessKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
  },
  forcePathStyle: true, // Required for MinIO
});

export async function initiateMultipart(bucket: string, key: string) {
  const command = new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    ContentType: 'video/mp4',
  });
  return await s3Client.send(command);
}

export async function completeMultipart(
  bucket: string,
  key: string,
  uploadId: string,
  parts: { PartNumber: number; ETag: string }[],
) {
  const command = new CompleteMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: {
      Parts: parts.sort((a, b) => a.PartNumber - b.PartNumber),
    },
  });
  return await s3Client.send(command);
}
```

---

### @aws-sdk/s3-request-presigner

Utility to create short-lived presigned URLs for client-side multipart part uploads and direct streaming/downloads.

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { UploadPartCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { s3Client } from './s3.client';

export async function getPresignedUploadPartUrl(
  bucket: string,
  key: string,
  uploadId: string,
  partNumber: number,
  expiresIn = 7200,
): Promise<string> {
  const command = new UploadPartCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  });
  return await getSignedUrl(s3Client, command, { expiresIn });
}

export async function getPresignedStreamUrl(
  bucket: string,
  key: string,
  expiresIn = 7200,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });
  return await getSignedUrl(s3Client, command, { expiresIn });
}

export async function getPresignedDownloadUrl(
  bucket: string,
  key: string,
  filename: string,
  expiresIn = 7200,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${filename}"`,
  });
  return await getSignedUrl(s3Client, command, { expiresIn });
}
```

---

### fluent-ffmpeg

Node.js abstraction layer over `ffmpeg` and `ffprobe` for media probing, thumbnail extraction at 10% duration, and FastStart MP4 encoding.

```typescript
import * as ffmpeg from 'fluent-ffmpeg';

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  format: string;
}

export function extractMetadata(filePath: string): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(new Error(`INVALID_VIDEO_FILE: ${err.message}`));
      const videoStream = metadata.streams.find((s) => s.codec_type === 'video');
      resolve({
        duration: metadata.format.duration || 0,
        width: videoStream?.width || 0,
        height: videoStream?.height || 0,
        format: metadata.format.format_name || 'unknown',
      });
    });
  });
}

export function generateThumbnail(
  inputPath: string,
  outputDir: string,
  durationSeconds: number,
): Promise<string> {
  const timestamp = durationSeconds > 5 ? durationSeconds * 0.1 : 1; // 10% duration
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .screenshots({
        timestamps: [timestamp],
        filename: 'thumbnail.jpg',
        folder: outputDir,
        size: '1280x720',
      })
      .on('end', () => resolve(`${outputDir}/thumbnail.jpg`))
      .on('error', (err) => reject(new Error(`Thumbnail generation failed: ${err.message}`)));
  });
}

export function transcodeFastStart(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        '-c:v libx264',
        '-profile:v main',
        '-level:v 4.0',
        '-c:a aac',
        '-movflags +faststart', // Essential for progressive stream seek
      ])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(new Error(`FFmpeg transcoding failed: ${err.message}`)))
      .run();
  });
}
```

---

### @types/fluent-ffmpeg

TypeScript type definitions for `fluent-ffmpeg`. Installed in `devDependencies` to provide full type checking for FFmpeg commands, screenshot options, and probe metadata structures.

```typescript
import { FfmpegCommand, FfprobeData } from 'fluent-ffmpeg';
```

---

### nanoid

Compact, URL-friendly, cryptographically secure unique string ID generator. Used for public video URLs (12 characters).
**Note**: Using version `^3.x` (3.3.19) instead of `^5.x` due to ESM compatibility issues with Jest/CommonJS in NestJS.

```typescript
import { customAlphabet } from 'nanoid';

// 56-character URL-friendly, visually unambiguous alphabet (omits 0, O, o, 1, I, l)
// Prevents human transcription/reading errors in public URLs
const UNAMBIGUOUS_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const generateNanoId = customAlphabet(UNAMBIGUOUS_ALPHABET, 12);

export function createPublicVideoId(): string {
  return generateNanoId(); // e.g. "x7G9mP24qRst" (~9.22 x 10^20 unique combinations)
}
```

