import { DataSource, Repository } from 'typeorm';
import { Video, VideoStatus } from './entities/video.entity';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { VideosService } from './videos.service';
import {
  ChannelNotFoundException,
  ForbiddenException,
  VideoNotInDraftException,
} from '../common/exceptions/domain.exception';
import { TestingModule, Test } from '@nestjs/testing';
import { StorageService } from '../storage/storage.service';
import { getQueueToken } from '@nestjs/bullmq';
import { getRepositoryToken } from '@nestjs/typeorm';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let service: VideosService;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let userRepository: Repository<User>;
  let storageService: any;
  let videoProcessingQueue: any;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('test-upload-id'),
      getPresignedPartUrls: jest.fn().mockResolvedValue(['url1']),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };

    videoProcessingQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: getRepositoryToken(Channel), useValue: channelRepository },
        { provide: StorageService, useValue: storageService },
        {
          provide: getQueueToken('video-processing'),
          useValue: videoProcessingQueue,
        },
      ],
    }).compile();

    service = module.get<VideosService>(VideosService);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    jest.clearAllMocks();
  });

  let counter = 0;
  async function createChannelForUser(): Promise<{
    user: User;
    channel: Channel;
  }> {
    counter++;
    const user = await userRepository.save(
      userRepository.create({
        email: `vs_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `channel_${counter}`,
        nickname: `chan_${counter}`,
        user_id: user.id,
      }),
    );
    return { user, channel };
  }

  describe('createDraft', () => {
    it('persists a draft video in the database', async () => {
      const { user, channel } = await createChannelForUser();

      const result = await service.createDraft(user.id, {
        title: 'Test Video',
        fileName: 'test.mp4',
        sizeInBytes: 100 * 1024 * 1024,
      });

      expect(result.id).toBeDefined();
      expect(result.publicId).toBeDefined();
      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.uploadId).toBe('test-upload-id');

      const persisted = await videoRepository.findOneBy({ id: result.id });
      expect(persisted).not.toBeNull();
      expect(persisted!.title).toBe('Test Video');
      expect(persisted!.channelId).toBe(channel.id);
      expect(persisted!.storageKey).toBe(`uploads/${result.id}/original.mp4`);
      expect(persisted!.sizeInBytes).toBe('104857600');
    });

    it('fails if user has no channel', async () => {
      await expect(
        service.createDraft('00000000-0000-0000-0000-000000000000', {
          title: 'Test Video',
          fileName: 'test.mp4',
          sizeInBytes: 1024,
        }),
      ).rejects.toThrow(ChannelNotFoundException);
    });
  });

  describe('completeUpload', () => {
    it('completes the upload and updates status to processing', async () => {
      const { user, channel } = await createChannelForUser();

      const draft = await videoRepository.save(
        videoRepository.create({
          title: 'Draft',
          publicId: 'abc123xyz456',
          channelId: channel.id,
          sizeInBytes: 1024,
          storageKey: 'uploads/fake-id/original.mp4',
          status: VideoStatus.DRAFT,
          uploadId: 'test-upload',
        }),
      );

      const result = await service.completeUpload(draft.id, user.id, {
        parts: [{ PartNumber: 1, ETag: 'test-etag' }],
      });

      expect(result.status).toBe(VideoStatus.PROCESSING);

      const persisted = await videoRepository.findOneBy({ id: draft.id });
      expect(persisted!.status).toBe(VideoStatus.PROCESSING);

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'uploads/fake-id/original.mp4',
        'test-upload',
        [{ PartNumber: 1, ETag: 'test-etag' }],
      );
      expect(videoProcessingQueue.add).toHaveBeenCalledWith(
        'process-video',
        { videoId: draft.id, storageKey: 'uploads/fake-id/original.mp4' },
        { jobId: draft.id },
      );
    });

    it('prevents completion by a different user', async () => {
      const owner = await createChannelForUser();
      const other = await createChannelForUser();

      const draft = await videoRepository.save(
        videoRepository.create({
          title: 'Draft',
          publicId: 'abc123xyz457',
          channelId: owner.channel.id,
          sizeInBytes: 1024,
          storageKey: 'uploads/fake-id-2/original.mp4',
          status: VideoStatus.DRAFT,
          uploadId: 'test-upload',
        }),
      );

      await expect(
        service.completeUpload(draft.id, other.user.id, {
          parts: [],
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('prevents completion of non-draft videos', async () => {
      const { user, channel } = await createChannelForUser();

      const video = await videoRepository.save(
        videoRepository.create({
          title: 'Ready',
          publicId: 'abc123xyz458',
          channelId: channel.id,
          sizeInBytes: 1024,
          storageKey: 'uploads/fake-id-3/original.mp4',
          status: VideoStatus.READY,
          uploadId: 'test-upload',
        }),
      );

      await expect(
        service.completeUpload(video.id, user.id, {
          parts: [],
        }),
      ).rejects.toThrow(VideoNotInDraftException);
    });
  });
});
