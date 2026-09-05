import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { VideoProcessingQueueModule } from './video-processing-queue.module';
import queueConfig from '../config/queue.config';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

describe('VideoProcessingQueueModule', () => {
  let queue: Queue;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig],
        }),
        VideoProcessingQueueModule,
      ],
    }).compile();

    queue = module.get<Queue>(getQueueToken('video-processing'));
  });

  afterEach(async () => {
    await queue.close();
  });

  it('should be defined', () => {
    expect(queue).toBeDefined();
    expect(queue.name).toBe('video-processing');
  });
});
