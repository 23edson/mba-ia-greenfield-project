import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `vid_user_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Video Channel',
        nickname: `vidchan_${userCounter}`,
        user_id: user.id,
      }),
    );
  }

  it('should enforce unique publicId constraint', async () => {
    const channel = await createChannel();

    await videoRepository.save(
      videoRepository.create({
        publicId: 'abc123def456',
        title: 'Video 1',
        storageKey: 'vid1.mp4',
        channelId: channel.id,
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          publicId: 'abc123def456',
          title: 'Video 2',
          storageKey: 'vid2.mp4',
          channelId: channel.id,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should set default status to draft upon creation', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create({
        publicId: 'abc123def457',
        title: 'Video Draft',
        storageKey: 'vid3.mp4',
        channelId: channel.id,
      }),
    );

    expect(video.status).toBe(VideoStatus.DRAFT);
  });

  it('should persist stack trace/error diagnostics in errorLog', async () => {
    const channel = await createChannel();
    const errorLog = 'Error: Stack trace... \n at SomeFile.ts:12:3';
    const video = await videoRepository.save(
      videoRepository.create({
        publicId: 'abc123def458',
        title: 'Video Error',
        status: VideoStatus.ERROR,
        storageKey: 'vid4.mp4',
        channelId: channel.id,
        errorLog,
      }),
    );

    const found = await videoRepository.findOneBy({ id: video.id });
    expect(found?.errorLog).toBe(errorLog);
  });

  it('should enforce channelId relation (ManyToOne)', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          publicId: 'abc123def459',
          title: 'Video Orphan',
          storageKey: 'vid5.mp4',
          channelId: '00000000-0000-0000-0000-000000000000', // non-existent channel
        }),
      ),
    ).rejects.toThrow();
  });
});
