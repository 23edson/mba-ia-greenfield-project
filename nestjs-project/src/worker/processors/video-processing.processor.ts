import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Video, VideoStatus } from '../../videos/entities/video.entity';
import { StorageService } from '../../storage/storage.service';
import ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs/promises';
import * as path from 'path';

interface VideoProcessingPayload {
  videoId: string;
  storageKey: string;
}

@Injectable()
@Processor('video-processing', { concurrency: 1 })
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);
  private readonly tmpDir = '/tmp/video-jobs';

  constructor(
    @InjectRepository(Video)
    private readonly videosRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessingPayload, void, string>): Promise<void> {
    const { videoId, storageKey } = job.data;
    this.logger.log(`Starting processing for video ${videoId}`);

    const video = await this.videosRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new UnrecoverableError(`Video ${videoId} not found`);
    }

    if (
      video.status !== VideoStatus.DRAFT &&
      video.status !== VideoStatus.PROCESSING
    ) {
      this.logger.warn(
        `Video ${videoId} is in status ${video.status}, ignoring`,
      );
      return;
    }

    await this.videosRepository.update(videoId, {
      status: VideoStatus.PROCESSING,
    });

    // ensure tmp dir
    await fs.mkdir(this.tmpDir, { recursive: true });

    const rawPath = path.join(this.tmpDir, `${videoId}-raw.mp4`);
    const thumbPath = path.join(this.tmpDir, `${videoId}-thumb.jpg`);
    const faststartPath = path.join(this.tmpDir, `${videoId}-faststart.mp4`);

    try {
      this.logger.debug(`Downloading ${storageKey} to ${rawPath}`);
      await this.storageService.downloadFile(storageKey, rawPath);

      let metadata;
      try {
        this.logger.debug(`Extracting metadata for ${videoId}`);
        metadata = await this.getMetadata(rawPath);

        this.logger.debug(`Generating thumbnail for ${videoId}`);
        await this.generateThumbnail(rawPath, thumbPath, metadata.duration);

        this.logger.debug(`Optimizing to faststart for ${videoId}`);
        await this.convertToFaststart(rawPath, faststartPath);
      } catch (videoErr: any) {
        this.logger.error(
          `Invalid video file ${videoId}: ${videoErr.message}`,
          videoErr.stack,
        );
        const errorLog = videoErr.stack || videoErr.message;
        await this.videosRepository.update(videoId, {
          status: VideoStatus.ERROR,
          errorLog,
        });
        throw new UnrecoverableError(`INVALID_VIDEO_FILE: ${videoErr.message}`);
      }

      this.logger.debug(`Uploading assets for ${videoId}`);
      const thumbnailKey = `uploads/${videoId}/thumbnail.jpg`;
      await this.storageService.uploadFile(
        thumbnailKey,
        thumbPath,
        'image/jpeg',
      );
      await this.storageService.uploadFile(
        storageKey,
        faststartPath,
        'video/mp4',
      );

      this.logger.debug(`Updating video status to ready for ${videoId}`);
      await this.videosRepository.update(videoId, {
        status: VideoStatus.READY,
        duration: metadata.duration,
        width: metadata.width,
        height: metadata.height,
        thumbnailKey,
      });

      this.logger.log(`Processing complete for video ${videoId}`);
    } catch (error: any) {
      if (error instanceof UnrecoverableError) {
        throw error;
      }
      this.logger.error(
        `Transient error processing video ${videoId}: ${error.message}`,
        error.stack,
      );
      throw error;
    } finally {
      // Cleanup
      for (const file of [rawPath, thumbPath, faststartPath]) {
        try {
          await fs.unlink(file);
        } catch (err: any) {
          if (err.code !== 'ENOENT') {
            this.logger.warn(
              `Failed to delete temp file ${file}: ${err.message}`,
            );
          }
        }
      }
    }
  }

  private getMetadata(
    filePath: string,
  ): Promise<{ duration: number; width: number; height: number }> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, data) => {
        if (err)
          return reject(err instanceof Error ? err : new Error(String(err)));

        const videoStream = data.streams.find((s) => s.codec_type === 'video');
        if (!videoStream) {
          return reject(new Error('No video stream found'));
        }

        resolve({
          duration: data.format.duration || 0,
          width: videoStream.width || 0,
          height: videoStream.height || 0,
        });
      });
    });
  }

  private generateThumbnail(
    inputPath: string,
    outputPath: string,
    duration: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .screenshots({
          timestamps: ['50%'],
          filename: path.basename(outputPath),
          folder: path.dirname(outputPath),
        })
        .on('end', () => resolve())
        .on('error', (err: any) =>
          reject(err instanceof Error ? err : new Error(String(err))),
        );
    });
  }

  private convertToFaststart(
    inputPath: string,
    outputPath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions(['-c copy', '-movflags +faststart'])
        .save(outputPath)
        .on('end', () => resolve())
        .on('error', (err: any) =>
          reject(err instanceof Error ? err : new Error(String(err))),
        );
    });
  }
}
