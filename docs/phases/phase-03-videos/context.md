---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-08-08T15:07:05-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-29T17:19:47-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-08-08T15:07:05-03:00"
  docs/phases/phase-02-auth/context.md: "2026-08-08T15:07:05-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-08-08T15:07:05-03:00"
  .agents/skills/testing-guide-nestjs-project/SKILL.md: "2026-08-15T13:52:10-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — telas de upload e reprodução de vídeos ficam diferidas para fases posteriores (ex.: Fase 05).

**Sequencing notes:** Depende de: Fase 01, Fase 02

**Neighbors (for boundary detection only):**

- **Phase 2:** Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha.
- **Phase 4:** Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Queue Technology | decided | Option A | bullmq, @nestjs/bullmq, ioredis |
| phase-03-videos/TD-02 | phase | Cross-layer | Large Video Upload Strategy (Up to 10 GB) | decided | Option A | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-03 | phase | Backend | Video Worker Execution Environment (FFmpeg) | decided | Option B | fluent-ffmpeg, @types/fluent-ffmpeg |
| phase-03-videos/TD-04 | phase | Cross-layer | Video Streaming Strategy | decided | Option D | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-05 | phase | Cross-layer | Public Video URL Identifier (Slug/ID) | decided | Option B | nanoid |
| phase-03-videos/TD-06 | phase | Backend | Video Status Lifecycle & Error/DLQ Strategy | decided | Option C | bullmq |

_Source files:_

- phase-03-videos — docs/decisions/technical-decisions-phase-03-videos.md (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-06 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03, phase-03-videos/TD-06 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-03 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-05 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-04 |
| Download do vídeo pelo usuário | phase-03-videos/TD-04 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** Option A (BullMQ) is recommended. Its official NestJS integration, ease of local setup via Redis, rich job-dependency features (ideal for multi-stage video pipelines), and native support for retries/backoffs make it the most developer-friendly and reliable choice for a pure Node/TypeScript stack. We will integrate BullMQ using `@nestjs/bullmq` and `ioredis` in a dedicated worker. Redis will run on `redis:7.2-alpine` with AOF (Append Only File) persistence and a dedicated Docker named volume `redis-data` to guarantee queue state recovery across container restarts. The queue will be named `video-processing` with a minimum job payload `{ videoId: string, storageKey: string }` where `videoId` is the internal UUID v7. Worker concurrency will be pinned to 1 per worker container instance due to CPU-heavy FFmpeg encoding, with horizontal scaling achieved via worker container replicas. The worker will enforce idempotency by verifying the video database status before executing processing tasks.
**Libraries:** bullmq, @nestjs/bullmq, ioredis

### phase-03-videos/TD-02

**Recommendation:** Option A (S3 Presigned URLs with Multipart) is the most performant and scalable solution. It ensures NestJS never touches the video bytes, keeping the API responsive. We will use a single bucket `streamtube-videos` for raw uploads and processed media assets. The raw video will be stored at `uploads/{videoId}/original.mp4` (where `videoId` is the internal UUID v7), while the generated thumbnail will be stored at `uploads/{videoId}/thumbnail.jpg`. The database record is created in `draft` state upon initiating the upload. Chunk size is fixed to 50 MB (maximum 200 parts for a 10 GB file, well within S3's 10,000 parts limit). NestJS issues presigned multipart URLs, and completion is triggered via `POST /videos/:id/upload/complete` accepting an array of `{ PartNumber, ETag }` to invoke `CompleteMultipartUpload`. Incomplete multipart uploads older than 7 days will be cleaned up via lifecycle policy or `AbortMultipartUpload`. Initiating and completing uploads requires authorization verifying channel ownership of the draft video.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-videos/TD-03

**Recommendation:** Option B (Separate Container Worker) is recommended. It offers clean separation of CPU-bound operations, scales easily in Docker Compose/Kubernetes, and supports long-running transcoding jobs without serverless limits. The worker container will be built on `node:20-bookworm-slim` with `ffmpeg` and `ffprobe` installed (`fluent-ffmpeg`). To ensure seekability for metadata extraction and frame accurate thumbnail generation, the worker will download the raw video from MinIO/S3 into a local temporary volume `worker-tmp` mounted at `/tmp/video-jobs`. Processing will run as a sequential BullMQ job executing `ffprobe` metadata parsing, thumbnail extraction at exactly 10% of duration (with fallback to 00:00:01), and fast-start MP4 generation. A BullMQ job timeout of 30 minutes will be enforced, and a `finally` block guarantees cleanup of local files in `/tmp/video-jobs` after processing or error. Corrupted or invalid media files will be cataloged and handled as `INVALID_VIDEO_FILE` domain errors without endless retries.
**Libraries:** fluent-ffmpeg, @types/fluent-ffmpeg

### phase-03-videos/TD-04

**Recommendation:** Option D (Direct Object Storage Streaming with Presigned URL + HTTP Range) is chosen over HLS (Option C) for this phase. While HLS is the industry standard for adaptive bitrate streaming, it introduces significant transcoding time, high CPU utilization, and multi-file segmented storage complexity. Option D satisfies the project requirements for progressive playback with instant seeking by leveraging a single-file Fast Start MP4 architecture (`-movflags +faststart` placing the `moov atom` at the beginning of the file) and direct S3/MinIO HTTP Range Requests (206 Partial Content). The NestJS API provides authorization and returns short-lived presigned URLs (2-hour expiration), keeping backend CPU and bandwidth consumption at zero. Streaming and download contracts are explicitly decoupled: `GET /videos/:id/stream` returns a presigned URL for inline video player playback with HTTP Range support, whereas `GET /videos/:id/download` returns a presigned URL with `response-content-disposition=attachment; filename="<video-title>.mp4"` to force local file download.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-videos/TD-05

**Recommendation:** Option B (NanoID) is recommended for public identifiers alongside internal UUID v7 primary keys. We will use UUID v7 as the internal database primary key (`id`) for optimal B-tree indexing and chronological sorting, while generating a unique 12-character NanoID (`publicId`) with a `UNIQUE` database index constraint for public URLs and client routing. The `publicId` is generated automatically during draft creation and is strictly immutable, remaining unaffected by video title or metadata updates. In the statistically negligible event of a collision on insert, the repository catches the unique constraint violation, generates a new NanoID, and retries. Permissions, foreign key relations, and channel ownership remain bound to the internal UUID v7.
**Libraries:** nanoid

### phase-03-videos/TD-06

**Recommendation:** Option C (Explicit Video State Machine + Idempotent Processing + Retry/Failed Job Handling) is recommended. It provides a robust, resilient lifecycle governed by 8 strict rules: 1) `draft`: Video record created before upload and remains in draft until upload completion is confirmed, blocking any media processing; 2) `processing`: Transitioned by the worker upon picking up the job after upload confirmation; 3) `ready`: Transitioned only after full completion and validation of metadata extraction, thumbnail generation, and FastStart MP4 upload; 4) `error`: Transitioned after exhausting retries or fatal failure, persisting diagnosis in `errorLog` and preserving failed jobs in BullMQ for operational DLQ inspection; 5) Retries: Maximum of 3 attempts with exponential backoff (1-minute initial delay) for transient errors, while fatal errors (`INVALID_VIDEO_FILE`) fail immediately without retry; 6) Idempotency: Worker checks database state before irreversible steps to prevent duplicate assets; 7) Concurrency: Enforced via `videoId` job identifier and database/Redis locking to prevent concurrent processing of the same video; 8) Persistence and consistency: Consistent atomic updates ensuring observable database states at all times.
**Libraries:** bullmq

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and tests; if the team later wants progressive enhancement, the migration A→B is per-form — A is the safer default.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms in Phase 02+. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and tests; if the team later wants progressive enhancement, the migration A→B is per-form — A is the safer default.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|------------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Telas de frontend para upload e reprodução de vídeos | deferred | Rascunho, upload e reprodução de vídeos no frontend adiados para fase posterior (Fase 05). | — |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`.

| Artifact created | Required tests | Guide |
|---|---|---|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` | `artifacts/entities.md` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract | `artifacts/services.md` |
| Service with DB only (no branching) | Integration: DB contract | `artifacts/services.md` |
| Service with configured lib (JWT, cache) | Unit: real lib with test config | `artifacts/services.md` |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter | `artifacts/services.md` |
| Module with configured imports | Unit: compilation test | `artifacts/modules.md` |
| Controller | E2E only — do NOT write unit tests | `artifacts/controllers.md` |
| DTO | E2E: one validation wiring test per endpoint | `artifacts/dtos.md` |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic | `artifacts/guards.md` |
| Guard (simple, delegates to Passport) | E2E only | `artifacts/guards.md` |
| Strategy (Passport) | E2E via guard | `artifacts/strategies.md` |
| Pipe (custom transformation/validation) | Unit | `artifacts/pipes.md` |
| Interceptor (response transform, logging) | Unit and/or E2E | `artifacts/interceptors.md` |
| Exception Filter | Unit + E2E | `artifacts/filters.md` |
| Middleware | E2E | `artifacts/middleware.md` |
