# 🎬 START HERE - Video Upload to Cloudflare R2

Welcome! This guide will get you uploading videos to Cloudflare R2 in **5 minutes**.

## What You Have

✓ React frontend with upload UI  
✓ Cloudflare Worker API (serverless backend)  
✓ Pre-configured R2 bucket: `movieui`  
✓ Account ID: `577a1c11c46c1edf27c9f3243acc797a`

## One-Time Setup (First Time Only)

### Step 1: Authenticate with Cloudflare

```powershell
npx wrangler login
```

- A browser window opens
- Click **"Allow"** to authorize
- Return to PowerShell when done

## Run It (Every Time You Code)

### Terminal 1: Start Worker API

```powershell
cd C:\Users\yaswa\OneDrive\Desktop\movie-ui
npm run worker:dev
```

Wait for:
```
⛅️ Listening on http://127.0.0.1:8787
```

**Leave this running.**

### Terminal 2: Start React App

```powershell
cd C:\Users\yaswa\OneDrive\Desktop\movie-ui
npm run dev
```

Wait for:
```
VITE v8.0.13  ready in XXX ms
Local:   http://localhost:5173/
```

## Upload a Video

1. Open http://localhost:5173/ in your browser
2. Pick any video file (MP4, MOV, WebM, etc.)
3. Click **"Upload to R2"**
4. Wait for: **"Upload completed successfully"**
5. Scroll down, you'll see it in the list!
6. Open Cloudflare Dashboard → **R2** → **movieui** bucket → see your video there too

## Verify Everything Works

```powershell
npm run verify
```

Should show all green ✓ checkmarks.

## What Just Happened?

1. Your React app talks to a Worker API (not Node.js!)
2. Worker generates a signed URL for your file
3. Browser uploads directly to Cloudflare R2 (no server in between)
4. Your video is permanently stored in R2

**No secret keys exposed to browser. Secure by default.**

---

## Next Steps

- **Want to deploy?** → Read `DEPLOYMENT.md`
- **Need help?** → Check `README.md` Troubleshooting section
- **Want details?** → See `ARCHITECTURE.md`
- **Full quickstart?** → Read `QUICKSTART.md`

## Commands Cheat Sheet

```bash
npm run dev              # Start React app
npm run worker:dev      # Start Worker API
npm run verify          # Test all endpoints
npm run build           # Build for production
npm run worker:deploy   # Deploy Worker to Cloudflare
```

---

## ⚠️ Important Security Note

**The R2 credentials shared in email should be rotated immediately:**

1. Go to Cloudflare Dashboard
2. Settings → **API Tokens**
3. Delete the old token
4. Create a **new API Token** or update S3 credentials
5. Only share new credentials with team in a secure way (not chat/email)

Already done? You're safe! ✅

---

## Having Issues?

### "ECONNREFUSED 127.0.0.1:8787"
→ Make sure Terminal 1 is running `npm run worker:dev`

### "Unauthorized" error
→ Run `npx wrangler login` again

### Videos don't appear
→ Check Cloudflare Dashboard R2 bucket directly
→ Run `npm run verify` to debug

### Still stuck?
→ Read the **Troubleshooting** section in `README.md`

---

Good luck! 🚀

