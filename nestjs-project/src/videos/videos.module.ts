import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Video } from './entities/video.entity';
import { StorageModule } from '../storage/storage.module';
import { ChannelsModule } from '../channels/channels.module';
import { VideoProcessingQueueModule } from '../queue/video-processing-queue.module';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    StorageModule,
    ChannelsModule,
    VideoProcessingQueueModule,
  ],
  providers: [VideosService],
  exports: [VideosService],
})
export class VideosModule {}
