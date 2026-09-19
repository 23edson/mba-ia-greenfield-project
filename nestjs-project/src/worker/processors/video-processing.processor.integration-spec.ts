import { Test, TestingModule } from '@nestjs/testing';
import { VideoProcessingProcessor } from './video-processing.processor';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Video } from '../../videos/entities/video.entity';
import { StorageService } from '../../storage/storage.service';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

describe('VideoProcessingProcessor (Integration)', () => {
  let processor: VideoProcessingProcessor;

  beforeAll(async () => {
    // Generate a real sample video for ffprobe to analyze
    await execAsync(
      'ffmpeg -f lavfi -i color=c=black:s=128x72:d=1 -c:v libx264 -movflags +faststart /tmp/sample.mp4 -y',
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        { provide: getRepositoryToken(Video), useValue: {} },
        { provide: StorageService, useValue: {} },
      ],
    }).compile();

    processor = module.get<VideoProcessingProcessor>(VideoProcessingProcessor);
  });

  it('should extract metadata using real ffprobe', async () => {
    const samplePath = '/tmp/sample.mp4';
    const metadata = await (processor as any).getMetadata(samplePath);

    expect(metadata.duration).toBeCloseTo(1.0, 1);
    expect(metadata.width).toBe(128);
    expect(metadata.height).toBe(72);
  });
});
