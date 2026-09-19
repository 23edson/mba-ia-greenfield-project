import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { VideoProcessingQueueModule } from '../queue/video-processing-queue.module';

import { VideoProcessingProcessor } from './processors/video-processing.processor';
import { Video } from '../videos/entities/video.entity';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, queueConfig, storageConfig],
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature([Video, Channel, User]),
    StorageModule,
    VideoProcessingQueueModule,
  ],
  providers: [VideoProcessingProcessor],
})
export class WorkerAppModule {}
