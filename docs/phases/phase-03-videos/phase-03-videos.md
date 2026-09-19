---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-08-29T17:20:35-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-08-29T17:43:03-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-29T17:19:47-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Implementar upload de vídeos de até 10 GB via URLs pré-assinadas (S3/MinIO), pré-cadastro automático como rascunho, processamento em segundo plano via fila BullMQ (extração de duração, metadados e geração de thumbnail com FFmpeg), URLs públicas únicas por vídeo (NanoID), reprodução via streaming com HTTP Range Requests e download direto.

---

## Step Implementations

### SI-03.1 — Dependencies, Configuration Namespaces e MinIO/Redis Infrastructure

**Description:** Instalar dependências de produção e desenvolvimento da Fase 03, criar namespaces de configuração `storage` e `queue` com validação Joi e configurar serviços MinIO e Redis com volume de persistência no `compose.yaml`.

**Technical actions:**

1. Instalar dependências em `nestjs-project/`: `@nestjs/bullmq@^11.x`, `bullmq@^5.x`, `ioredis@^5.x`, `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`, `fluent-ffmpeg@^2.1.x`, `nanoid@^5.x` e `@types/fluent-ffmpeg@^2.1.x` como dev dependency (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`, `phase-03-videos/TD-03`, `phase-03-videos/TD-05`).
2. Criar `src/config/storage.config.ts` — factory `registerAs('storage', ...)` com `STORAGE_ENDPOINT`, `STORAGE_REGION` (default `'us-east-1'`), `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET_NAME` (default `'streamtube-videos'`) e `STORAGE_FORCE_PATH_STYLE` (boolean, default `true` para MinIO) (per `phase-03-videos/TD-02`, `phase-03-videos/TD-04`).
3. Criar `src/config/queue.config.ts` — factory `registerAs('queue', ...)` com `REDIS_HOST` (default `'localhost'`), `REDIS_PORT` (number, default `6379`) e `REDIS_PASSWORD` (optional) (per `phase-03-videos/TD-01`).
4. Atualizar `src/config/env.validation.ts` e `.env.example` — adicionar variáveis de storage e Redis ao schema Joi (`STORAGE_ACCESS_KEY` e `STORAGE_SECRET_KEY` obrigatórios; outros com defaults de desenvolvimento).
5. Atualizar `nestjs-project/compose.yaml` — adicionar serviço Redis (`redis:7.2-alpine` com flag `--appendonly yes` e volume persistente nomeado `redis-data`) e serviço MinIO (`minio/minio` com portas 9000 e 9001 e volume `minio-data`) (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `storage.config.ts` | Unit: namespace structure and typing | `src/config/storage.config.spec.ts` |
| `queue.config.ts` | Unit: namespace structure and typing | `src/config/queue.config.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Aplicação inicializa com sucesso quando todas as variáveis de ambiente de storage e Redis são fornecidas.
- Inicialização da aplicação sem `STORAGE_ACCESS_KEY` ou `STORAGE_SECRET_KEY` falha no bootstrap via validação Joi.
- Serviço Redis no Docker Compose aceita conexões na porta 6379 e persiste comandos no volume `redis-data`.
- Serviço MinIO no Docker Compose aceita conexões S3 na porta 9000 e console web na porta 9001.

---

### SI-03.2 — Video Entity e Database Migration

**Description:** Criar a entidade `Video` com mapeamento do ciclo de vida de status (`draft`, `processing`, `ready`, `error`), identificador público `publicId` de 12 caracteres (NanoID), índices e migration TypeORM com relacionamento para `Channel`.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` com colunas: `id` (uuid v7 PK generated), `publicId` (varchar(12), unique, not null), `title` (varchar(255), not null), `description` (text, nullable), `status` (enum `VideoStatus`: `'draft'`, `'processing'`, `'ready'`, `'error'`, default `'draft'`), `storageKey` (varchar(512), not null), `thumbnailKey` (varchar(512), nullable), `duration` (float, nullable), `width` (integer, nullable), `height` (integer, nullable), `sizeInBytes` (bigint, nullable), `errorLog` (text, nullable), `channelId` (uuid FK → `channels.id`, not null), `createdAt` (CreateDateColumn), `updatedAt` (UpdateDateColumn). Definir `@ManyToOne(() => Channel, channel => channel.videos)` com `@JoinColumn({ name: 'channelId' })` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`).
2. Configurar índices na entidade: `@Index({ unique: true })` em `publicId`, `@Index()` em `channelId`, `@Index()` em `status` (per Data Model).
3. Gerar migration TypeORM `CreateVideosTable` (`npm run migration:generate -- src/database/migrations/CreateVideosTable`) e revisar schema SQL, constraints e chaves estrangeiras.
4. Criar `src/videos/videos.module.ts` — módulo NestJS com `TypeOrmModule.forFeature([Video])` e registrá-lo em `src/app.module.ts`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `video.entity.ts` | Integration: constraints, defaults, unique publicId, channelId relation | `src/videos/entities/video.entity.integration-spec.ts` |
| `videos.module.ts` | Unit: module compilation with TypeOrmModule wiring | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com todos os campos, constraints, enums e índices definidos no Data Model.
- Inserção de vídeo com `publicId` duplicado é rejeitada por violação de constraint UNIQUE.
- Campo `status` assume o valor padrão `'draft'` ao persistir novo registro de vídeo.
- Campo `errorLog` aceita persistência de stack trace/diagnóstico longo quando status é alterado para `'error'`.

---

### SI-03.3 — Storage Service (MinIO/S3 Multipart Upload & Presigned URLs)

**Description:** Implementar o `StorageService` para encapsular operações do S3/MinIO via `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner`: inicialização de multipart upload, geração de URLs pré-assinadas para chunks (50 MB), finalização, abort e geração de URLs de download e streaming com suporte a Range requests e headers customizados.

**Technical actions:**

1. Criar `src/storage/storage.service.ts` — injetar `storageConfig` e instanciar `S3Client` com credenciais, endpoint, região e `forcePathStyle: true` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-04`).
2. Implementar `createMultipartUpload(key: string, contentType: string): Promise<string>` — executa `CreateMultipartUploadCommand` e retorna o `UploadId` (per `phase-03-videos/TD-02`).
3. Implementar `getPresignedPartUrls(key: string, uploadId: string, partCount: number): Promise<string[]>` — gera array de URLs pré-assinadas via `UploadPartCommand` + `getSignedUrl` (expiração de 2h) para cada parte sequencial (per `phase-03-videos/TD-02`).
4. Implementar `completeMultipartUpload(key: string, uploadId: string, parts: { PartNumber: number, ETag: string }[]): Promise<void>` — executa `CompleteMultipartUploadCommand` e `abortMultipartUpload(key: string, uploadId: string): Promise<void>` via `AbortMultipartUploadCommand` (per `phase-03-videos/TD-02`).
5. Implementar `getPresignedDownloadUrl(key: string, options?: { responseContentDisposition?: string, expiresIn?: number }): Promise<string>` — gera URL pré-assinada via `GetObjectCommand` + `getSignedUrl` com suporte a expiração (default 7200s) e header de Content-Disposition opcional (per `phase-03-videos/TD-04`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `storage.service.ts` | Unit: SDK command building, presigned URL options mapping | `src/storage/storage.service.spec.ts` |
| `storage.service.ts` | Integration: MinIO live multipart upload lifecycle, complete, and presigned GET | `src/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `createMultipartUpload` retorna um `UploadId` válido do bucket `streamtube-videos`.
- `getPresignedPartUrls` gera exatamente `N` URLs pré-assinadas válidas para upload direto de chunks no MinIO.
- `completeMultipartUpload` consolida as partes enviadas em um único objeto S3 na chave `uploads/{videoId}/original.mp4`.
- `getPresignedDownloadUrl` gera URL pré-assinada de leitura que permite streaming com Range Requests (HTTP 206) e download com Content-Disposition.

---

### SI-03.4 — Queue Module e Video Processing Worker Container Setup

**Description:** Configurar o módulo BullMQ (`VideoProcessingQueueModule`) para a fila `video-processing` com retry policy de backoff exponencial, criar a imagem Docker do worker com FFmpeg/FFprobe (`node:20-bookworm-slim`), configurar volume `/tmp/video-jobs` e criar o bootstrap isolado do worker.

**Technical actions:**

1. Criar `src/queue/video-processing-queue.module.ts` — registrar `BullModule.forRootAsync` injetando `queueConfig` com `maxRetriesPerRequest: null` e registrar a fila `video-processing` com `attempts: 3`, `backoff: { type: 'exponential', delay: 60000 }` e `removeOnFail: false` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-06`).
2. Criar `Dockerfile.worker` baseado em `node:20-bookworm-slim` com instalação de `ffmpeg` e `ffprobe` via `apt-get` e build da aplicação TypeScript (per `phase-03-videos/TD-03`).
3. Atualizar `nestjs-project/compose.yaml` — adicionar o serviço `video-worker` utilizando a imagem/Dockerfile do worker, conectando ao Redis e montando volume `worker-tmp` no caminho `/tmp/video-jobs` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`).
4. Criar `src/worker.ts` e `src/worker/worker-app.module.ts` — bootstrap do worker NestJS isolado da API HTTP, instanciando `WorkerAppModule` com os módulos de banco, queue e processamento de jobs (per `phase-03-videos/TD-03`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `video-processing-queue.module.ts` | Unit: BullMQ connection config, retry backoff options | `src/queue/video-processing-queue.module.spec.ts` |
| `worker-app.module.ts` | Unit: standalone worker module compilation | `src/worker/worker-app.module.spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `VideoProcessingQueueModule` registra a fila `video-processing` no Redis com 3 tentativas e backoff de 1 minuto.
- `Dockerfile.worker` compila imagem executável com `ffmpeg` e `ffprobe` disponíveis no `PATH`.
- Bootstrap do worker em `src/worker.ts` inicia o processo sem escutar em portas HTTP e se conecta com sucesso à fila BullMQ.

---

### SI-03.5 — Video Processing Processor (FFmpeg Worker Logic)

**Description:** Implementar o `VideoProcessingProcessor` que consome jobs da fila `video-processing`: realiza download local, extrai metadados (`duration`, `width`, `height`) via ffprobe, gera thumbnail via fluent-ffmpeg (a 10% da duração ou 1s), otimiza para FastStart MP4 (`-movflags +faststart`), faz upload dos assets gerados para o S3, atualiza o status para `ready` (ou captura erros fatais `INVALID_VIDEO_FILE` para `error` com `errorLog`) e limpa arquivos temporários.

**Technical actions:**

1. Criar `src/worker/processors/video-processing.processor.ts` com `@Processor('video-processing', { concurrency: 1 })` estendendo `WorkerHost` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`).
2. Implementar checagem de idempotência: verificar se o vídeo no banco está em status `processing` ou `draft` antes de processar; rejeitar execução duplicada (per `phase-03-videos/TD-06`).
3. Implementar download do vídeo bruto de `uploads/{videoId}/original.mp4` para `/tmp/video-jobs/{videoId}-raw.mp4` e execução de `ffprobe` para extrair metadados técnicos: `duration` (float segundos), `width` e `height` (inteiros) (per `phase-03-videos/TD-03`).
4. Implementar extração de thumbnail via `fluent-ffmpeg` gerando `/tmp/video-jobs/{videoId}-thumb.jpg` no timestamp de 10% da duração (com fallback para `00:00:01`), conversão FastStart MP4 (`-movflags +faststart`) gerando `/tmp/video-jobs/{videoId}-faststart.mp4`, upload dos assets para o MinIO/S3 (`uploads/{videoId}/thumbnail.jpg` e `uploads/{videoId}/original.mp4`), e atualização atômica no banco com metadados e `status: 'ready'` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`, `phase-03-videos/TD-06`).
5. Implementar tratamento de erros e limpeza: capturar falhas de parsing/transcoding do FFmpeg/FFprobe como erro fatal de domínio `INVALID_VIDEO_FILE` (lançando `UnrecoverableError` do BullMQ para evitar retries desnecessários), atualizar o vídeo para `status: 'error'` gravando o erro no campo `errorLog`, e em bloco `finally` deletar todos os arquivos temporários criados em `/tmp/video-jobs` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-06`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `video-processing.processor.ts` | Unit: orchestration, idempotency check, status transitions, UnrecoverableError on INVALID_VIDEO_FILE, finally cleanup | `src/worker/processors/video-processing.processor.spec.ts` |
| `video-processing.processor.ts` | Integration: live FFprobe and FFmpeg thumbnail extraction using sample mp4 fixture | `src/worker/processors/video-processing.processor.integration-spec.ts` |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- Job processado com vídeo válido atualiza o registro no banco para `status: 'ready'` com `duration`, `width`, `height` e `thumbnailKey` preenchidos.
- Thumbnail JPEG é gerada com sucesso e enviada para `uploads/{videoId}/thumbnail.jpg` no MinIO/S3.
- Arquivo MP4 final é reprocessado com atom moov no início do arquivo (`+faststart`).
- Arquivo corrompido ou formato não suportado transiciona o vídeo para `status: 'error'`, persiste o stack trace em `errorLog`, não dispara retries do BullMQ (`UnrecoverableError`) e mantém o job falho registrado para inspeção operacional (DLQ).
- Todos os arquivos temporários em `/tmp/video-jobs/` são removidos do disco após a conclusão ou falha do job.

---

### SI-03.6 — Videos Service (Upload, Multipart Initiation & Completion)

**Description:** Implementar a lógica de negócio central de vídeos em `VideosService`: criação de registro em `draft` com `publicId` (NanoID 12 caracteres com retry em colisão), inicialização de multipart upload (partes de 50 MB), validação de canal do usuário autenticado, conclusão do upload multipart com validação de status e enfileiramento de job na fila `video-processing`.

**Technical actions:**

1. Criar DTOs em `src/videos/dto/`: `CreateVideoDto` (`title`: string, `description`?: string, `fileName`: string, `sizeInBytes`: number) com decorators `class-validator` e `CompleteUploadDto` (`parts`: array de `{ PartNumber: number, ETag: string }`) (per API Contracts).
2. Criar exceções de domínio em `src/common/exceptions/`: `VideoNotFoundException` (404), `VideoNotInDraftException` (409), `ChannelNotFoundException` (403), `ForbiddenException` (403) (per Error Catalog).
3. Implementar `VideosService.createDraft(userId: string, dto: CreateVideoDto)`: verificar canal do usuário via repositório de canais (lançar `ChannelNotFoundException` se ausente); gerar `publicId` com `nanoid(12)` tratando eventual colisão de constraint única em loop; salvar registro `Video` com `status: 'draft'`, `storageKey: uploads/{videoId}/original.mp4`; calcular número de partes de 50 MB e invocar `StorageService.createMultipartUpload` e `StorageService.getPresignedPartUrls`; retornar `{ id, publicId, status: "draft", uploadId, partUrls }` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-05`, `phase-03-videos/TD-06`).
4. Implementar `VideosService.completeUpload(videoId: string, userId: string, dto: CompleteUploadDto)`: buscar vídeo por `id` com relation `channel`; validar se `video.channel.userId === userId` (lançar `ForbiddenException` se não); validar se `video.status === 'draft'` (lançar `VideoNotInDraftException` se não); invocar `StorageService.completeMultipartUpload`; atualizar atômica de status para `'processing'`; enfileirar job BullMQ na fila `video-processing` com payload `{ videoId: video.id, storageKey: video.storageKey }` e `jobId: video.id` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`, `phase-03-videos/TD-06`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `videos.service.ts` | Unit: createDraft validation, publicId collision retry, completeUpload status transitions, BullMQ job dispatch | `src/videos/videos.service.spec.ts` |
| `videos.service.ts` | Integration: DB persistence of draft state, channel ownership checks, transactional status update | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- Criação de draft com usuário sem canal retorna exceção com código `CHANNEL_NOT_FOUND` (HTTP 403).
- Criação de draft válida persiste entidade em `status = 'draft'` e retorna array de URLs pré-assinadas proporcional ao `sizeInBytes` (chunks de 50 MB).
- Tentativa de completar upload com usuário diferente do dono do canal retorna código `FORBIDDEN` (HTTP 403).
- Tentativa de completar upload para vídeo que não esteja em status `'draft'` retorna código `VIDEO_NOT_IN_DRAFT` (HTTP 409).
- Conclusão de upload válida atualiza status do vídeo para `'processing'` e insere exatamente um job na fila `video-processing` com `jobId = video.id`.

---

### SI-03.7 — Video Query Service (Public Lookup, Streaming & Download URL Generation)

**Description:** Implementar os métodos de consulta e consumo de vídeos no `VideosService`: busca pública de metadados por `publicId`, geração de URL pré-assinada para thumbnail e URLs pré-assinadas de streaming (HTTP Range) e download direto (Content-Disposition com nome do arquivo).

**Technical actions:**

1. Criar exceção de domínio `VideoNotReadyException` (409) em `src/common/exceptions/domain.exception.ts` (per Error Catalog).
2. Implementar `VideosService.findByPublicId(publicId: string)`: consultar vídeo por `publicId`; lançar `VideoNotFoundException` (404) se não encontrado; gerar URL pré-assinada temporária para `thumbnailKey` caso exista; retornar objeto com metadados do vídeo (`id`, `publicId`, `title`, `description`, `status`, `duration`, `width`, `height`, `thumbnailUrl`, `channelId`, `createdAt`) (per API Contracts, `phase-03-videos/TD-04`, `phase-03-videos/TD-05`).
3. Implementar `VideosService.getStreamUrl(publicId: string): Promise<string>`: consultar vídeo por `publicId` (lançar `VideoNotFoundException` se não encontrado); validar se `status === 'ready'` (lançar `VideoNotReadyException` se não); chamar `StorageService.getPresignedDownloadUrl(video.storageKey, { expiresIn: 7200 })` e retornar URL de streaming inline (per `phase-03-videos/TD-04`, `phase-03-videos/TD-06`).
4. Implementar `VideosService.getDownloadUrl(publicId: string): Promise<string>`: consultar vídeo por `publicId` (lançar `VideoNotFoundException` se não encontrado); validar se `status === 'ready'` (lançar `VideoNotReadyException` se não); sanitizar título e chamar `StorageService.getPresignedDownloadUrl(video.storageKey, { responseContentDisposition: 'attachment; filename="${encodedTitle}.mp4"' })` e retornar URL para download forçado (per `phase-03-videos/TD-04`, `phase-03-videos/TD-06`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `videos.service.ts` | Unit: findByPublicId, getStreamUrl and getDownloadUrl error branches and presigned URL options | `src/videos/videos-query.service.spec.ts` |
| `videos.service.ts` | Integration: publicId lookup and S3 signed URL generation with live MinIO | `src/videos/videos-query.service.integration-spec.ts` |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- Busca por `publicId` inexistente resulta em exceção com código `VIDEO_NOT_FOUND` (HTTP 404).
- Busca por `publicId` existente retorna metadados completos e URL de thumbnail pré-assinada quando disponível.
- Solicitação de streaming ou download para vídeo com status `'draft'`, `'processing'` ou `'error'` resulta em exceção `VIDEO_NOT_READY` (HTTP 409).
- Solicitação de streaming para vídeo em status `'ready'` retorna URL pré-assinada com validade de 2 horas.
- Solicitação de download para vídeo em status `'ready'` retorna URL pré-assinada contendo o header de `response-content-disposition` com o título do vídeo.

---

### SI-03.8 — Videos Controller (API Endpoints & Routing)

**Route:** `POST /videos`, `POST /videos/:id/upload/complete`, `GET /videos/:publicId`, `GET /videos/:publicId/stream`, `GET /videos/:publicId/download`
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Bearer {accessToken} (`POST /videos`, `POST /videos/:id/upload/complete`); Anonymous/Public (`GET /videos/:publicId`, `GET /videos/:publicId/stream`, `GET /videos/:publicId/download`)

**Description:** Expor os endpoints REST de gerenciamento do ciclo de upload de vídeos e consumo público no `VideosController`, aplicando guards de autenticação JWT, validação de payload via DTOs e redirecionamentos HTTP 302 para URLs pré-assinadas de streaming e download.

**Technical actions:**

1. Criar `src/videos/videos.controller.ts` com prefixo `@Controller('videos')` e injetar `VideosService` (per API Contracts).
2. Implementar `POST /videos` com `@UseGuards(JwtAuthGuard)`: receber `@Body() dto: CreateVideoDto`, obter `userId` de `@CurrentUser()`, invocar `VideosService.createDraft` e retornar status `201` com `id`, `publicId`, `status`, `uploadId` e `partUrls` (per API Contracts).
3. Implementar `POST /videos/:id/upload/complete` com `@UseGuards(JwtAuthGuard)`: receber `@Param('id') id: string` e `@Body() dto: CompleteUploadDto`, invocar `VideosService.completeUpload` e retornar status `200` com `id`, `publicId` e `status: "processing"` (per API Contracts).
4. Implementar `GET /videos/:publicId`: rota pública, receber `@Param('publicId') publicId: string`, invocar `VideosService.findByPublicId` e retornar status `200` com os metadados do vídeo (per API Contracts).
5. Implementar `GET /videos/:publicId/stream` e `GET /videos/:publicId/download`: rotas públicas, invocar `VideosService.getStreamUrl` e `VideosService.getDownloadUrl` respectivamente e retornar `@Redirect(url, 302)` para a URL pré-assinada correspondente (per API Contracts, `phase-03-videos/TD-04`).

**Tests:** _(empty — Controller is E2E-only per testing guide; E2E scenarios authored in /plan-test-specs)_

**Dependencies:** SI-03.6, SI-03.7

**Acceptance criteria:**

- `POST /videos` sem token JWT retorna status `401 UNAUTHORIZED`.
- `POST /videos` com payload válido retorna status `201 Created` com `id`, `publicId`, `status: "draft"`, `uploadId` e `partUrls`.
- `POST /videos/:id/upload/complete` com partes válidas retorna status `200 OK` com `status: "processing"`.
- `GET /videos/:publicId` para vídeo existente retorna status `200 OK` com metadados e URL de thumbnail.
- `GET /videos/:publicId/stream` para vídeo pronto retorna status `302 Found` com header `Location` direcionando para streaming via S3.
- `GET /videos/:publicId/download` para vídeo pronto retorna status `302 Found` com header `Location` direcionando para download forçado.

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid (v7) | PK, generated |
| publicId | varchar(12) | unique, not null, immutable (per `phase-03-videos/TD-05`) |
| title | varchar(255) | not null |
| description | text | nullable |
| status | enum('draft', 'processing', 'ready', 'error') | not null, default 'draft' (per `phase-03-videos/TD-06`) |
| storageKey | varchar(512) | not null — `uploads/{id}/original.mp4` (per `phase-03-videos/TD-02`) |
| thumbnailKey | varchar(512) | nullable — `uploads/{id}/thumbnail.jpg` (per `phase-03-videos/TD-03`) |
| duration | float | nullable — seconds, extracted by ffprobe (per `phase-03-videos/TD-03`) |
| width | integer | nullable — pixels, extracted by ffprobe (per `phase-03-videos/TD-03`) |
| height | integer | nullable — pixels, extracted by ffprobe (per `phase-03-videos/TD-03`) |
| sizeInBytes | bigint | nullable |
| errorLog | text | nullable — diagnosis persisted on error state (per `phase-03-videos/TD-06`) |
| channelId | uuid | FK → Channel(id), not null |
| createdAt | timestamptz | default now() |
| updatedAt | timestamptz | default now(), on update |

**Relations:** `Video` belongs to `Channel` (many-to-one); `Channel` has many `Video` (one-to-many)
**Indexes:** unique on `publicId`; index on `channelId`; index on `status`

### API Contracts

#### POST /videos (SI-03.6, SI-03.8)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {accessToken}

**Request body:**
- title: string, required
- description: string, optional
- fileName: string, required — original file name
- sizeInBytes: number, required — total file size in bytes

**Response 201:**
- id: string (uuid v7)
- publicId: string (12-char NanoID)
- status: "draft"
- uploadId: string — S3 multipart upload ID (per `phase-03-videos/TD-02`)
- partUrls: string[] — array of presigned URLs for each 50 MB chunk (per `phase-03-videos/TD-02`)

**Error responses:**
- 401 UNAUTHORIZED: missing or invalid access token
- 403 CHANNEL_NOT_FOUND: authenticated user has no channel
- 400 validation error: when the request body fails schema validation

---

#### POST /videos/:id/upload/complete (SI-03.6, SI-03.8)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {accessToken}

**Request body:**
- parts: array of `{ PartNumber: number, ETag: string }`, required (per `phase-03-videos/TD-02`)

**Response 200:**
- id: string (uuid v7)
- publicId: string
- status: "processing"

**Error responses:**
- 401 UNAUTHORIZED: missing or invalid access token
- 403 FORBIDDEN: authenticated user is not the channel owner of this video
- 404 VIDEO_NOT_FOUND: video does not exist
- 409 VIDEO_NOT_IN_DRAFT: video status is not 'draft'
- 400 validation error: invalid or empty parts array

---

#### GET /videos/:publicId (SI-03.7, SI-03.8)

**Request headers:**
- _(none required — public endpoint)_

**Response 200:**
- id: string (uuid v7)
- publicId: string
- title: string
- description: string | null
- status: string
- duration: number | null
- width: number | null
- height: number | null
- thumbnailUrl: string | null — presigned URL to thumbnail (per `phase-03-videos/TD-04`)
- channelId: string (uuid)
- createdAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: video with given publicId does not exist

---

#### GET /videos/:publicId/stream (SI-03.7, SI-03.8)

**Request headers:**
- Authorization: _(optional — public endpoint)_

**Response 302:**
- Redirect to short-lived presigned URL (2-hour expiration) for inline video player playback with HTTP Range support (per `phase-03-videos/TD-04`)

**Error responses:**
- 404 VIDEO_NOT_FOUND: video does not exist
- 409 VIDEO_NOT_READY: video status is not 'ready'

---

#### GET /videos/:publicId/download (SI-03.7, SI-03.8)

**Request headers:**
- Authorization: _(optional — public endpoint)_

**Response 302:**
- Redirect to short-lived presigned URL with `response-content-disposition=attachment; filename="{title}.mp4"` to force local file download (per `phase-03-videos/TD-04`)

**Error responses:**
- 404 VIDEO_NOT_FOUND: video does not exist
- 409 VIDEO_NOT_READY: video status is not 'ready'

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Channel Owner |
|----------|-----------|---------------|---------------|
| POST /videos | ✗ | ✗ | ✓ (own channel) |
| POST /videos/:id/upload/complete | ✗ | ✗ | ✓ (own video) |
| GET /videos/:publicId | ✓ | ✓ | ✓ |
| GET /videos/:publicId/stream | ✓ | ✓ | ✓ |
| GET /videos/:publicId/download | ✓ | ✓ | ✓ |

### Error Catalog

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | Vídeo não existe (busca por id ou publicId) |
| VIDEO_NOT_IN_DRAFT | 409 | Tentativa de completar upload de vídeo que não está em status 'draft' (per `phase-03-videos/TD-06`) |
| VIDEO_NOT_READY | 409 | Tentativa de stream/download de vídeo que não está em status 'ready' (per `phase-03-videos/TD-06`) |
| CHANNEL_NOT_FOUND | 403 | Usuário autenticado não possui canal |
| FORBIDDEN | 403 | Usuário autenticado não é dono do canal/vídeo |
| INVALID_VIDEO_FILE | — (worker-internal) | Arquivo de vídeo corrompido ou formato inválido — falha fatal sem retry; persistido em `errorLog` (per `phase-03-videos/TD-03`) |
| VIDEO_PROCESSING_FAILED | — (worker-internal) | Processamento do vídeo falhou após esgotar retries; persistido em `errorLog` para observabilidade via DLQ (per `phase-03-videos/TD-06`) |

> _Nota: Códigos com `— (worker-internal)` (`INVALID_VIDEO_FILE`, `VIDEO_PROCESSING_FAILED`) são de uso exclusivo interno do worker assíncrono/BullMQ para transição de estado (`status: 'error'`), log diagnóstico em `errorLog` e roteamento de retry/DLQ. Nenhum endpoint HTTP síncrono retorna esses códigos diretamente no envelope HTTP._

### Events/Messages

#### video-processing (BullMQ queue)

**Payload:**

```json
{ "videoId": "string (uuid v7)", "storageKey": "string (uploads/{videoId}/original.mp4)" }
```

**Producer:** `VideosService` — dispatches job after `CompleteMultipartUpload` success (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`)
**Consumer:** `VideoProcessingProcessor` — separate NestJS worker container (per `phase-03-videos/TD-03`)
**Trigger:** upload completion confirmed via `POST /videos/:id/upload/complete`
**Delivery semantics:** at-least-once with idempotency check — worker verifies database status before irreversible steps; `jobId: videoId` prevents duplicate enqueue (per `phase-03-videos/TD-06`)
**Retry policy:** 3 attempts, exponential backoff (1-minute initial delay); fatal `INVALID_VIDEO_FILE` errors fail immediately without retry (per `phase-03-videos/TD-06`)
**DLQ:** failed jobs preserved in BullMQ (`removeOnFail: false`) for operational inspection (per `phase-03-videos/TD-06`)

---

<!-- phase-a-complete -->

## Dependency Map

SI-03.1 (root: Dependencies, Config Namespaces e Docker Compose)
├── SI-03.2 — depends on SI-03.1 (Video Entity e Migration)
├── SI-03.3 — depends on SI-03.1 (Storage Service MinIO/S3)
├── SI-03.4 — depends on SI-03.1 (Queue Module e Video Worker Container)
├── SI-03.5 — depends on SI-03.2, SI-03.3, SI-03.4 (Video Processing Processor)
├── SI-03.6 — depends on SI-03.2, SI-03.3, SI-03.4 (Videos Service - Draft & Complete Upload)
├── SI-03.7 — depends on SI-03.2, SI-03.3 (Video Query Service - Lookup, Stream & Download URLs)
└── SI-03.8 — depends on SI-03.6, SI-03.7 (Videos Controller - Endpoints & Routing)

---

## Deliverables

- [ ] SI-03.1 — Dependencies, Configuration Namespaces e MinIO/Redis Infrastructure
- [ ] SI-03.2 — Video Entity e Database Migration
- [ ] SI-03.3 — Storage Service (MinIO/S3 Multipart Upload & Presigned URLs)
- [ ] SI-03.4 — Queue Module e Video Processing Worker Container Setup
- [ ] SI-03.5 — Video Processing Processor (FFmpeg Worker Logic)
- [ ] SI-03.6 — Videos Service (Upload, Multipart Initiation & Completion)
- [ ] SI-03.7 — Video Query Service (Public Lookup, Streaming & Download URL Generation)
- [ ] SI-03.8 — Videos Controller (API Endpoints & Routing)

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && npm test && npm run test:integration`)
  - **DoD Exception:** `video-processing.processor.integration-spec.ts` must be executed strictly inside the `video-worker` container (`docker compose exec video-worker npm test`) as it explicitly requires FFmpeg. It will naturally fail in `nestjs-api`.
- [ ] E2E tests pass (`cd nestjs-project && npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && npm run build`)

