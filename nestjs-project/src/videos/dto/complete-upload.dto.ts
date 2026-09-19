import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsNumber,
  IsString,
  ValidateNested,
} from 'class-validator';

export class PartDto {
  @IsNumber()
  PartNumber: number;

  @IsString()
  ETag: string;
}

export class CompleteUploadDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => PartDto)
  parts: PartDto[];
}
