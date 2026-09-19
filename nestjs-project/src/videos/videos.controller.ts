import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Redirect,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { VideosService } from './videos.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';

@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createDraft(
    @Body() dto: CreateVideoDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.videosService.createDraft(user.sub, dto);
  }

  @Post(':id/upload/complete')
  @HttpCode(HttpStatus.OK)
  async completeUpload(
    @Param('id') id: string,
    @Body() dto: CompleteUploadDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.videosService.completeUpload(id, user.sub, dto);
  }

  @Public()
  @Get(':publicId')
  @HttpCode(HttpStatus.OK)
  async getByPublicId(@Param('publicId') publicId: string) {
    return this.videosService.findByPublicId(publicId);
  }

  @Public()
  @Get(':publicId/stream')
  @Redirect()
  async getStreamUrl(@Param('publicId') publicId: string) {
    const url = await this.videosService.getStreamUrl(publicId);
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Public()
  @Get(':publicId/download')
  @Redirect()
  async getDownloadUrl(@Param('publicId') publicId: string) {
    const url = await this.videosService.getDownloadUrl(publicId);
    return { url, statusCode: HttpStatus.FOUND };
  }
}
