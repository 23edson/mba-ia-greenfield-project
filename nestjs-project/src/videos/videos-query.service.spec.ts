import { Test, TestingModule } from '@nestjs/testing';
import { VideosService } from './videos.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Video } from './entities/video.entity';
import { Channel } from '../channels/entities/channel.entity';
import { getQueueToken } from '@nestjs/bullmq';
import { StorageService } from '../storage/storage.service';
import {
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';

describe('VideosService (Query)', () => {
  let service: VideosService;
  let videoRepository: any;
  let storageService: any;

  beforeEach(async () => {
    videoRepository = {
      findOne: jest.fn(),
    };
    storageService = {
      getPresignedDownloadUrl: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: getRepositoryToken(Channel), useValue: {} },
        { provide: getQueueToken('video-processing'), useValue: {} },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile();

    service = module.get<VideosService>(VideosService);
  });

  describe('findByPublicId', () => {
    it('should throw VideoNotFoundException if video does not exist', async () => {
      videoRepository.findOne.mockResolvedValue(null);
      await expect(service.findByPublicId('invalid-id')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('should return video metadata with thumbnail url', async () => {
      const mockVideo = {
        id: 'uuid',
        publicId: 'pub123',
        title: 'Title',
        description: 'Desc',
        status: 'ready',
        duration: 120,
        width: 1920,
        height: 1080,
        thumbnailKey: 'thumb.jpg',
        channelId: 'chan-123',
        createdAt: new Date('2023-01-01T00:00:00Z'),
      };
      videoRepository.findOne.mockResolvedValue(mockVideo);
      storageService.getPresignedDownloadUrl.mockResolvedValue('https://thumb.url');

      const result = await service.findByPublicId('pub123');

      expect(result).toEqual({
        id: 'uuid',
        publicId: 'pub123',
        title: 'Title',
        description: 'Desc',
        status: 'ready',
        duration: 120,
        width: 1920,
        height: 1080,
        thumbnailUrl: 'https://thumb.url',
        channelId: 'chan-123',
        createdAt: '2023-01-01T00:00:00.000Z',
      });
      expect(storageService.getPresignedDownloadUrl).toHaveBeenCalledWith('thumb.jpg');
    });
  });

  describe('getStreamUrl', () => {
    it('should throw VideoNotReadyException if video is not ready', async () => {
      videoRepository.findOne.mockResolvedValue({ status: 'processing' });
      await expect(service.getStreamUrl('pub123')).rejects.toThrow(
        VideoNotReadyException,
      );
    });

    it('should return presigned url with 7200 expiry', async () => {
      videoRepository.findOne.mockResolvedValue({ status: 'ready', storageKey: 'video.mp4' });
      storageService.getPresignedDownloadUrl.mockResolvedValue('https://stream.url');
      const url = await service.getStreamUrl('pub123');
      expect(url).toBe('https://stream.url');
      expect(storageService.getPresignedDownloadUrl).toHaveBeenCalledWith('video.mp4', { expiresIn: 7200 });
    });
  });

  describe('getDownloadUrl', () => {
    it('should throw VideoNotFoundException if not found', async () => {
      videoRepository.findOne.mockResolvedValue(null);
      await expect(service.getDownloadUrl('pub123')).rejects.toThrow(VideoNotFoundException);
    });

    it('should return presigned url with content disposition', async () => {
      videoRepository.findOne.mockResolvedValue({ status: 'ready', storageKey: 'video.mp4', title: 'My Video!@#' });
      storageService.getPresignedDownloadUrl.mockResolvedValue('https://dl.url');
      const url = await service.getDownloadUrl('pub123');
      expect(url).toBe('https://dl.url');
      expect(storageService.getPresignedDownloadUrl).toHaveBeenCalledWith('video.mp4', { responseContentDisposition: 'attachment; filename="My_Video___.mp4"' });
    });
  });
});
