# Cloudflare R2 Video Upload + Download App

This project provides:

- A React frontend to pick, upload, list, and download videos.
- A Cloudflare Worker API that handles upload/list/download using R2 bucket binding.
- No local Node backend is required for the Cloudflare path.

## 1) Prerequisites

- Node.js 20+
- Cloudflare account with R2 enabled
- An R2 bucket
- `wrangler` login access to your Cloudflare account

## 2) Configure Cloudflare Worker + R2 Bucket Binding

Update `worker/wrangler.toml`:

```toml
[vars]
ALLOWED_ORIGIN = "http://localhost:5173"

[[r2_buckets]]
binding = "VIDEOS_BUCKET"
bucket_name = "your-r2-bucket-name"
preview_bucket_name = "your-r2-bucket-name"
```

> Security note: if credentials were shared in chat/email, rotate them in Cloudflare before using this project.

### R2 bucket CORS configuration

```json
[
  {
	"AllowedOrigins": [
	  "http://localhost:5173"
	],
	"AllowedMethods": [
	  "GET",
	  "PUT",
	  "HEAD"
	],
	"AllowedHeaders": [
	  "*"
	],
	"ExposeHeaders": [
	  "ETag"
	],
	"MaxAgeSeconds": 3600
  }
]
```

## 3) Install

```bash
npm install
```

## 4) Login Wrangler Once

```bash
npx wrangler login
```

## 5) Run the app (2 terminals)

Terminal 1 (Cloudflare Worker API):

```bash
npm run worker:dev
```

Terminal 2 (React app):

```bash
npm run dev
```

Open `http://localhost:5173`.

## 6) Deploy Worker API

```bash
npm run worker:deploy
```

After deploy, set frontend API base URL:

```dotenv
VITE_API_BASE_URL=https://your-worker-subdomain.workers.dev
```

Rebuild frontend after setting `VITE_API_BASE_URL`.

## 7) Tiny test harness

Check worker health endpoint:

```bash
curl http://127.0.0.1:8787/api/health
```

Expected response:

```json
{"ok":true,"service":"cloudflare-worker-r2"}
```

Check list endpoint:

```bash
curl http://127.0.0.1:8787/api/videos
```

Expected response shape:

```json
{"videos":[]}
```

Or run the bundled smoke test:

```bash
npm run worker:smoke
```

## Optional: Legacy Node API

If you still want to run the old Express-based API, use:

```bash
npm run server
```

For Vite proxy to legacy Node API, add:

```dotenv
VITE_PROXY_TARGET=http://localhost:4000
```

### Dev vs Production API URL

- In local development, frontend uses Vite proxy (`/api` -> `http://127.0.0.1:8787`).
- In production, set `VITE_API_BASE_URL` so frontend calls deployed Worker API.

Example `.env` for frontend build/deploy:

```dotenv
VITE_API_BASE_URL=https://your-api-domain.com
```

The Worker API handles upload/list/download and stores videos in your R2 bucket via binding.

## Project Structure

- `worker/src/index.js` - Cloudflare Worker API + R2 logic
- `worker/wrangler.toml` - Worker and R2 binding config
- `server/index.js` - Optional legacy Express API
- `src/App.jsx` - Upload/download UI
- `vite.config.js` - Proxies `/api` to Worker locally in development

## Troubleshooting

### Port 5173 already in use

Vite will automatically use 5174, 5175, etc. You'll see it in the output.

### "ECONNREFUSED 127.0.0.1:8787"

The Worker dev server is not running. Start it in Terminal 1:

```bash
npm run worker:dev
```

### "Unauthorized" or "auth" error when running `npm run worker:dev`

You need to authenticate with Cloudflare:

```bash
npx wrangler login
```

A browser window opens. Approve the login and return to the terminal.

### R2 bucket binding error in Worker

Ensure `worker/wrangler.toml` has the correct bucket name:

```toml
[[r2_buckets]]
binding = "VIDEOS_BUCKET"
bucket_name = "movieui"
preview_bucket_name = "movieui"
```

### "Only video uploads are allowed"

The file content-type must start with `video/`. Common types:

- `video/mp4` (MP4)
- `video/quicktime` (MOV)
- `video/x-msvideo` (AVI)
- `video/webm` (WebM)

### Videos don't appear in list after upload

1. Check Cloudflare Dashboard → R2 → `movieui` bucket directly
2. Run system verification:
   ```bash
   npm run verify
   ```
3. Check browser DevTools Console for CORS or network errors
4. Ensure Worker is still running in Terminal 1

### CORS errors (blocked by browser)

Ensure `ALLOWED_ORIGIN` in `worker/wrangler.toml` matches your frontend URL:

```toml
[vars]
ALLOWED_ORIGIN = "http://localhost:5173"
```

(Or whatever port Vite is using.)

## Quick Verification

After both servers are running, verify everything:

```bash
npm run verify
```

This tests:
- Worker health endpoint
- R2 list endpoint
- Upload URL generation
- CORS headers

