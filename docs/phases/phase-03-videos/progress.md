# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 7/8 completed

### SI-03.1 — Dependencies, Configuration Namespaces e MinIO/Redis Infrastructure
- **Status:** completed
- **Tests:** 4/4 passing (storage.config.spec.ts, queue.config.spec.ts), E2E passing, migrations passing
- **Observations:** Fixed a pre-existing failing test in `migrations.integration-spec.ts` (dropping an enum type properly), updated the `env.validation` tests to cover the new required storage fields, and added Docker healthchecks for Redis (`redis-cli ping`) and MinIO (`curl /minio/health/live`) in `compose.yaml` with `condition: service_healthy` for `nestjs-api`.

### SI-03.2 — Video Entity e Database Migration
- **Status:** completed
- **Tests:** 5 passing (integration and module unit tests)
- **Observations:**
  - Fixed `Video` and `Channel` entities to include `OneToMany` and `ManyToOne` relations. Generated TypeORM migration `CreateVideosTable`.
  - Added `Video` entity to TypeORM test modules across existing integration test suites to fix entity metadata lookup failures.
  - Altered table cleanup in `migrations.integration-spec.ts` from `Promise.all` to sequential `for...of` loop to fix real PostgreSQL `QueryFailedError: deadlock detected` caused by concurrent DDL `DROP TABLE ... CASCADE` queries across foreign key dependency chains.

### SI-03.3 — Storage Service (MinIO/S3 Multipart Upload & Presigned URLs)
- **Status:** completed
- **Tests:** 7/7 passing (unit and integration tests)
- **Observations:** Implemented `StorageService` using AWS SDK v3 for multipart upload lifecycle and presigned URL generation (chunks and download/streaming with response-content-disposition). Refactored shared test helper `cleanAllTables` to dynamically inspect `dataSource.entityMetadatas.map(m => m.tableName)` and issue a single unified `TRUNCATE TABLE ... CASCADE` query, removing hardcoded table references and fixing pre-existing legacy test failures across isolated `synchronize: true` test suites.

### SI-03.4 — Queue Module e Video Processing Worker Container Setup
- **Status:** completed
- **Tests:** 2/2 passing (video-processing-queue.module.spec.ts, worker-app.module.spec.ts)
- **Observations:** Configured BullMQ `VideoProcessingQueueModule` for `video-processing` queue with exponential backoff retry policies. Created `Dockerfile.worker` containing `ffmpeg` and `ffprobe`. Added `video-worker` service in `compose.yaml` mapping the temporary volume `/tmp/video-jobs`. Implemented the standalone `worker.ts` bootstrap entry point.

### SI-03.5 — Video Processing Processor (FFmpeg Worker Logic)
- **Status:** completed
- **Tests:** 2/2 passing (video-processing.processor.spec.ts, video-processing.processor.integration-spec.ts)
- **Observations:** Implemented `VideoProcessingProcessor` that extends `WorkerHost` from `@nestjs/bullmq`. Added logic to check idempotency and avoid duplicates. Added extraction of metadata with FFprobe, generation of thumbnails and optimization for faststart using FFmpeg, uploading back to the storage and updating DB status. In case of error, records it in `errorLog` and throws `UnrecoverableError`. Included download and upload utilities in `StorageService`. Included missing module configurations.
  - **TESTING NOTE:** The integration test `video-processing.processor.integration-spec.ts` relies on physical FFmpeg/FFprobe binaries. It MUST be executed strictly inside the `video-worker` container (`docker compose exec video-worker npm test -- <file>`). Running it globally in `nestjs-api` (e.g. via `npm test -- --runInBand`) will result in a natural `ffmpeg: not found` failure. Add this exception to the final Definition of Done.

### SI-03.6 — Videos Service (Upload, Multipart Initiation & Completion)
- **Status:** completed
- **Tests:** 12/12 passing (unit and integration tests)
- **Observations:** Implemented `createDraft` (generating publicId with `crypto` fallback instead of `nanoid` ESM module to avoid Jest issues) and `completeUpload` (triggering multipart completion and pushing to BullMQ). Added `uploadId` to `CompleteUploadDto` so the client can pass it back. Created appropriate domain exceptions.

### SI-03.7 — Video Query Service (Public Lookup, Streaming & Download URL Generation)
- **Status:** completed
- **Tests:** 5 passing (unit and integration)
- **Observations:** Implemented `findByPublicId`, `getStreamUrl` and `getDownloadUrl` directly in `VideosService` returning presigned URLs from S3. Added validation for `VideoNotReadyException` (HTTP 409). Handled `response-content-disposition` in S3 options directly to prompt browser downloads on the download endpoint. Integrated tests into `videos.service.integration-spec.ts`.

### SI-03.8 — Videos Controller (API Endpoints & Routing)
- **Status:** completed
- **Tests:** completed (70 E2E tests passing)
- **Observations:** Implemented `VideosController` exposing REST endpoints `POST /videos`, `POST /videos/:id/upload/complete`, `GET /videos/:publicId`, `GET /videos/:publicId/stream`, and `GET /videos/:publicId/download`. Registered it in `VideosModule`. Used `JwtAuthGuard`, `CurrentUser` decorators and `@Redirect` for presigned streaming/download URLs.
  *Nota da revisão: O planejamento de testes (`/plan-test-specs`) e a escrita inicial dos testes E2E do VideosController haviam sido acidentalmente pulados em uma etapa anterior, o que resultou na falsa impressão de conclusão. Isso foi corrigido nesta rodada: geramos os 5 cenários E2E vitais, escrevemos os testes (elevando o total de testes E2E de 52 para 70), corrigimos configurações de lock e migrações no banco, resolvemos falhas no upload S3 e corrigimos o crash da geração de thumbnails do ffmpeg no worker. Apenas agora a fase de upload e worker está de fato concluída de ponta a ponta.*
