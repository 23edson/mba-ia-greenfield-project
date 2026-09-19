import { Test, TestingModule } from '@nestjs/testing';
import { VideosService } from './videos.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Video, VideoStatus } from './entities/video.entity';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { getQueueToken } from '@nestjs/bullmq';
import {
  ChannelNotFoundException,
  ForbiddenException,
  VideoNotFoundException,
  VideoNotInDraftException,
} from '../common/exceptions/domain.exception';

describe('VideosService', () => {
  let service: VideosService;
  let videosRepository: any;
  let channelsRepository: any;
  let storageService: any;
  let videoProcessingQueue: any;

  beforeEach(async () => {
    videosRepository = {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
    };
    channelsRepository = {
      findOne: jest.fn(),
    };
    storageService = {
      createMultipartUpload: jest.fn(),
      getPresignedPartUrls: jest.fn(),
      completeMultipartUpload: jest.fn(),
    };
    videoProcessingQueue = {
      add: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videosRepository },
        { provide: getRepositoryToken(Channel), useValue: channelsRepository },
        { provide: StorageService, useValue: storageService },
        {
          provide: getQueueToken('video-processing'),
          useValue: videoProcessingQueue,
        },
      ],
    }).compile();

    service = module.get<VideosService>(VideosService);
  });

  describe('createDraft', () => {
    it('throws ChannelNotFoundException if user has no channel', async () => {
      channelsRepository.findOne.mockResolvedValue(null);
      await expect(
        service.createDraft('user-1', {
          title: 'Title',
          fileName: 'video.mp4',
          sizeInBytes: 100,
        }),
      ).rejects.toThrow(ChannelNotFoundException);
    });

    it('creates draft and returns parts', async () => {
      channelsRepository.findOne.mockResolvedValue({ id: 'channel-1' });
      videosRepository.findOne.mockResolvedValueOnce(null); // publicId is unique
      videosRepository.create.mockReturnValue({ id: 'video-1' });

      videosRepository.save
        .mockResolvedValueOnce({
          id: 'video-1',
          publicId: 'abc',
          status: 'draft',
        })
        .mockResolvedValueOnce({
          id: 'video-1',
          publicId: 'abc',
          status: 'draft',
          storageKey: 'uploads/video-1/original.mp4',
        });

      storageService.createMultipartUpload.mockResolvedValue('upload-1');
      storageService.getPresignedPartUrls.mockResolvedValue(['url1']);

      const res = await service.createDraft('user-1', {
        title: 'Title',
        fileName: 'video.mp4',
        sizeInBytes: 100,
      });

      expect(res.id).toBe('video-1');
      expect(res.status).toBe('draft');
      expect(res.uploadId).toBe('upload-1');
      expect(res.partUrls).toEqual(['url1']);

      // Checking loop for publicId
      expect(videosRepository.findOne).toHaveBeenCalledTimes(1);
    });

    it('retries when publicId collides', async () => {
      channelsRepository.findOne.mockResolvedValue({ id: 'channel-1' });

      // Simulate collision then success
      videosRepository.findOne
        .mockResolvedValueOnce({ id: 'existing' })
        .mockResolvedValueOnce(null);

      videosRepository.create.mockReturnValue({ id: 'video-1' });
      videosRepository.save
        .mockResolvedValueOnce({ id: 'video-1' })
        .mockResolvedValueOnce({ id: 'video-1' });

      storageService.createMultipartUpload.mockResolvedValue('upload-1');
      storageService.getPresignedPartUrls.mockResolvedValue([]);

      await service.createDraft('user-1', {
        title: 'Title',
        fileName: 'video.mp4',
        sizeInBytes: 100,
      });

      expect(videosRepository.findOne).toHaveBeenCalledTimes(2);
    });
  });

  describe('completeUpload', () => {
    it('throws VideoNotFoundException if video missing', async () => {
      videosRepository.findOne.mockResolvedValue(null);
      await expect(
        service.completeUpload('video-1', 'user-1', { parts: [] }),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws ForbiddenException if not owner', async () => {
      videosRepository.findOne.mockResolvedValue({
        channel: { user_id: 'user-2' },
      });
      await expect(
        service.completeUpload('video-1', 'user-1', { parts: [] }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws VideoNotInDraftException if status is not draft', async () => {
      videosRepository.findOne.mockResolvedValue({
        channel: { user_id: 'user-1' },
        status: VideoStatus.PROCESSING,
      });
      await expect(
        service.completeUpload('video-1', 'user-1', { parts: [] }),
      ).rejects.toThrow(VideoNotInDraftException);
    });

    it('completes upload and dispatches job', async () => {
      videosRepository.findOne.mockResolvedValueOnce({
        id: 'video-1',
        storageKey: 'key1',
        status: VideoStatus.DRAFT,
        channel: { user_id: 'user-1' },
        uploadId: 'up-1',
      });
      videosRepository.findOne.mockResolvedValueOnce({
        id: 'video-1',
        publicId: 'abc',
        status: VideoStatus.PROCESSING,
      });

      const res = await service.completeUpload('video-1', 'user-1', {
        parts: [{ PartNumber: 1, ETag: 'etag' }],
      });

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'key1',
        'up-1',
        [{ PartNumber: 1, ETag: 'etag' }],
      );
      expect(videosRepository.update).toHaveBeenCalledWith(
        { id: 'video-1' },
        { status: VideoStatus.PROCESSING },
      );
      expect(videoProcessingQueue.add).toHaveBeenCalledWith(
        'process-video',
        { videoId: 'video-1', storageKey: 'key1' },
        { jobId: 'video-1' },
      );

      expect(res.status).toBe(VideoStatus.PROCESSING);
    });
  });
});
