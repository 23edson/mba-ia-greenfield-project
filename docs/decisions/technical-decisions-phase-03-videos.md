---
scope_type: phase
related_phases: [3]
status: pending
date: 2026-08-29
scope_description: "Design decisions for video upload, queueing, worker execution, streaming, public identifiers, and lifecycle state transitions in Phase 03 of StreamTube."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — Backend logic for uploads, video database entity, BullMQ integration, worker process management, and streaming APIs.
- `next-frontend/` — Frontend deferred: frontend screens for uploading and viewing videos will be addressed in a future phase. No open decisions in this document for frontend-only components, but cross-layer interfaces (upload protocol and streaming) are defined.

---

## TD-01: Queue Technology

**Scope:** Backend

**Capability:** `Serviço de processamento em segundo plano (filas)`

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

**Recommendation:** **Option A (BullMQ)** is recommended. Its official NestJS integration, ease of local setup via Redis, rich job-dependency features (ideal for multi-stage video pipelines), and native support for retries/backoffs make it the most developer-friendly and reliable choice for a pure Node/TypeScript stack.

**Decision:** _[pending]_

---

## TD-02: Large Video Upload Strategy (Up to 10 GB)

**Scope:** Cross-layer

**Capability:** `Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance`

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

**Recommendation:** **Option A (S3 Presigned URLs with Multipart)** is the most performant and scalable solution. It ensures NestJS never touches the video bytes, keeping the API responsive. The API contract will define the endpoint to initiate the multipart upload and generate presigned URLs, keeping the schema simple. Resumability is achieved by querying the S3 Multipart Upload API (List Parts) before uploading, avoiding complex backend state storage.

**Decision:** _[pending]_

---

## TD-03: Video Worker Execution Environment (FFmpeg)

**Scope:** Backend

**Capability:** `Processamento automático do vídeo após upload (extração de duração e metadados)`

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

**Recommendation:** **Option B (Separate Container Worker)** is recommended. It offers clean separation of CPU-bound operations, scales easily in Docker Compose/Kubernetes, and supports long-running transcoding jobs without serverless limits.

**Decision:** _[pending]_

---

## TD-04: Video Streaming Strategy

**Scope:** Cross-layer

**Capability:** `Reprodução via streaming (sem necessidade de download completo)`

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

**Recommendation:** **Option C (HLS)** is the standard for any modern video streaming site. We should transcode videos to HLS using FFmpeg in our worker, store segments in S3/MinIO, and stream via a direct redirect (Option B) to S3/CloudFront HLS manifest files for maximum performance.

**Decision:** _[pending]_

---

## TD-05: Public Video URL Identifier (Slug/ID)

**Scope:** Cross-layer

**Capability:** `URL única por vídeo, sem conflito com outros vídeos`

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

**Recommendation:** **Option B (NanoID)**. We will use UUID v7 as our database primary key for indexing and sorting, and generate a unique 12-character NanoID for public URLs.

**Decision:** _[pending]_

---

## TD-06: Video Status Lifecycle & Error/DLQ Strategy

**Scope:** Backend

**Capability:** Transversal — covers: `Pré-cadastro automático do vídeo como rascunho ao iniciar o upload`, `Processamento automático do vídeo após upload (extração de duração e metadados)`

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

**Recommendation:** **Option A (Unified DB State Machine + BullMQ Retries/DLQ)** is recommended. It provides a robust, resilient architecture with transient error recovery and clear tracing of failures.

**Decision:** _[pending]_

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Queue Technology | Option A (BullMQ) | _[pending]_ |
| TD-02 | Cross-layer | Large Video Upload Strategy (Up to 10 GB) | Option A (S3 Presigned URLs - Multipart) | _[pending]_ |
| TD-03 | Backend | Video Worker Execution Environment (FFmpeg) | Option B (Separate Container Worker) | _[pending]_ |
| TD-04 | Cross-layer | Video Streaming Strategy | Option C (HLS) | _[pending]_ |
| TD-05 | Cross-layer | Public Video URL Identifier (Slug/ID) | Option B (NanoID) | _[pending]_ |
| TD-06 | Backend | Video Status Lifecycle & Error/DLQ Strategy | Option A (Unified DB State Machine + BullMQ Retries/DLQ) | _[pending]_ |
