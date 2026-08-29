---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-08-29
scope_description: "Design decisions for video upload, queueing, worker execution, streaming, public identifiers, and lifecycle state transitions in Phase 03 of StreamTube."
---

# Technical Decisions — Phase 03: Video Upload and Processing

_Subprojects in scope:_

- `nestjs-project/` — Backend logic for uploads, video database entity, BullMQ integration, worker process management, and streaming APIs.
- `next-frontend/` — Frontend deferred: frontend screens for uploading and viewing videos will be addressed in a future phase. No open decisions in this document for frontend-only components, but cross-layer interfaces (upload protocol and streaming) are defined.

---

## TD-01: Queue Technology

**Scope:** Backend

**Capability:** `Background processing service (queues)`

**Context:** Video processing is a heavy, long-running asynchronous operation. We need a reliable messaging system to queue and process transcoding jobs. The selected technology must integrate natively with NestJS, handle transient failures, support job state tracking, and have low operational complexity.

**Options:**

### Option A: BullMQ (Redis-based)
- A robust, Redis-backed queue system designed specifically for Node.js environments. Supported officially by NestJS via the `@nestjs/bullmq` package.
- **Pros:**
  - **First-class NestJS Integration:** Deep integration with NestJS decorators, dependency injection, and configuration modules.
  - **Feature Rich:** Native support for delayed jobs, exponential backoff retries, rate limiting, and parent-child job chains (e.g., chain transcoding -> thumbnail extraction -> metadata parsing).
  - **Visual Monitoring:** Easily integrates with `Bull Board` for a real-time admin UI of active, delayed, and failed jobs.
  - **Low Infrastructure Complexity:** Redis is already standard in many stacks for caching/sessions, avoiding a new independent broker service.
- **Cons:**
  - **RAM-heavy:** Since jobs are stored in-memory in Redis, very large queues with massive metadata payloads can lead to high memory consumption if the worker is down.
  - **Node.js-centric:** Primary bindings are JavaScript/TypeScript.

### Option B: RabbitMQ (AMQP)
- A mature, highly robust, general-purpose enterprise message broker.
- **Pros:**
  - **Polyglot & Language-Agnostic:** Excellent if workers are written in Python, Go, or other languages.
  - **Complex Routing:** Supports advanced routing keys, exchanges (fanout, topic, direct), and message acknowledgment patterns.
  - **Disk Persistence:** Better at handling large backlogs of millions of messages without starving RAM.
- **Cons:**
  - **Integration Boilerplate:** No official NestJS job queue abstraction; requires custom wrappers or `@golevelup/nestjs-rabbitmq`.
  - **Feature Implementation:** Scheduled/delayed jobs require third-party plugins (e.g., `rabbitmq-delayed-message-exchange`), which complicate setup.

### Option C: NATS JetStream
- A high-performance, lightweight, cloud-native messaging system with built-in persistence.
- **Pros:**
  - **Exceptional Throughput:** Lower latency and resource usage compared to RabbitMQ.
  - **Simplicity:** Very easy to cluster and operate.
- **Cons:**
  - **Poor Job-Queue Abstraction:** NestJS microservice transporter is fire-and-forget; durable features (JetStream) require manual low-level setup or community wrappers.
  - **Lack of ecosystem tools:** Lacks visual dashboard tools equivalent to Bull Board for manual job management.

**Recommendation:** Option A (BullMQ) is recommended. Its official NestJS integration, ease of local setup via Redis, rich job-dependency features (ideal for multi-stage video pipelines), and native support for retries/backoffs make it the most developer-friendly and reliable choice for a pure Node/TypeScript stack. We will integrate BullMQ using `@nestjs/bullmq` and `ioredis` in a dedicated worker. Redis will run on `redis:7.2-alpine` with AOF (Append Only File) persistence and a dedicated Docker named volume `redis-data` to guarantee queue state recovery across container restarts. The queue will be named `video-processing` with a minimum job payload `{ videoId: string, storageKey: string }` where `videoId` is the internal UUID v7. Worker concurrency will be pinned to 1 per worker container instance due to CPU-heavy FFmpeg encoding, with horizontal scaling achieved via worker container replicas. The worker will enforce idempotency by verifying the video database status before executing processing tasks.

**Decision:** Option A (BullMQ - Redis-backed)

**Libraries:** bullmq, @nestjs/bullmq, ioredis

We will implement BullMQ as our background processing queue technology, integrated with NestJS via `@nestjs/bullmq`. 

### Design Implementation details:
1. **Redis Persistence Strategy:** Docker-compose Redis service will use **AOF (Append Only File)** persistence combined with a dedicated Docker named volume (`redis-data`). This ensures that if the Redis container restarts unexpectedly, queue and job states are preserved, supporting the TD-06 fault recovery requirements.
2. **Queue Names & Payload Shape:**
   - **Queue name:** `video-processing`
   - **Payload minimum shape:**
     ```typescript
     interface VideoProcessingJobPayload {
       videoId: string;      // Internal UUID v7
       storageKey: string;   // S3/MinIO original MP4 object key
     }
     ```
3. **Idempotency Strategy:** Before executing any processing steps, the worker will check if the video database status is already `processing`, `ready`, or `error`. If a job is re-enqueued, the worker checks the database state of `videoId` to avoid redundant or duplicate transcoding/thumbnail generation.
4. **Worker Concurrency:** BullMQ worker concurrency will be pinned to `1` (or limited depending on available container CPU cores) because FFmpeg encoding is extremely CPU-heavy. Scaling will be handled by increasing the container worker replicas rather than thread concurrency within a single node process.
5. **Redis Version:** BullMQ requires Redis v6.2.0 or newer. We will pin Docker Compose's Redis to version `redis:7.2-alpine` to support modern Redis streams and BullMQ commands.

---

## TD-02: Large Video Upload Strategy (Up to 10 GB)

**Scope:** Cross-layer

**Capability:** Transversal — covers: Video uploads supporting files up to 10GB without performance impact, File storage service (videos and thumbnails)

**Context:** Uploading files up to 10 GB requires an architecture that prevents API resource starvation, handles intermittent network connections, and avoids memory leaks on the backend server.

**Options:**

### Option A: S3 Presigned URLs (Multipart Upload)
- Next.js requests a set of presigned URLs from NestJS, splits the file into chunks (e.g., 50MB parts) on the client-side, and uploads them directly to MinIO/S3. Once all chunks are completed, NestJS is notified to assemble the file.
- **Pros:**
  - **Zero Server Load:** File data completely bypasses the NestJS API server, preventing bandwidth saturation and memory overhead.
  - **Resiliency:** Individual chunks can be retried independently upon failure.
  - **Scalability:** Leverage direct, high-speed upload to S3/MinIO.
- **Cons:**
  - **Client-Side Complexity:** The frontend must manage chunk splitting, parallel uploads, progress tracking, and call assembly.
  - **No Out-of-the-box Pause/Resume:** Needs minor database coordination or direct S3 multipart tracking queries to resume.

### Option B: Traditional Multipart Upload (via NestJS API)
- The client sends the entire file to the NestJS API via standard form-data (`multer`). The backend receives it and streams it to S3.
- **Pros:**
  - Simple client-side implementation.
- **Cons:**
  - **API Starvation:** 10 GB uploads passing through Node.js will block threads, consume high CPU/RAM, and likely time out.
  - **No Resumability:** Any network drop forces the user to restart the 10 GB upload from 0%.

### Option C: Tus Protocol (tus.io)
- An open protocol for resumable file uploads. Requires a `tus-js-client` on Next.js and a tus server (like `tusd` or `tus-node-server` inside NestJS) backed by S3.
- **Pros:**
  - **High Reliability:** Industry-standard for resuming paused/broken uploads automatically.
  - **Standardized:** Fully covers progress, pauses, and fingerprinted resumes.
- **Cons:**
  - **Infrastructure Complexity:** Requires running a separate `tusd` container in Docker Compose or adding heavy custom middleware in NestJS.
  - **Storage Handling:** Intermediary state needs sync between tus metadata store and the DB.

**Recommendation:** Option A (S3 Presigned URLs with Multipart) is the most performant and scalable solution. It ensures NestJS never touches the video bytes, keeping the API responsive. We will use a single bucket `streamtube-videos` for raw uploads and processed media assets. The raw video will be stored at `uploads/{videoId}/original.mp4` (where `videoId` is the internal UUID v7), while the generated thumbnail will be stored at `uploads/{videoId}/thumbnail.jpg`. The database record is created in `draft` state upon initiating the upload. Chunk size is fixed to 50 MB (maximum 200 parts for a 10 GB file, well within S3's 10,000 parts limit). NestJS issues presigned multipart URLs, and completion is triggered via `POST /videos/:id/upload/complete` accepting an array of `{ PartNumber, ETag }` to invoke `CompleteMultipartUpload`. Incomplete multipart uploads older than 7 days will be cleaned up via lifecycle policy or `AbortMultipartUpload`. Initiating and completing uploads requires authorization verifying channel ownership of the draft video.

**Decision:** Option A (S3 Presigned URLs - Multipart Upload)

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

Large video uploads (up to 10 GB) will use S3 Multipart upload directly to MinIO/S3 via presigned URLs to completely bypass the NestJS API server.

### Design Implementation details:
1. **Bucket & Key Structure:** We will use a single bucket `streamtube-videos` for raw and processed assets. The object key for the raw upload will be formatted as `uploads/{videoId}/original.mp4` where `{videoId}` is the internal UUID v7 of the video, ensuring predictability and preventing directory traversal/enumeration risks. Symmetrically, the generated thumbnail will be stored using the key `uploads/{videoId}/thumbnail.jpg`.
2. **Draft Creation:** The database record for the video is created with status `draft` in the same API call that initiates the S3 Multipart upload and generates the presigned URLs.
3. **Chunk Size & Part Count:** We will fix the chunk size to `50 MB`. For a 10 GB file, this results in `200 parts`, which is well within the 10,000 maximum parts limit of AWS S3/MinIO (and above the 5 MB minimum part size).
4. **Completion Endpoint:** A completion endpoint `POST /videos/:id/upload/complete` will accept an array of parts containing `PartNumber` and `ETag`. NestJS will call S3's `CompleteMultipartUpload` to assemble the file. A daily background cron job (or S3 lifecycle policy) will clean up incomplete multipart uploads older than 7 days using `AbortMultipartUpload`.
5. **Validation & Storage Limit:** Content length and mime-type will be validated by NestJS before issuing presigned URLs. The maximum upload size of 10 GB is also reinforced at the S3/MinIO level via Bucket Policy or policy conditions on presigned requests.
6. **Authorization:** Generating presigned URLs and completing the multipart upload require that the authenticated user's channel owns the video record in the `draft` state.

---

## TD-03: Video Worker Execution Environment (FFmpeg)

**Scope:** Backend

**Capability:** Transversal — covers: Automatic video processing after upload (duration and metadata extraction), Automatic thumbnail generation from a video frame

**Context:** FFmpeg execution is highly CPU and memory intensive. Running it incorrectly can starve web API processes and impact user experience.

**Options:**

### Option A: Same Container as NestJS (Single Container)
- FFmpeg is installed inside the main NestJS API container and executed using child processes (or `fluent-ffmpeg`).
- **Pros:**
  - Simplest Docker setup; single container.
  - Direct local filesystem sharing between API and FFmpeg tasks.
- **Cons:**
  - **CPU Starvation:** Running a heavy transcode blocks the server resources, causing NestJS HTTP endpoints to slow down or time out.
  - **Scaling Limits:** Cannot scale transcoding capacity independently of HTTP API instances.

### Option B: Separate Container (Dedicated Worker Service)
- A separate Node.js/NestJS container runs as a BullMQ worker. It has FFmpeg/ffprobe pre-installed and consumes jobs from Redis.
- **Pros:**
  - **Resource Isolation:** High CPU video transcoding runs on a separate container, ensuring the API remains fast.
  - **Independent Scaling:** Workers can scale from 1 to N instances depending on queue load.
  - **Fault Isolation:** A segfault in FFmpeg does not crash the HTTP API.
- **Cons:**
  - Requires setting up shared volumes (or downloading/uploading to S3/MinIO) for temp file storage.
  - Slightly more Docker Compose configuration.

### Option C: Serverless (AWS Lambda / Cloud Run Jobs)
- S3 upload triggers a serverless function containing FFmpeg.
- **Pros:**
  - Pay-per-second, scales to zero. No container management.
- **Cons:**
  - **Timeouts:** AWS Lambda has a strict 15-minute execution limit, which may fail on 10 GB transcoding jobs.
  - **Cold Starts & Library Size:** FFmpeg binary size makes function package size large.
  - **High Costs:** Heavy CPU operations in serverless environments are more expensive than dedicated VMs at scale.

**Recommendation:** Option B (Separate Container Worker) is recommended. It offers clean separation of CPU-bound operations, scales easily in Docker Compose/Kubernetes, and supports long-running transcoding jobs without serverless limits. The worker container will be built on `node:20-bookworm-slim` with `ffmpeg` and `ffprobe` installed (`fluent-ffmpeg`). To ensure seekability for metadata extraction and frame accurate thumbnail generation, the worker will download the raw video from MinIO/S3 into a local temporary volume `worker-tmp` mounted at `/tmp/video-jobs`. Processing will run as a sequential BullMQ job executing `ffprobe` metadata parsing, thumbnail extraction at exactly 10% of duration (with fallback to 00:00:01), and fast-start MP4 generation. A BullMQ job timeout of 30 minutes will be enforced, and a `finally` block guarantees cleanup of local files in `/tmp/video-jobs` after processing or error. Corrupted or invalid media files will be cataloged and handled as `INVALID_VIDEO_FILE` domain errors without endless retries.

**Decision:** Option B (Separate Container FFmpeg Worker)

**Libraries:** fluent-ffmpeg, @types/fluent-ffmpeg

We will run a dedicated NestJS worker container with FFmpeg and ffprobe installed to execute CPU-heavy transcoding, metadata parsing, and thumbnail extraction.

### Design Implementation details:
1. **Accessing Video Bytes:** The worker will download the original video from MinIO/S3 into a local temporary volume/disk before invoking FFmpeg. Downloading is preferred over streaming input directly into FFmpeg because:
   - Streaming 10 GB over HTTP during transcoding is highly unstable and can fail on network hiccups.
   - FFmpeg needs to seek back and forth to extract metadata, calculate exact durations, and pull thumbnails, which requires a local seekable file.
2. **Job Structure & Chain:** A single, sequential BullMQ job will handle the entire pipeline (FFprobe metadata -> FFmpeg thumbnail -> FFmpeg fast-start MP4 generation). If the metadata or thumbnail extraction fails, the entire job fails, and the status changes to `error` according to TD-06.
3. **Thumbnail Extraction Strategy:** The thumbnail frame will be extracted at exactly 10% of the video's duration (extracted via FFprobe first) with a fallback to `00:00:01` if the video is extremely short.
4. **Temporary Path & Guaranteed Cleanup:** The worker container will map a Docker volume `worker-tmp` at `/tmp/video-jobs`. A `finally` block in the job processor will guarantee the deletion of local files after the job completes (or crashes/times out) to prevent disk exhaustion.
5. **Job Timeout:** We will set a BullMQ job timeout of `30 minutes`. If the timeout is reached, the job will fail and enter the retry/error lifecycle defined in TD-06.
6. **Error Catalog:** The application will explicitly catch and catalog FFprobe/FFmpeg read failures under `INVALID_VIDEO_FILE` (e.g., corrupted file, missing moov atom, or unsupported codec) to distinguish application errors from infrastructure failures.
7. **Docker Image:** The worker Dockerfile will use a Node alpine-based or Debian-slim base image (e.g., `node:20-bookworm-slim`) and install `ffmpeg` and `ffprobe` via package manager, validating H.264/AAC codec support.

---

## TD-04: Video Streaming Strategy

**Scope:** Cross-layer

**Capability:** Transversal — covers: Streaming playback (without requiring a full download), Video download by the user

**Context:** Users require smooth seeking, fast start times, and minimal buffering when streaming videos.

**Options:**

### Option A: HTTP Range Requests (206 Partial Content) in NestJS
- NestJS reads the raw MP4 file from disk/S3 and streams chunks back using `Range` headers.
- **Pros:**
  - Simple backend implementation; works with basic `.mp4` files.
- **Cons:**
  - High backend bandwidth consumption and CPU overhead for proxying data.
  - No Adaptive Bitrate (ABR); high-resolution videos will buffer on slow connections.

### Option B: Direct Redirect to Public/Presigned S3/MinIO URLs
- NestJS generates a direct URL pointing to S3/MinIO (cached by a CDN like CloudFront). The browser requests ranges directly from the storage.
- **Pros:**
  - **Perfect Scalability:** NestJS only returns a URL string (metadata), bypassing byte handling entirely.
  - S3/MinIO natively supports HTTP Range Requests out of the box.
- **Cons:**
  - No Adaptive Bitrate. High-quality files will buffer on mobile/unstable networks.

### Option C: HLS (HTTP Live Streaming)
- The worker transcodes the video into multiple resolutions (e.g., 360p, 720p, 1080p), splits them into `.ts` segments, and creates a master `.m3u8` playlist. NestJS returns the URL to the playlist.
- **Pros:**
  - **Adaptive Bitrate Streaming (ABR):** Automatically adjusts video quality based on network speed.
  - Fast seek times and initial load times.
  - Industry-standard for modern video players (Video.js, HLS.js, Plyr).
- **Cons:**
  - Transcoding is slow and requires more worker resources.
  - Increases storage usage (storing multiple resolutions and index files).

### Option D: Direct Object Storage Streaming with Presigned URL + HTTP Range (MP4 Fast Start)
- The backend authorizes the access to the video and returns a presigned URL for the object in MinIO/S3. The client plays the video directly from storage using HTTP Range Requests (206 Partial Content), while the worker processes the video to guarantee a fast-start MP4 (moov atom at the beginning).
- **Pros:**
  - **Zero Server Bandwidth/CPU load:** Bypasses NestJS byte-proxying completely, allowing the API to scale.
  - **Progressive Seek & Play:** Supports native seeking and instant startup.
  - **Simplified Architecture:** S3/MinIO natively handles range-requests out-of-the-box, avoiding multi-file HLS segmented transcoding complexity.
- **Cons:**
  - **No Adaptive Bitrate:** Does not automatically shift quality on slower/mobile networks.
  - **Security Expiration:** Requires managing short-lived presigned URLs.

**Recommendation:** Option D (Direct Object Storage Streaming with Presigned URL + HTTP Range) is chosen over HLS (Option C) for this phase. While HLS is the industry standard for adaptive bitrate streaming, it introduces significant transcoding time, high CPU utilization, and multi-file segmented storage complexity. Option D satisfies the project requirements for progressive playback with instant seeking by leveraging a single-file Fast Start MP4 architecture (`-movflags +faststart` placing the `moov atom` at the beginning of the file) and direct S3/MinIO HTTP Range Requests (206 Partial Content). The NestJS API provides authorization and returns short-lived presigned URLs (2-hour expiration), keeping backend CPU and bandwidth consumption at zero. Streaming and download contracts are explicitly decoupled: `GET /videos/:id/stream` returns a presigned URL for inline video player playback with HTTP Range support, whereas `GET /videos/:id/download` returns a presigned URL with `response-content-disposition=attachment; filename="<video-title>.mp4"` to force local file download.

**Rationale for Deviation:** Option C (HLS) introduces significant implementation and operational complexity, requiring CPU-intensive segmented transcoding and multi-file storage handling. For this phase, the team selected Option D (Direct Object Storage Streaming with Presigned URL + HTTP Range) because it satisfies the streaming requirement (with Fast Start progressive play) using a much simpler single-file architecture. This significantly reduces transcoding time and storage overhead while leveraging MinIO/S3's native range-request capability.

**Decision:** Option D (Direct Object Storage Streaming with Presigned URL + HTTP Range)

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

The backend authorizes access to the video and returns a presigned URL pointing directly to the object in MinIO/S3. The browser plays the video from the storage using HTTP Range Requests (206 Partial Content), which MinIO/S3 supports natively. The processing worker guarantees that the transcoded output MP4 is optimized with the `moov atom` at the beginning of the file (Fast Start / progressive play).

### Design Implementation details:
1. **Bypassing NestJS Bandwidth:** NestJS only handles authentication and metadata (returns the presigned redirect/URL), ensuring high performance and zero-copy byte streaming.
2. **MP4 Fast Start Optimization:** The video worker container will process the uploaded video to standard H.264/AAC with the FFmpeg flag `-movflags +faststart` to move the index (`moov atom`) to the beginning of the file, allowing immediate progressive playback and seeking without waiting for the full 10 GB file download.
3. **Security/Expiration:** Presigned URLs will have a short expiration (e.g., 2 hours) to prevent URL sharing and unauthorized access.
4. **Streaming vs. Download Contracts:**
   - **Streaming Endpoint (`GET /videos/:id/stream`):** Returns a presigned URL optimized for inline rendering and range queries. The browser streams chunks as needed via HTTP Range requests.
   - **Download Endpoint (`GET /videos/:id/download`):** Returns an attachment presigned URL that forces the browser to download the complete file as a local copy. This is accomplished by injecting the query parameter `response-content-disposition=attachment; filename="<video-title>.mp4"` during the S3 presigned URL generation.

---

## TD-05: Public Video URL Identifier (Slug/ID)

**Scope:** Cross-layer

**Capability:** `Unique URL per video, without conflicts with other videos`

**Context:** Video URLs should be short, readable, secure, and unique.

**Options:**

### Option A: UUID v4
- E.g., `/watch/f81d4fae-7dec-11d0-a765-00a0c91e6bf6`
- **Pros:** Native database support, zero collision risk.
- **Cons:** Visually long (36 characters) and ugly.

### Option B: NanoID (e.g., 10-12 characters)
- E.g., `/watch/jR8G4uK9xP`
- **Pros:**
  - URL-friendly alphabet, customizable length.
  - Shorter than UUID but practically collision-free for our database size.
  - Clean, modern, resembling YouTube's format.
- **Cons:**
  - Requires generation logic on insert.
  - Must be indexed in the database.

### Option C: Hashids / Sqids (Obfuscated Sequential ID)
- E.g., `/watch/kR5xL`
- **Pros:** Extremely short.
- **Cons:**
  - Not cryptographically secure (can be decoded easily, exposing sequential IDs and total video counts).
  - Difficult to match if primary keys are UUIDs.

**Recommendation:** Option B (NanoID) is recommended for public identifiers alongside internal UUID v7 primary keys. We will use UUID v7 as the internal database primary key (`id`) for optimal B-tree indexing and chronological sorting, while generating a unique 12-character NanoID (`publicId`) with a `UNIQUE` database index constraint for public URLs and client routing. The `publicId` is generated automatically during draft creation and is strictly immutable, remaining unaffected by video title or metadata updates. In the statistically negligible event of a collision on insert, the repository catches the unique constraint violation, generates a new NanoID, and retries. Permissions, foreign key relations, and channel ownership remain bound to the internal UUID v7.

**Decision:** Option B (NanoID - 12-character public ID with internal UUID v7)

**Libraries:** nanoid

We will implement Option B (UUID v7 internally and an immutable 12-character NanoID as the public URL identifier).

### Design Implementation details:
1. **Generation & Uniqueness:** The `publicId` is generated automatically upon video creation (draft stage) using NanoID's URL-friendly alphabet. It is protected by a `UNIQUE` database index constraint. In the extremely unlikely event of a collision on insert, the NestJS repository catches the constraint error, generates a new NanoID, and retries.
2. **Immutability:** The `publicId` is completely static and immutable; it does not depend on the title, description, slugs, or internal ID. Changes to title or other fields will not affect or break existing public URLs.
3. **Authorization Isolation:** While public routing resolves videos using the `publicId`, permissions, channels, and internal relations are resolved via the secure internal UUID v7.

---

## TD-06: Video Status Lifecycle & Error/DLQ Strategy

**Scope:** Backend

**Capability:** Transversal — covers: `Automatically create a draft video record when the upload starts`, `Automatic video processing after upload (duration and metadata extraction)`

**Context:** Video processing is prone to failure (corrupted uploads, encoding errors, networking issues). We need a clear state machine and retry/Dead Letter Queue (DLQ) strategy.

**Options:**

### Option A: Unified DB State Machine + BullMQ Retries/DLQ
- Enforce the database state machine `draft -> processing -> ready / error`, configure BullMQ with 3 attempts and exponential backoff, and use `@OnWorkerEvent('failed')` to write the error log to the DB and leave the failed jobs in BullMQ for manual inspection.
- **Pros:**
  - Highly resilient architecture with automatic recovery of transient errors.
  - Clean tracing of failures directly in the database.
- **Cons:**
  - Slightly more complex job execution and event handling logic in NestJS.

### Option B: Simple Retry on Worker with Immediate Failure State
- No exponential backoff/delay; immediately transition the video status to `error` on first crash and require the user/client to restart.
- **Pros:**
  - Simpler status updates and logic.
- **Cons:**
  - High friction for users on network hiccups.
  - Lacks structured recovery or detailed error logging.

### Option C: Explicit Video State Machine + Idempotent Processing + Retry/Failed Job Handling
- The video lifecycle will be:
  ```
  draft → processing → ready
                    ↘ error
  ```
- **Rules:**
  1. **draft**: The video record is created before the upload. The video remains in `draft` until the upload is confirmed as complete. No media processing may begin until the upload is complete.
  2. **processing**: After upload confirmation, the backend publishes a single processing job to the queue. The worker changes the state to `processing` before starting processing.
  3. **ready**: The worker changes the video to `ready` only after successfully completing all required operations: duration extraction, metadata extraction, thumbnail generation, and generation/validation of the artifacts required for playback.
  4. **error**: After all configured attempts are exhausted, the video moves to `error`. The error must be persisted with sufficient information for diagnosis. The failed job remains available for operational inspection in the queue system.
  5. **Retry**: Failed processing attempts must be limited. Use exponential backoff for transient errors. Permanent failures must not remain in retry indefinitely.
  6. **Idempotency**: Processing must be idempotent. Reprocessing the same video must not create multiple thumbnails, inconsistent records, or corrupt the final state. The worker must check the current state before executing irreversible steps.
  7. **Concurrency**: The same video must not be processed simultaneously by multiple jobs. The video identifier must be used as the job reference, enabling deduplication and tracking.
  8. **Persistence and consistency**: Status and metadata updates must be persisted consistently. A processing failure must leave the database in a recoverable and observable state.
- **Pros:**
  - Explicit lifecycle.
  - Recoverable processing.
  - Prevents duplicate processing.
  - Supports retries for transient failures.
  - Facilitates operational diagnosis.
  - The database state represents the actual processing state.
- **Cons:**
  - Greater worker complexity.
  - Requires idempotency and concurrency control.
  - Requires proper persistence of error information.

**Recommendation:** Option C (Explicit Video State Machine + Idempotent Processing + Retry/Failed Job Handling) is recommended. It provides a robust, resilient lifecycle governed by 8 strict rules: 1) `draft`: Video record created before upload and remains in draft until upload completion is confirmed, blocking any media processing; 2) `processing`: Transitioned by the worker upon picking up the job after upload confirmation; 3) `ready`: Transitioned only after full completion and validation of metadata extraction, thumbnail generation, and FastStart MP4 upload; 4) `error`: Transitioned after exhausting retries or fatal failure, persisting diagnosis in `errorLog` and preserving failed jobs in BullMQ for operational DLQ inspection; 5) Retries: Maximum of 3 attempts with exponential backoff (1-minute initial delay) for transient errors, while fatal errors (`INVALID_VIDEO_FILE`) fail immediately without retry; 6) Idempotency: Worker checks database state before irreversible steps to prevent duplicate assets; 7) Concurrency: Enforced via `videoId` job identifier and database/Redis locking to prevent concurrent processing of the same video; 8) Persistence and consistency: Consistent atomic updates ensuring observable database states at all times.

**Decision:** Option C (Explicit Video State Machine + Idempotent Processing + Retry/Failed Job Handling)

**Libraries:** bullmq

We will implement Option C (Explicit Video State Machine + Idempotent Processing + Retry/Failed Job Handling) as our state machine and error handling strategy.

### Design Implementation details:
1. **State Machine Transitions:**
   - `draft`: The initial record created upon multipart upload initialization. No processing can start.
   - `processing`: Transitioned by the worker immediately before starting the FFmpeg processing job.
   - `ready`: Transitioned by the worker only after successfully completing all processing tasks (metadata extraction, thumbnail generation, faststart MP4 file upload to S3).
   - `error`: Transitioned if all retries are exhausted.
2. **Retries & Exponential Backoff:** Processing jobs will have a maximum of 3 attempts with an exponential backoff delay of `1 minute` (e.g., attempt 2 after 1min, attempt 3 after 2min) to survive temporary infrastructure glitches. Permanent failures (such as `INVALID_VIDEO_FILE` codec errors) will fail immediately without retries.
3. **Observability & Manual DLQ:** If a job fails permanently, the worker leaves the job in BullMQ's failed state (serving as our Dead Letter Queue) for manual administrative analysis or replay via Bull Board. The specific error message and stack trace are persisted in the video database record's `errorLog` or `statusDetails` field.
4. **Concurrency & Idempotency Control:** Redis-based locking or database row locking (Pessimistic Write) is used to ensure a video cannot be processed by more than one worker container concurrently. Check-before-write logic ensures worker steps are idempotent.

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Queue Technology | Option A (BullMQ) | Option A (BullMQ - Redis-backed) |
| TD-02 | Cross-layer | Large Video Upload Strategy (Up to 10 GB) | Option A (S3 Presigned URLs - Multipart) | Option A (S3 Presigned URLs - Multipart Upload) |
| TD-03 | Backend | Video Worker Execution Environment (FFmpeg) | Option B (Separate Container Worker) | Option B (Separate Container FFmpeg Worker) |
| TD-04 | Cross-layer | Video Streaming Strategy | Option C (HLS) | Option D (Direct Object Storage Streaming with Presigned URL + HTTP Range) |
| TD-05 | Cross-layer | Public Video URL Identifier (Slug/ID) | Option B (NanoID) | Option B (NanoID - 12-character public ID with internal UUID v7) |
| TD-06 | Backend | Video Status Lifecycle & Error/DLQ Strategy | Option A (Unified DB State Machine + BullMQ Retries/DLQ) | Option C (Explicit Video State Machine + Idempotent Processing + Retry/Failed Job Handling) |
