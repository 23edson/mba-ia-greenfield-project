import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { User } from '../src/users/entities/user.entity';
import { VerificationToken } from '../src/auth/entities/verification-token.entity';
import { RefreshToken } from '../src/auth/entities/refresh-token.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { AuthService } from '../src/auth/auth.service';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let channelsRepository: Repository<Channel>;
  let videosRepository: Repository<Video>;
  let usersRepository: Repository<User>;
  let jwtService: JwtService;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    channelsRepository = dataSource.getRepository(Channel);
    videosRepository = dataSource.getRepository(Video);
    usersRepository = dataSource.getRepository(User);
    jwtService = moduleFixture.get(JwtService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  let counter = 0;
  async function createUserAndLogin(
    email = `user_${Date.now()}_${++counter}@example.com`,
  ) {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123' });

    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' });

    const accessToken = res.body.access_token;
    if (!accessToken)
      throw new Error('Failed to login, response: ' + JSON.stringify(res.body));

    const payload = jwtService.decode(accessToken);
    const userId = payload.sub;

    return { accessToken, userId };
  }

  describe('POST /videos', () => {
    it('returns 201 with valid payload', async () => {
      const { accessToken } = await createUserAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'My First Video',
          description: 'Description',
          fileName: 'video.mp4',
          sizeInBytes: 1048576,
        })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.publicId).toBeDefined();
      expect(res.body.status).toBe('draft');
      expect(res.body.uploadId).toBeDefined();
      expect(Array.isArray(res.body.partUrls)).toBe(true);
    });

    it('returns 401 without token', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({
          title: 'My First Video',
          fileName: 'video.mp4',
          sizeInBytes: 1048576,
        })
        .expect(401);
    });

    it('returns 400 on invalid payload', async () => {
      const { accessToken } = await createUserAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: '',
        })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 403 CHANNEL_NOT_FOUND if user has no channel', async () => {
      const { accessToken, userId } = await createUserAndLogin();
      await channelsRepository.delete({ user_id: userId });

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'My First Video',
          fileName: 'video.mp4',
          sizeInBytes: 1048576,
        })
        .expect(403);

      expect(res.body.error).toBe('CHANNEL_NOT_FOUND');
    });
  });

  describe('POST /videos/:id/upload/complete', () => {
    it('returns 200 with valid parts', async () => {
      const { accessToken } = await createUserAndLogin();

      const draftRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'Draft Video',
          fileName: 'video.mp4',
          sizeInBytes: 12,
        });

      const { id, partUrls } = draftRes.body;
      const partUrl = partUrls[0];

      const uploadRes = await fetch(partUrl, {
        method: 'PUT',
        body: 'hello world!',
      });
      const etag = uploadRes.headers.get('etag');
      expect(etag).toBeDefined();

      const completeRes = await request(app.getHttpServer())
        .post(`/videos/${id}/upload/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          parts: [{ PartNumber: 1, ETag: etag }],
        })
        .expect(200);

      expect(completeRes.body.status).toBe('processing');
    });

    it('returns 401 without token', async () => {
      await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000000/upload/complete')
        .send({
          parts: [{ PartNumber: 1, ETag: 'fake' }],
        })
        .expect(401);
    });

    it('returns 403 FORBIDDEN if different user', async () => {
      const user1 = await createUserAndLogin('user1@example.com');
      const user2 = await createUserAndLogin('user2@example.com');

      const draftRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({
          title: 'Draft Video',
          fileName: 'video.mp4',
          sizeInBytes: 12,
        });

      const { id } = draftRes.body;

      const res = await request(app.getHttpServer())
        .post(`/videos/${id}/upload/complete`)
        .set('Authorization', `Bearer ${user2.accessToken}`)
        .send({
          parts: [{ PartNumber: 1, ETag: 'fake' }],
        })
        .expect(403);
      expect(res.body.error).toBe('FORBIDDEN');
    });

    it('returns 404 VIDEO_NOT_FOUND', async () => {
      const { accessToken } = await createUserAndLogin();

      const fakeId = '00000000-0000-0000-0000-000000000000';
      const res = await request(app.getHttpServer())
        .post(`/videos/${fakeId}/upload/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          parts: [{ PartNumber: 1, ETag: 'fake' }],
        })
        .expect(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 409 VIDEO_NOT_IN_DRAFT', async () => {
      const { accessToken, userId } = await createUserAndLogin();
      const channel = await channelsRepository.findOneBy({ user_id: userId });

      const video = await videosRepository.save(
        videosRepository.create({
          title: 'Ready video',
          publicId: 'readyvideo12',
          channelId: channel!.id,
          status: VideoStatus.READY,
          storageKey: 'fake.mp4',
        }),
      );

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.id}/upload/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          parts: [{ PartNumber: 1, ETag: 'fake' }],
        })
        .expect(409);
      expect(res.body.error).toBe('VIDEO_NOT_IN_DRAFT');
    });

    it('returns 400 with invalid parts', async () => {
      const { accessToken } = await createUserAndLogin();

      const res = await request(app.getHttpServer())
        .post(`/videos/00000000-0000-0000-0000-000000000000/upload/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          parts: [],
        })
        .expect(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /videos/:publicId', () => {
    it('returns 200 with metadata', async () => {
      const { userId } = await createUserAndLogin();
      const channel = await channelsRepository.findOneBy({ user_id: userId });

      const video = await videosRepository.save(
        videosRepository.create({
          title: 'Public Video',
          publicId: 'pub123456789',
          channelId: channel!.id,
          status: VideoStatus.READY,
          storageKey: 'fake.mp4',
        }),
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.publicId}`)
        .expect(200);

      expect(res.body.id).toBe(video.id);
      expect(res.body.title).toBe('Public Video');
    });

    it('returns 404 VIDEO_NOT_FOUND', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/missing12345')
        .expect(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:publicId/stream', () => {
    it('returns 302 with Location to presigned URL', async () => {
      const { userId } = await createUserAndLogin();
      const channel = await channelsRepository.findOneBy({ user_id: userId });

      const video = await videosRepository.save(
        videosRepository.create({
          title: 'Public Video',
          publicId: 'stream123456',
          channelId: channel!.id,
          status: VideoStatus.READY,
          storageKey: 'fake.mp4',
        }),
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.publicId}/stream`)
        .expect(302);

      expect(res.header.location).toContain('fake.mp4');
    });

    it('returns 404 VIDEO_NOT_FOUND', async () => {
      await request(app.getHttpServer())
        .get('/videos/missing12345/stream')
        .expect(404);
    });

    it('returns 409 VIDEO_NOT_READY', async () => {
      const { userId } = await createUserAndLogin();
      const channel = await channelsRepository.findOneBy({ user_id: userId });

      const video = await videosRepository.save(
        videosRepository.create({
          title: 'Draft Video',
          publicId: 'draft1234567',
          channelId: channel!.id,
          status: VideoStatus.DRAFT,
          storageKey: 'fake.mp4',
        }),
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.publicId}/stream`)
        .expect(409);
      expect(res.body.error).toBe('VIDEO_NOT_READY');
    });
  });

  describe('GET /videos/:publicId/download', () => {
    it('returns 302 with Location', async () => {
      const { userId } = await createUserAndLogin();
      const channel = await channelsRepository.findOneBy({ user_id: userId });

      const video = await videosRepository.save(
        videosRepository.create({
          title: 'Public Video',
          publicId: 'dl1234567890',
          channelId: channel!.id,
          status: VideoStatus.READY,
          storageKey: 'fake.mp4',
        }),
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.publicId}/download`)
        .expect(302);

      expect(res.header.location).toContain('fake.mp4');
      expect(res.header.location).toContain('response-content-disposition');
    });

    it('returns 404 VIDEO_NOT_FOUND', async () => {
      await request(app.getHttpServer())
        .get('/videos/missing12345/download')
        .expect(404);
    });

    it('returns 409 VIDEO_NOT_READY', async () => {
      const { userId } = await createUserAndLogin();
      const channel = await channelsRepository.findOneBy({ user_id: userId });

      const video = await videosRepository.save(
        videosRepository.create({
          title: 'Processing Video',
          publicId: 'proc12345678',
          channelId: channel!.id,
          status: VideoStatus.PROCESSING,
          storageKey: 'fake.mp4',
        }),
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.publicId}/download`)
        .expect(409);
      expect(res.body.error).toBe('VIDEO_NOT_READY');
    });
  });
});
