import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VideosModule } from './videos.module';
import { Video } from './entities/video.entity';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import queueConfig from '../config/queue.config';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosModule', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();
  });

  afterEach(async () => {
    if (module) await module.close();
  });

  it('should compile the module and resolve TypeOrmModule wiring', () => {
    expect(module).toBeDefined();
    expect(module.get(VideosModule)).toBeInstanceOf(VideosModule);
  });
});
