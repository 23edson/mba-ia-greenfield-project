import { NestFactory } from '@nestjs/core';
import { WorkerAppModule } from '../src/worker/worker-app.module';
import { StorageService } from '../src/storage/storage.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { Channel } from '../src/channels/entities/channel.entity';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import * as fs from 'fs/promises';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerAppModule);
  const storageService = app.get(StorageService);
  const videoRepo = app.get(getRepositoryToken(Video));
  const channelRepo = app.get(getRepositoryToken(Channel));
  // We need to inject the queue. Let's just create a bullmq queue manually
  const queue = new Queue('video-processing', {
    connection: { host: 'redis', port: 6379 },
  });

  console.log('Creating channel...');
  const channel = await channelRepo.save({
    name: 'test channel',
    nickname: '@testchannel',
    description: '',
    userId: '11111111-1111-1111-1111-111111111111',
  });

  console.log('Creating video...');
  const video = await videoRepo.save({
    title: 'Test Video',
    publicId: 'testvid12345',
    status: VideoStatus.PROCESSING,
    storageKey: 'uploads/testvid12345/original.mp4',
    channelId: channel.id,
  });

  console.log('Uploading sample video to MinIO...');
  await storageService.uploadFile(
    video.storageKey,
    '/tmp/sample.mp4',
    'video/mp4',
  );

  console.log('Enqueuing job...');
  await queue.add(
    'process',
    { videoId: video.id, storageKey: video.storageKey },
    { jobId: video.id },
  );

  console.log('Done enqueuing. Waiting 10s for worker to process...');
  await new Promise((r) => setTimeout(r, 10000));

  console.log('Checking DB...');
  const updatedVideo = await videoRepo.findOneBy({ id: video.id });
  console.log('Final DB Record:', updatedVideo);

  await app.close();
}

bootstrap().catch(console.error);
