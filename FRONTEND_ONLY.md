# FRONTEND-ONLY Setup - No Backend Required

This is the **pure browser-only** version. No backend, no Worker, no server.

## One-Time Setup

### 1. Create `.env.local` File

In your project root (`C:\Users\yaswa\OneDrive\Desktop\movie-ui\`), create `.env.local`:

```dotenv
VITE_R2_ENDPOINT=https://577a1c11c46c1edf27c9f3243acc797a.r2.cloudflarestorage.com
VITE_R2_ACCESS_KEY_ID=your_access_key_id
VITE_R2_SECRET_ACCESS_KEY=your_secret_access_key
VITE_R2_BUCKET_NAME=movieui
```

Replace:
- `your_access_key_id` - Your R2 S3 API access key
- `your_secret_access_key` - Your R2 S3 API secret key

**⚠️ IMPORTANT:** Never commit `.env.local` to git. It's in `.gitignore` already, so you're safe.

## Run It

That's it! Just one command:

```powershell
cd C:\Users\yaswa\OneDrive\Desktop\movie-ui
npm run dev
```

Open `http://localhost:5173/` and upload videos directly to R2.

## How It Works

1. **Browser** reads credentials from `.env.local`
2. **JavaScript** connects to R2 directly (no server in between)
3. **Videos** upload straight to R2
4. **List** loads directly from R2

No backend. No Worker. Just React + AWS SDK + R2.

## That's It!

- No `npm run server`
- No `npm run worker:dev`
- No terminals with "listening on" messages
- Just **one** command: `npm run dev`

Upload a video and it appears in your R2 bucket instantly! ✨

