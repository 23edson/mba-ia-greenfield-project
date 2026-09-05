import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideosTable1788640992431 implements MigrationInterface {
  name = 'CreateVideosTable1788640992431';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('draft', 'processing', 'ready', 'error')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "publicId" character varying(12) NOT NULL, "title" character varying(255) NOT NULL, "description" text, "status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft', "storageKey" character varying(512) NOT NULL, "thumbnailKey" character varying(512), "duration" double precision, "width" integer, "height" integer, "sizeInBytes" bigint, "errorLog" text, "channelId" uuid NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_876dde2e0803c9a46eac565fc5e" UNIQUE ("publicId"), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_876dde2e0803c9a46eac565fc5" ON "videos" ("publicId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ece1558efc6efd53eb530479db" ON "videos" ("status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_16909a0ae1ace805503fe874dd" ON "videos" ("channelId") `,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_16909a0ae1ace805503fe874dde" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_16909a0ae1ace805503fe874dde"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_16909a0ae1ace805503fe874dd"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_ece1558efc6efd53eb530479db"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_876dde2e0803c9a46eac565fc5"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
  }
}
