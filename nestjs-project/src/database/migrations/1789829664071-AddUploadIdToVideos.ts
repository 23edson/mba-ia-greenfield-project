import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUploadIdToVideos1789829664071 implements MigrationInterface {
  name = 'AddUploadIdToVideos1789829664071';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" ADD "uploadId" character varying(255)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "videos" DROP COLUMN "uploadId"`);
  }
}
