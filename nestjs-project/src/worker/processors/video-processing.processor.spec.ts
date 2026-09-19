import { Test, TestingModule } from '@nestjs/testing';
import { VideoProcessingProcessor } from './video-processing.processor';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Video } from '../../videos/entities/video.entity';
import { StorageService } from '../../storage/storage.service';
import { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import * as fs from 'fs/promises';

jest.mock('fs/promises');
jest.mock('fluent-ffmpeg', () => {
  return {
    ffprobe: jest.fn((path, cb) => {
      if (path.includes('error')) {
        return cb(new Error('ffprobe error'));
      }
      cb(null, {
        format: { duration: 120 },
        streams: [{ codec_type: 'video', width: 1920, height: 1080 }],
      });
    }),
  };
});

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;
  let videosRepository: any;
  let storageService: any;

  beforeEach(async () => {
    videosRepository = {
      findOneBy: jest.fn(),
      update: jest.fn(),
    };

    storageService = {
      downloadFile: jest.fn(),
      uploadFile: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        {
          provide: getRepositoryToken(Video),
          useValue: videosRepository,
        },
        {
          provide: StorageService,
          useValue: storageService,
        },
      ],
    }).compile();

    processor = module.get<VideoProcessingProcessor>(VideoProcessingProcessor);

    jest.spyOn(processor as any, 'generateThumbnail').mockResolvedValue(undefined);
    jest.spyOn(processor as any, 'convertToFaststart').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should process video successfully', async () => {
    const job = {
      data: { videoId: 'video-123', storageKey: 'uploads/video-123/original.mp4' },
    } as unknown as Job;

    videosRepository.findOneBy.mockResolvedValue({ id: 'video-123', status: 'draft' });

    await processor.process(job);

    expect(videosRepository.update).toHaveBeenCalledWith('video-123', { status: 'processing' });
    expect(storageService.downloadFile).toHaveBeenCalled();
    expect(storageService.uploadFile).toHaveBeenCalledTimes(2);
    expect(videosRepository.update).toHaveBeenCalledWith('video-123', expect.objectContaining({
      status: 'ready',
      duration: 120,
      width: 1920,
      height: 1080,
    }));
  });

  it('should skip processing if video is not in draft or processing status', async () => {
    const job = {
      data: { videoId: 'video-123', storageKey: 'uploads/video-123/original.mp4' },
    } as unknown as Job;

    videosRepository.findOneBy.mockResolvedValue({ id: 'video-123', status: 'ready' });

    await processor.process(job);

    expect(videosRepository.update).not.toHaveBeenCalled();
    expect(storageService.downloadFile).not.toHaveBeenCalled();
  });

  it('should throw UnrecoverableError and update status to error if video processing (ffprobe) fails', async () => {
    const job = {
      data: { videoId: 'error', storageKey: 'uploads/error/original.mp4' },
    } as unknown as Job;

    videosRepository.findOneBy.mockResolvedValue({ id: 'error', status: 'draft' });

    await expect(processor.process(job)).rejects.toThrow(UnrecoverableError);

    expect(videosRepository.update).toHaveBeenCalledWith('error', expect.objectContaining({
      status: 'error',
      errorLog: expect.any(String),
    }));
  });

  it('should throw standard Error and NOT update status to error if infra/storage fails', async () => {
    const job = {
      data: { videoId: 'video-123', storageKey: 'uploads/video-123/original.mp4' },
    } as unknown as Job;

    videosRepository.findOneBy.mockResolvedValue({ id: 'video-123', status: 'draft' });
    
    storageService.downloadFile.mockRejectedValueOnce(new Error('S3 Connection Timeout'));

    await expect(processor.process(job)).rejects.toThrow('S3 Connection Timeout');

    // Should NOT have updated to error
    expect(videosRepository.update).not.toHaveBeenCalledWith('video-123', expect.objectContaining({
      status: 'error'
    }));

    // Should only have been called to update to 'processing'
    expect(videosRepository.update).toHaveBeenCalledTimes(1);
    expect(videosRepository.update).toHaveBeenCalledWith('video-123', { status: 'processing' });
  });

  it('should throw standard Error and NOT update status to error if uploadFile fails', async () => {
    const job = {
      data: { videoId: 'video-upload-fail', storageKey: 'uploads/video-upload-fail/original.mp4' },
    } as unknown as Job;

    videosRepository.findOneBy.mockResolvedValue({ id: 'video-upload-fail', status: 'processing' });
    
    // Simulate the upload of the thumbnail or faststart failing
    storageService.uploadFile.mockRejectedValueOnce(new Error('S3 Upload Timeout'));

    await expect(processor.process(job)).rejects.toThrow('S3 Upload Timeout');

    // Should NOT have updated to error
    expect(videosRepository.update).not.toHaveBeenCalledWith('video-upload-fail', expect.objectContaining({
      status: 'error'
    }));

    // Should NOT have updated to ready
    expect(videosRepository.update).not.toHaveBeenCalledWith('video-upload-fail', expect.objectContaining({
      status: 'ready'
    }));

    // Should only have been called to update to 'processing'
    expect(videosRepository.update).toHaveBeenCalledTimes(1);
    expect(videosRepository.update).toHaveBeenCalledWith('video-upload-fail', { status: 'processing' });
  });
});
