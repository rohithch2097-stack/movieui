# Deployment Checklist - Cloudflare R2 Video Upload

This checklist ensures your app is ready for production.

## Pre-Deployment (Local Testing)

- [ ] Run `npx wrangler login` and authenticate with Cloudflare
- [ ] Run `npm run worker:dev` in Terminal 1
- [ ] Run `npm run dev` in Terminal 2
- [ ] Open `http://localhost:5173/` in browser
- [ ] Upload a test video file
- [ ] Verify video appears in R2 bucket via Cloudflare Dashboard
- [ ] Run `npm run verify` to check all endpoints
- [ ] Test download of uploaded video

## Prepare for Deployment

### 1. Update Wrangler Configuration

In `worker/wrangler.toml`:

```toml
name = "movie-ui-r2-api"  # Change if needed
main = "src/index.js"
compatibility_date = "2026-05-16"

[env.production]
vars = { ALLOWED_ORIGIN = "https://your-frontend-domain.com" }

[[r2_buckets]]
binding = "VIDEOS_BUCKET"
bucket_name = "movieui"
preview_bucket_name = "movieui"
```

### 2. Build Frontend

```bash
npm run build
```

This creates a `dist/` folder.

### 3. Deploy Worker API

```bash
npm run worker:deploy
```

You'll get a Worker URL like:
```
https://movie-ui-r2-api.username.workers.dev
```

Keep this URL. You'll need it next.

### 4. Set Frontend API URL

Create a `.env` file for your frontend build:

```dotenv
VITE_API_BASE_URL=https://movie-ui-r2-api.username.workers.dev
```

Then rebuild:

```bash
npm run build
```

### 5. Deploy Frontend

Upload your `dist/` folder to your hosting:

- **Vercel**: `vercel deploy`
- **Netlify**: Drag `dist/` folder to deploy
- **GitHub Pages**: Push `dist/` to `gh-pages` branch
- **Cloudflare Pages**: Connect Git repo or upload `dist/`

## Post-Deployment Checks

- [ ] Open your frontend URL in browser
- [ ] Upload a video
- [ ] Verify video in R2 bucket
- [ ] Test download
- [ ] Check Worker logs: `wrangler tail --format pretty`

## Monitoring

### Check Worker Logs

```bash
wrangler tail --config worker/wrangler.toml
```

### Check R2 Bucket Usage

Cloudflare Dashboard → R2 → `movieui` → Settings

### Common Production Issues

| Issue | Solution |
|-------|----------|
| CORS errors | Update `ALLOWED_ORIGIN` in Worker env vars |
| Upload fails | Check R2 bucket permissions in Cloudflare |
| Videos don't list | Verify Worker can access R2 binding |
| 502 Gateway errors | Check Worker logs with `wrangler tail` |

## Scaling Tips

- **Large files**: Set higher timeout in Worker (default 300s)
- **Many uploads**: Monitor R2 storage costs and add limits if needed
- **Auto-delete old videos**: Add lifecycle policies in R2
- **Private videos**: Add authentication before generating upload URLs

## Support

For issues:
1. Check Troubleshooting section in `README.md`
2. Review `worker/wrangler.toml` configuration
3. Run `npm run verify` to test endpoints
4. Check Worker logs: `wrangler tail`

