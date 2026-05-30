# Self-Hosted Customizations

This document tracks all customizations made to this fork for self-hosted deployment.

## Overview

This fork (`bradykirk/cap-bk`) is based on the upstream Cap repository (`CapSoftware/Cap`) with modifications for self-hosted environments using Coolify and Cloudflare.

The `self-hosted` branch is the deploy branch: every push builds and publishes `ghcr.io/bradykirk/cap-web:latest` to GHCR (see `.github/workflows/docker-publish.yml`). That image is what the self-hosted deployment runs.

**Last synced with upstream `CapSoftware/Cap`:** 2026-05-29

## Active Customizations

These changes live only in the `cap-web` image (the web app). Each was re-verified against current upstream during the 2026-05-29 sync.

### 1. Transcription Workflow Bypass

**File:** `apps/web/lib/transcribe.ts`

**Description:** Bypassed the Vercel `workflow` package, which has an ArrayBuffer serialization bug in "local world" mode (when `WORKFLOWS_RPC_URL` is not configured). This caused transcription to fail in self-hosted Docker deployments. Replaced the workflow trigger with a direct Deepgram integration using a fire-and-forget async pattern. Upstream's `videoUploads` phase guard (skip while an upload is still in progress) is preserved.

### 2. AI Generation Workflow Bypass

**File:** `apps/web/lib/generate-ai.ts`

**Description:** Same fix as transcription — bypassed the `workflow` package for AI summary generation, moving all generation logic directly into the file with a fire-and-forget pattern.

**Required Environment Variables:**
- `GROQ_API_KEY` (preferred — faster and has a free tier)
- `OPENAI_API_KEY` (fallback if Groq is not set)

### 3. Cloudflare / Custom Geo-location Header Fallbacks

**File:** `apps/web/app/api/analytics/track/route.ts`

**Description:** Upstream reads only Vercel geo headers. Added fallbacks so self-hosted deployments behind Cloudflare (or a custom proxy) still resolve geo data. Upstream's `decodeUrlEncodedHeaderValue` handling for the city is preserved.

**Header precedence:**
- Country: `x-vercel-ip-country` → `cf-ipcountry` → `x-geo-country`
- Region: `x-vercel-ip-country-region` → `x-geo-region`
- City: `x-vercel-ip-city` → `x-geo-city`

### 4. FFmpeg in Docker Image + Node Version

**File:** `apps/web/Dockerfile`

**Description:** Added `apk add --no-cache ffmpeg` to the runner stage. FFmpeg is required for detecting and extracting audio tracks during transcription; without it, videos report "No audio track detected". Pinned the base image to `node:22-alpine` (the known-good version for this deployment) rather than upstream's `node:24-alpine`.

### 5. Docker Publish Workflow

**File:** `.github/workflows/docker-publish.yml`

**Description:** GitHub Actions workflow that builds and publishes the Docker image to GHCR on every push to `self-hosted`. This file does not exist upstream.

### 6. Folder Color / Rive Race-Condition Fixes

**Files:**
- `apps/web/app/(org)/dashboard/caps/components/Folders.tsx`
- `apps/web/app/(org)/dashboard/caps/components/NewFolderDialog.tsx`
- `apps/web/app/(org)/dashboard/folder/[id]/components/SubfolderDialog.tsx`

**Description:** Fixes folder color rendering (direct Rive `src` loading) and a New Folder / Subfolder dialog crash caused by a Rive animation race condition. Upstream has not changed these files, so the fixes are carried forward verbatim.

## Customizations Removed During 2026-05-29 Sync

These earlier customizations were dropped because upstream has since adopted equivalent fixes, or the code they patched no longer exists:

- **`apps/web/lib/audio-extract.ts`** (FFmpeg path resolution) — upstream now includes `/usr/bin/ffmpeg` in its candidate paths and logs when FFmpeg is missing.
- **`apps/web/middleware.ts`** (`rive` matcher exclusion) — the middleware file was removed upstream, so the exclusion is moot.
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

# Transcription
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
