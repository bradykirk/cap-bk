# Self-Hosted Customizations

This document tracks all customizations made to this fork for self-hosted deployment.

## Overview

This fork (`bradykirk/cap-bk`) is based on the upstream Cap repository (`CapSoftware/Cap`) with modifications for self-hosted environments using Coolify and Cloudflare.

The `self-hosted` branch is the deploy branch: every push builds and publishes `ghcr.io/bradykirk/cap-web:latest` to GHCR (see `.github/workflows/docker-publish.yml`). That image is what the self-hosted deployment runs.

**Last synced with upstream `CapSoftware/Cap`:** 2026-10-07 (`d327051c1`)

## Active Customizations

These changes live only in the `cap-web` image (the web app). Each was re-verified against current upstream during the 2026-10-07 sync.

### 1. Deepgram Transcription Provider

**Files:** `apps/web/lib/deepgram.ts`, `apps/web/lib/transcription-provider.ts`, `apps/web/workflows/transcribe.ts`, `packages/env/server.ts`, plus the caller gates in `apps/web/lib/transcribe.ts`, `apps/web/actions/videos/get-status.ts`, `apps/web/app/s/[videoId]/page.tsx`, `apps/web/workflows/finalize-desktop-recording.ts`

**Description:** Upstream transcribes only with AssemblyAI (`ASSEMBLY_API_KEY`). This deployment uses Deepgram (`DEEPGRAM_API_KEY`, model `nova-3`). Deepgram runs inside upstream's own transcription workflow: the two AssemblyAI steps branch on `getTranscriptionProvider()`, and `deepgramToEditResult` converts Deepgram words (seconds) to the AssemblyAI word shape (milliseconds). The result goes through the same `createEditTranscript` pipeline, so captions, the encrypted edit transcript, transcript editing, and backfill all work. AssemblyAI wins when both keys are set. Every upstream `ASSEMBLY_API_KEY` transcription gate is replaced with `isTranscriptionConfigured()`. Live transcription stays AssemblyAI-only and skips cleanly without that key.

**On each sync:** `git grep -n ASSEMBLY_API_KEY -- apps/web` and route any new transcription gate through `isTranscriptionConfigured()`; check that both AssemblyAI steps in `workflows/transcribe.ts` still have the Deepgram branch.

**History:** Earlier syncs bypassed the `workflow` package entirely (fire-and-forget Deepgram and AI code in `lib/transcribe.ts` / `lib/generate-ai.ts`) because of an ArrayBuffer serialization bug in `workflow@4.0.1-beta.42` local world. Upstream now pins `workflow@4.6.0`, so the 2026-10-07 sync removed both bypasses. If transcription or AI generation fails in local world again, restore an in-process path on top of the provider branch rather than reverting it.

### 2. AI Generation Options

**Files:** `apps/web/lib/ai/provider.ts`, `apps/web/lib/generate-ai.ts`, `apps/web/workflows/generate-ai.ts`, `apps/web/app/api/videos/[videoId]/retry-ai/route.ts`, `apps/web/lib/ai-transcript.ts`

**Description:** The OpenAI provider honours `OPENAI_BASE_URL`. `startAiGeneration` and the AI workflow accept `force` so `retry-ai?force=true` can regenerate a completed video (manual summary/chapter edits stay protected by `setGeneratedAiContent`). Upstream fixed the hallucinated-chapter root cause itself (timestamped prompt + `clampChapters`); `sanitizeChapters` remains only as a render guard on the share and embed pages for chapters stored before that fix. It drops invalid and out-of-range entries but keeps close owner edits.

**Required Environment Variables:** `GROQ_API_KEY` (first in auto-detect) or `OPENAI_API_KEY`, or the upstream `AI_PROVIDER` / `AI_MODEL` / `AI_BASE_URL` settings.

### 3. Cloudflare / Custom Geo-location Header Fallbacks

**File:** `apps/web/app/api/analytics/track/route.ts`

**Description:** Upstream reads only Vercel geo headers. Added fallbacks so self-hosted deployments behind Cloudflare (or a custom proxy) still resolve geo data. Upstream's `decodeUrlEncodedHeaderValue` handling for the city is preserved.

**Header precedence:**
- Country: `x-vercel-ip-country` → `cf-ipcountry` → `x-geo-country`
- Region: `x-vercel-ip-country-region` → `x-geo-region`
- City: `x-vercel-ip-city` → `x-geo-city`

### 4. FFmpeg in Docker Image + Node Version

**File:** `apps/web/Dockerfile`

**Description:** Added `apk add --no-cache ffmpeg` to the runner stage. FFmpeg is required for detecting and extracting audio tracks during transcription; without it, videos report "No audio track detected". The base image follows upstream (`node:24-alpine` with a Bun 1.4.0 build stage); the old `node:22-alpine` pin was dropped in the 2026-10-07 sync.

### 5. Docker Publish Workflow

**File:** `.github/workflows/docker-publish.yml`

**Description:** GitHub Actions workflow that builds and publishes the Docker image to GHCR on every push to `self-hosted`. It runs `bun run typecheck` and the self-hosted unit tests (blocking) before the build; the full test suite is advisory.

### 6. Folder Color / Rive Race-Condition Fixes

**Files:**
- `apps/web/app/(org)/dashboard/caps/components/Folders.tsx`
- `apps/web/app/(org)/dashboard/caps/components/NewFolderDialog.tsx`
- `apps/web/app/(org)/dashboard/folder/[id]/components/SubfolderDialog.tsx`

**Description:** Fixes folder color rendering (direct Rive `src` loading) and a New Folder / Subfolder dialog crash caused by a Rive animation race condition. Upstream has not changed these files, so the fixes are carried forward verbatim.

### 7. View Tracking And Transcription Loading Timeout

**Files:** `apps/web/lib/track-video-view.ts`, `apps/web/app/s/[videoId]/Share.tsx`, `apps/web/app/embed/[videoId]/_components/EmbedVideo.tsx`, `apps/web/actions/videos/get-analytics.ts`, `apps/web/app/(org)/dashboard/analytics/data.ts`, `packages/web-backend/src/Videos/index.ts`

**Description:** The view tracker is shared by the share page and the embed player (upstream tracks only the share page). Embed hits are stored under `/embed/<id>`, so every view count (share page, dashboard cards, mobile/API, analytics reports, Top Caps) also reads that path and folds it into `/s/<id>` with `replaceRegexpOne`. The share page stops showing the AI loading state after 5 minutes when transcription never starts.

### 8. Rive Assets Excluded From The Proxy

**File:** `apps/web/proxy.ts`

**Description:** `proxy.ts` (formerly `middleware.ts`, renamed in Next.js 16) rewrites requests for custom-domain routing. Its matcher must exclude `rive`, or `/rive/*` returns HTML instead of the asset and every folder icon and colour renders blank. Symptom: `WebAssembly.instantiate(): expected magic word 00 61 73 6d, found 3c 21 44 4f`.

**On each sync:** verify `rive` is still present in the matcher's negative lookahead, and check whether the file has been renamed again.

### 9. Self-Hosted Rive WASM Must Match The Installed Runtime

**File:** `apps/web/public/rive/rive.wasm`

**Description:** `apps/web/lib/rive.ts` pins `RuntimeLoader.setWasmUrl("/rive/rive.wasm")`, but `apps/web/package.json` floats `@rive-app/react-canvas` on a caret range. When the lockfile resolves a newer runtime, the committed binary no longer matches the JS glue and Rive fails to initialise.

**On each sync:** re-copy the binary from the resolved package.

```bash
cp "$(dirname "$(cd apps/web && node -p "require.resolve('@rive-app/canvas/package.json', { paths: [require.resolve('@rive-app/react-canvas')] })")")/rive.wasm" apps/web/public/rive/rive.wasm
```

## Deploying

Before the first deploy of the 2026-10-07 sync: back up the database (migrations `0037`–`0049` run at startup and are forward-only), then run the image against a copy of that database with `DEEPGRAM_API_KEY` set and `ASSEMBLY_API_KEY` unset. Record one video and confirm transcription completes, captions show, the transcript editor opens, and the AI summary and chapters appear.

1. Apply database migrations **before** the new image goes live. The app runs Drizzle migrations at startup; they are journal-based, so never apply migration SQL by hand — doing so desyncs `__drizzle_migrations` and every subsequent boot fails with `ER_DUP_KEYNAME` or similar.
2. Push to `self-hosted`. The workflow typechecks, then builds and publishes `ghcr.io/bradykirk/cap-web:latest`.
3. Redeploy the app in Coolify to pull the new image.

## Customizations Removed During 2026-05-29 Sync

These earlier customizations were dropped because upstream has since adopted equivalent fixes, or the code they patched no longer exists:

- **`apps/web/lib/audio-extract.ts`** (FFmpeg path resolution) — upstream now includes `/usr/bin/ffmpeg` in its candidate paths and logs when FFmpeg is missing.
- ~~**`apps/web/middleware.ts`** (`rive` matcher exclusion) — the middleware file was removed upstream, so the exclusion is moot.~~ **Wrong.** Next.js 16 renamed `middleware.ts` to `proxy.ts`; the interception returned under a new filename and broke all Rive graphics on custom domains. Re-applied — see customization 7.
- **`apps/web/app/s/[videoId]/_components/CapVideoPlayer.tsx`** (thumbnail error fix) — upstream now guards thumbnails with `supportsCrossOrigin` and no longer uses the `placeholder.pics` error image.
- **`packages/database/emails/config.ts`** (`replyTo`) — upstream now uses the camelCase `replyTo` key.
- **Desktop / Rust adaptations** (`CameraSelect.tsx`, `in-progress-recording.tsx`, `window-capture-occluder.tsx`, `crates/cap-test/.../recording.rs`) — these were one-off adaptations to in-flight upstream API changes at the original fork point. They do not ship in the `cap-web` image and the relevant APIs have since changed upstream.

## Branch Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Tracks upstream `CapSoftware/Cap` |
| `self-hosted` | Customizations for self-hosted deployment; builds `ghcr.io/bradykirk/cap-web:latest` |

> **Footgun:** `main`'s own `docker-publish.yml` triggers on push to `main` and publishes the **same** `:latest` tag — but without these customizations. Never `git push origin main` while it carries that trigger, or it will overwrite the self-hosted image with a vanilla build.

## Syncing With Upstream (Clean Re-Apply)

Because the customizations are few and well-scoped, the cleanest sync is to rebase the deploy branch onto a fresh upstream snapshot and re-apply only what is still needed.

```bash
# One-time: add the public repo as a remote
git remote add upstream https://github.com/CapSoftware/Cap.git

# Each sync:
git fetch upstream
git checkout main
git reset --hard upstream/main        # main mirrors upstream

# Re-apply customizations onto fresh upstream (verify each is still needed).
# Files where upstream is unchanged can be copied verbatim:
#   git checkout self-hosted -- <file>
# transcribe.ts needs a 3-way merge against upstream's videoUploads guard.

# Verify the image builds before publishing:
docker build -f apps/web/Dockerfile -t cap-web:sync-test .

# Only after a green build:
git push --force-with-lease origin self-hosted   # triggers the GHCR :latest rebuild
```

## Environment Variables

Required for self-hosted deployment:

```
# S3/MinIO Storage
CAP_AWS_BUCKET=your-bucket
CAP_AWS_REGION=us-east-1
CAP_AWS_ACCESS_KEY=your-key
CAP_AWS_SECRET_KEY=your-secret
CAP_AWS_ENDPOINT=http://minio:9000

# Transcription (Deepgram; ASSEMBLY_API_KEY takes priority if set)
DEEPGRAM_API_KEY=your-deepgram-key

# AI Generation
GROQ_API_KEY=your-groq-key
OPENAI_API_KEY=your-openai-key

# Database
DATABASE_URL=mysql://...

# Auth
NEXTAUTH_SECRET=your-secret
NEXTAUTH_URL=https://your-domain.com
```

## Cloudflare Worker (Optional)

If using Cloudflare for geo-location, deploy this worker:

```javascript
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const newHeaders = new Headers(request.headers);

    newHeaders.set('x-geo-country', request.cf?.country || '');
    newHeaders.set('x-geo-region', request.cf?.region || '');
    newHeaders.set('x-geo-city', request.cf?.city || '');

    const modifiedRequest = new Request(url, {
      method: request.method,
      headers: newHeaders,
      body: request.body,
    });

    return fetch(modifiedRequest);
  },
};
```
