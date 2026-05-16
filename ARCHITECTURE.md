# Architecture Overview

## How Video Upload Works

### Local Development Setup

```
┌─────────────────────────────────────────────────────────────────┐
│                         YOUR COMPUTER                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Terminal 1: Cloudflare Worker (Port 8787)                     │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ npm run worker:dev                                         │ │
│  │ Runs: worker/src/index.js                                │ │
│  │ Listens on: http://127.0.0.1:8787                        │ │
│  └────────────────────────────────────────────────────────────┘ │
│                           ↑                                       │
│                           │ /api/videos/upload-url               │
│                           │ /api/videos                          │
│                           │ /api/videos/upload/:key              │
│                           │                                      │
│  Terminal 2: React App (Port 5173)                             │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ npm run dev                                                │ │
│  │ Runs: src/App.jsx                                         │ │
│  │ Opens: http://localhost:5173                             │ │
│  │ Vite proxy: /api → http://127.0.0.1:8787               │ │
│  └────────────────────────────────────────────────────────────┘ │
│                           ↓                                       │
│                    Your Browser                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ http://localhost:5173/                                    │ │
│  │  1. Pick video file                                      │ │
│  │  2. Click "Upload to R2"                                │ │
│  │  3. Shows "Upload completed successfully"              │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
        ┌─────────────────────────────────────────────┐
        │         CLOUDFLARE (Internet)               │
        │                                             │
        │  ┌──────────────────────────────────────┐  │
        │  │  Worker Domain (Production)          │  │
        │  │  https://my-api.workers.dev     │  │
        │  │  Deployed copy of worker/src      │  │
        │  └──────────────────────────────────────┘  │
        │                   ↓                         │
        │  ┌──────────────────────────────────────┐  │
        │  │  R2 S3 API Endpoint                  │  │
        │  │  https://577a1c11c46c1edf...        │  │
        │  │  r2.cloudflarestorage.com           │  │
        │  │                   ↓                 │  │
        │  │  ┌──────────────────────────────┐   │  │
        │  │  │  R2 Bucket: movieui          │   │  │
        │  │  │  ┌────────────────────────┐  │   │  │
        │  │  │  │ video_1.mp4 (100 MB)   │  │   │  │
        │  │  │  │ video_2.mp4 (200 MB)   │  │   │  │
        │  │  │  │ ...more videos...      │  │   │  │
        │  │  │  └────────────────────────┘  │   │  │
        │  │  └──────────────────────────────┘   │  │
        │  └──────────────────────────────────────┘  │
        │                                             │
        └─────────────────────────────────────────────┘
```

## Upload Flow (Step-by-Step)

```
User Action                           Endpoint                Result
─────────────────────────────────────────────────────────────────────

1. Select video file      (UI)       -                  File loaded in React state

2. Click Upload           (UI)       POST /api/videos/upload-url
                                     ↓
                                     Worker validates video type
                                     Generates unique object key
                                     Returns: { uploadUrl, key }

3. Browser uploads file   (Direct)   PUT {uploadUrl}
                                     ↓
                                     File sent directly to R2 bucket
                                     Returns: 200 OK

4. Refresh video list     (UI)       GET /api/videos
                                     ↓
                                     Worker lists all objects in R2
                                     Returns: { videos: [{...}] }

5. Video appears!         (UI)       Video shown in list with size
```

## Key Points

### Security
- **No secret keys in browser**: Worker keeps R2 credentials safe
- **Signed URLs only**: Browser never knows bucket details
- **CORS protected**: Only your frontend can upload
- **Video-only**: Non-video uploads rejected

### Data Flow
1. Browser → Worker: metadata (filename, type)
2. Worker → Browser: signed upload URL
3. Browser → R2: file data (direct, no Worker in between)
4. Worker ← R2: file listing (for showing uploaded videos)

### No backend needed for...
- Generating upload URLs (Worker handles this)
- Managing files in R2 (Worker handles this)
- Downloading videos (Worker generates signed download URLs)

## Production Deployment

```
┌────────────────────────────────────────┐
│    Your Frontend (React App)           │
│    https://yoursite.com                │
│    (Vercel, Netlify, etc.)            │
│                                        │
│  VITE_API_BASE_URL=                   │
│  https://movie-ui-r2-api.workers.dev  │
└────────────────────────────────────────┘
                ↓
        ┌───────────────────┐
        │  Cloudflare CDN   │
        │  Global Edge      │
        └───────────────────┘
                ↓
┌────────────────────────────────────────┐
│    Worker API                          │
│    https://movie-ui-r2-api.workers.dev │
│    (Deployed: worker/src/index.js)     │
└────────────────────────────────────────┘
                ↓
┌────────────────────────────────────────┐
│    Cloudflare R2                       │
│    S3-compatible blob storage          │
│    Bucket: movieui                     │
└────────────────────────────────────────┘
```

## Files That Matter

```
movie-ui/
├── worker/
│   ├── src/index.js              ← API endpoints for upload/list/download
│   └── wrangler.toml             ← Worker config + R2 binding
├── src/
│   └── App.jsx                   ← Upload UI + form
├── vite.config.js                ← Dev proxy to Worker
├── package.json                  ← Scripts: worker:dev, dev, etc.
├── QUICKSTART.md                 ← This is where you start
├── README.md                      ← Full documentation
└── DEPLOYMENT.md                 ← Production checklist
```

## Environment Variables

### Local Development
- None needed! Everything automatic.

### Production Build
```dotenv
VITE_API_BASE_URL=https://your-worker-domain.workers.dev
```

## Costs

- **Cloudflare Worker**: Free tier (10,000 req/day) or $0.50/M requests
- **R2 Storage**: $0.015/GB/month
- **Bandwidth**: Free (no egress charges like AWS S3)

Stay free by keeping uploads under 10K/day and storage under ~2GB.

