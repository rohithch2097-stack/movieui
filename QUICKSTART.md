# Quick Start Guide - Video Upload to Cloudflare R2

This guide will get your video upload app running in under 5 minutes.

## Prerequisites

You need:
- Node.js 18+ (check: `node --version`)
- A Cloudflare account with R2 enabled
- Your R2 bucket name: `movieui`
- Your Account ID: `577a1c11c46c1edf27c9f3243acc797a`

## Step 1: Authenticate with Cloudflare

```powershell
npx wrangler login
```

This opens a browser tab. Approve the login and return to the terminal.

## Step 2: Start Cloudflare Worker API (Terminal 1)

```powershell
Set-Location "C:\Users\yaswa\OneDrive\Desktop\movie-ui"
npm run worker:dev
```

Wait for output like:
```
⛅️ Listening on http://127.0.0.1:8787
```

**Keep this terminal open.**

## Step 3: Start React Frontend (Terminal 2)

```powershell
Set-Location "C:\Users\yaswa\OneDrive\Desktop\movie-ui"
npm run dev
```

Open `http://localhost:5173/` in your browser.

## Step 4: Test Upload

1. Pick a video file
2. Click "Upload to R2"
3. Wait for "Upload completed successfully"
4. Refresh to see it in the list

## Testing Without Frontend

To test the Worker API directly (while it's running):

```powershell
# Check health
curl http://127.0.0.1:8787/api/health

# List videos
curl http://127.0.0.1:8787/api/videos

# Run smoke test
npm run worker:smoke
```

## Troubleshooting

### "ECONNREFUSED 127.0.0.1:8787"
- Make sure Terminal 1 is running `npm run worker:dev`
- Check port 8787 isn't blocked by firewall

### "auth" or "login" errors
- Run `npx wrangler login` again
- Make sure your Cloudflare account has R2 enabled
- Check your bucket name in `worker/wrangler.toml` matches your R2 bucket

### Videos don't appear after upload
- Check Cloudflare R2 bucket `movieui` via Dashboard
- Verify Worker has bind permissions in `wrangler.toml`
- Check browser console for CORS errors

## Additional Commands

```bash
# Build frontend only
npm run build

# Lint frontend code
npm run lint

# Deploy Worker to production
npm run worker:deploy

# Test Worker endpoints
npm run worker:smoke
```

## What's Happening

1. **Frontend (React)** at `http://localhost:5173` renders the UI
2. **Vite dev proxy** forwards `/api/*` to Worker at `http://127.0.0.1:8787`
3. **Worker** at port 8787 signs upload URLs and manages R2 bucket operations
4. **Browser** uploads directly to R2 using signed URLs (no data through Worker)
5. **R2 bucket** `movieui` stores all videos

No secret keys are exposed to the browser — only signed upload URLs.

## Deployed Setup

When you deploy:

1. Deploy Worker: `npm run worker:deploy`
2. Get Worker URL (e.g., `https://my-api.username.workers.dev`)
3. For production builds, set: `VITE_API_BASE_URL=https://my-api.username.workers.dev`
4. Build and deploy frontend

