# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 3/8 completed

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
- **Status:** pending
- **Tests:** pending
- **Observations:** pending

### SI-03.5 — Video Processing Processor (FFmpeg Worker Logic)
- **Status:** pending
- **Tests:** pending
- **Observations:** pending

### SI-03.6 — Videos Service (Upload, Multipart Initiation & Completion)
- **Status:** pending
- **Tests:** pending
- **Observations:** pending

### SI-03.7 — Video Query Service (Public Lookup, Streaming & Download URL Generation)
- **Status:** pending
- **Tests:** pending
- **Observations:** pending

### SI-03.8 — Videos Controller (API Endpoints & Routing)
- **Status:** pending
- **Tests:** pending
- **Observations:** pending
