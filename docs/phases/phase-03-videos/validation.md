---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-08-29T17:20:35-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-29T17:19:47-03:00"
issues:
  - id: OQ-1
    status: resolved
    summary: "TD phase-03-videos/TD-01 pending — Queue Technology"
    resolved_by: "phase-03-videos/TD-01"
  - id: OQ-2
    status: resolved
    summary: "TD phase-03-videos/TD-02 pending — Large Video Upload Strategy (Up to 10 GB)"
    resolved_by: "phase-03-videos/TD-02"
  - id: OQ-3
    status: resolved
    summary: "TD phase-03-videos/TD-03 pending — Video Worker Execution Environment (FFmpeg)"
    resolved_by: "phase-03-videos/TD-03"
  - id: OQ-4
    status: resolved
    summary: "TD phase-03-videos/TD-04 pending — Video Streaming Strategy"
    resolved_by: "phase-03-videos/TD-04"
  - id: OQ-5
    status: resolved
    summary: "TD phase-03-videos/TD-05 pending — Public Video URL Identifier (Slug/ID)"
    resolved_by: "phase-03-videos/TD-05"
  - id: OQ-6
    status: resolved
    summary: "TD phase-03-videos/TD-06 pending — Video Status Lifecycle & Error/DLQ Strategy"
    resolved_by: "phase-03-videos/TD-06"
  - id: MD-1
    status: resolved
    summary: "Capability 'Serviço de armazenamento de arquivos' is uncovered"
    resolved_by: "phase-03-videos/TD-02"
  - id: MD-2
    status: resolved
    summary: "Capability 'Geração automática de thumbnail' is uncovered"
    resolved_by: "phase-03-videos/TD-03"
  - id: MD-3
    status: resolved
    summary: "Capability 'Download do vídeo pelo usuário' is uncovered"
    resolved_by: "phase-03-videos/TD-04"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — TD `phase-03-videos/TD-01` pending — Queue Technology. Resolved with Option A (BullMQ - Redis-backed). We will integrate BullMQ using `@nestjs/bullmq` in a separate worker. Redis will use AOF persistence to guarantee queue state recovery.
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — TD `phase-03-videos/TD-02` pending — Large Video Upload Strategy (Up to 10 GB). Resolved with Option A (S3 Presigned URLs Multipart). Uploads of up to 10 GB will bypass the NestJS API entirely, uploading directly to MinIO/S3 using 50 MB chunk sizes. Completed uploads are assembled on S3/MinIO via a complete endpoint in NestJS.
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — TD `phase-03-videos/TD-03` pending — Video Worker Execution Environment (FFmpeg). Resolved with Option B (Separate Container FFmpeg Worker). Heavy-duty processing (probing and transcoding) runs inside a dedicated NestJS worker container. The worker downloads raw bytes locally to ensure seekability, generates a thumbnail at 10% duration, optimizes output to Fast Start, and cleans up temporary paths guaranteed.
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — TD `phase-03-videos/TD-04` pending — Video Streaming Strategy. Resolved with Option D (Direct Object Storage Streaming with Presigned URL + HTTP Range). Direct presigned redirects pointing to S3/MinIO with standard range requests (206 partial content) for progressive streaming, bypassing NestJS proxying entirely. Progressive playback is enabled by the Fast Start moov atom placement.
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — TD `phase-03-videos/TD-05` pending — Public Video URL Identifier (Slug/ID). Resolved with Option B (NanoID). We separate internal secure identity (UUID v7 database primary key) from public identity (immutable 12-character unique NanoID URL slugs).
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — TD `phase-03-videos/TD-06` pending — Video Status Lifecycle & Error/DLQ Strategy. Resolved with Option C (Explicit Video State Machine + Idempotent Processing + Retry/Failed Job Handling). State machine progresses systematically (`draft -> processing -> ready/error`). Employs exponential backoff (3 attempts), automatic worker locking/idempotency checks, and preserves failed jobs inside BullMQ (DLQ) for administrative observability.
- **MD-1** _(resolved_by phase-03-videos/TD-02)_ — Capability 'Serviço de armazenamento de arquivos (vídeos e thumbnails)' is covered by decided TD phase-03-videos/TD-02.
- **MD-2** _(resolved_by phase-03-videos/TD-03)_ — Capability 'Geração automática de thumbnail a partir de um frame do vídeo' is covered by decided TD phase-03-videos/TD-03.
- **MD-3** _(resolved_by phase-03-videos/TD-04)_ — Capability 'Download do vídeo pelo usuário' is covered by decided TD phase-03-videos/TD-04.
