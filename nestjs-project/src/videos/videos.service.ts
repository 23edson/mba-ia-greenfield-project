import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Video, VideoStatus } from './entities/video.entity';
import { Channel } from '../channels/entities/channel.entity';
import { CreateVideoDto } from './dto/create-video.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { StorageService } from '../storage/storage.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { customAlphabet } from 'nanoid';
import {
  ChannelNotFoundException,
  ForbiddenException,
  VideoNotFoundException,
  VideoNotInDraftException,
} from '../common/exceptions/domain.exception';

const UNAMBIGUOUS_ALPHABET =
  '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const generateNanoId = customAlphabet(UNAMBIGUOUS_ALPHABET, 12);

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private videosRepository: Repository<Video>,
    @InjectRepository(Channel)
    private channelsRepository: Repository<Channel>,
    private storageService: StorageService,
    @InjectQueue('video-processing')
    private videoProcessingQueue: Queue,
  ) {}

  async createDraft(userId: string, dto: CreateVideoDto) {
    const channel = await this.channelsRepository.findOne({
      where: { user_id: userId },
    });

    if (!channel) {
      throw new ChannelNotFoundException();
    }

    let publicId = generateNanoId();
    let isUnique = false;
    let attempts = 0;

    while (!isUnique && attempts < 5) {
      const existing = await this.videosRepository.findOne({
        where: { publicId },
      });
      if (!existing) {
        isUnique = true;
      } else {
        publicId = generateNanoId();
        attempts++;
      }
    }

    if (!isUnique) {
      throw new Error('Failed to generate unique publicId');
    }

    // Prepare video entity
    const video = this.videosRepository.create({
      title: dto.title,
      description: dto.description,
      status: VideoStatus.DRAFT,
      channelId: channel.id,
      publicId,
      sizeInBytes: dto.sizeInBytes,
      storageKey: '', // Placeholder, will update after getting ID
    });

    // Save to get the generated ID
    const savedVideo = await this.videosRepository.save(video);

    // Update storageKey with real ID
    const storageKey = `uploads/${savedVideo.id}/original.mp4`;
    savedVideo.storageKey = storageKey;

    const CHUNK_SIZE = 50 * 1024 * 1024;
    const partCount = Math.max(1, Math.ceil(dto.sizeInBytes / CHUNK_SIZE));

    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      'video/mp4',
    );

    savedVideo.uploadId = uploadId;
    await this.videosRepository.save(savedVideo);

    const partUrls = await this.storageService.getPresignedPartUrls(
      storageKey,
      uploadId,
      partCount,
    );

    return {
      id: savedVideo.id,
      publicId: savedVideo.publicId,
      status: savedVideo.status,
      uploadId,
      partUrls,
    };
  }

  async completeUpload(
    videoId: string,
    userId: string,
    dto: CompleteUploadDto,
  ) {
    const video = await this.videosRepository.findOne({
      where: { id: videoId },
      relations: ['channel'],
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    if (video.channel.user_id !== userId) {
      throw new ForbiddenException();
    }

    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoNotInDraftException();
    }

    if (!video.uploadId) {
      throw new Error('Missing uploadId on drafted video');
    }

    // Complete multipart upload in S3
    await this.storageService.completeMultipartUpload(
      video.storageKey,
      video.uploadId,
      dto.parts,
    );

    // Update video status atomically
    await this.videosRepository.update(
      { id: video.id },
      { status: VideoStatus.PROCESSING },
    );

    // Refresh video for returning
    const updatedVideo = await this.videosRepository.findOne({
      where: { id: video.id },
    });

    // Enqueue job for processing
    await this.videoProcessingQueue.add(
      'process-video',
      { videoId: video.id, storageKey: video.storageKey },
      { jobId: video.id },
    );

    return {
      id: updatedVideo!.id,
      publicId: updatedVideo!.publicId,
      status: updatedVideo!.status,
    };
  }
}
