import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { randomUUID } from 'node:crypto'
import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const resolvedEndpoint =
  process.env.R2_ENDPOINT ??
  (process.env.R2_ACCOUNT_ID
    ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
    : undefined)

const requiredEnv = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']

const missingEnv = requiredEnv.filter((name) => !process.env[name])
if (!resolvedEndpoint) {
  missingEnv.push('R2_ENDPOINT (or R2_ACCOUNT_ID)')
}
if (missingEnv.length > 0) {
  console.error(`Missing environment variables: ${missingEnv.join(', ')}`)
  process.exit(1)
}

const app = express()
const port = Number(process.env.PORT ?? 4000)

const s3 = new S3Client({
  region: process.env.R2_REGION ?? 'auto',
  endpoint: resolvedEndpoint,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
})

app.use(cors())
app.use(express.json())

const bucketName = process.env.R2_BUCKET_NAME

const formatBytes = (bytes = 0) => {
  if (bytes === 0) return '0 B'
  const unit = 1024
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.floor(Math.log(bytes) / Math.log(unit))
  return `${(bytes / unit ** index).toFixed(2)} ${units[index]}`
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.get('/api/videos', async (_req, res) => {
  try {
    const command = new ListObjectsV2Command({
      Bucket: bucketName,
    })

    const response = await s3.send(command)
    const videos = (response.Contents ?? [])
      .filter((item) => item.Key)
      .map((item) => ({
        key: item.Key,
        fileName: item.Key,
        sizeLabel: formatBytes(item.Size),
      }))

    res.json({ videos })
  } catch (error) {
    console.error('List videos failed:', error)
    res.status(500).json({ message: 'Could not fetch videos from Cloudflare R2.' })
  }
})

app.post('/api/videos/upload-url', async (req, res) => {
  const { fileName, fileType } = req.body ?? {}

  if (!fileName || !fileType) {
    return res.status(400).json({ message: 'fileName and fileType are required.' })
  }

  if (!String(fileType).startsWith('video/')) {
    return res.status(400).json({ message: 'Only video uploads are allowed.' })
  }

  // Keep original filename readable while guaranteeing uniqueness.
  const safeName = String(fileName).replace(/[^a-zA-Z0-9._-]/g, '_')
  const objectKey = `${Date.now()}-${randomUUID()}-${safeName}`

  try {
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      ContentType: fileType,
    })

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 })

    return res.json({
      uploadUrl,
      key: objectKey,
    })
  } catch (error) {
    console.error('Generate upload URL failed:', error)
    return res.status(500).json({ message: 'Could not generate upload URL.' })
  }
})

app.post('/api/videos/download-url', async (req, res) => {
  const { key } = req.body ?? {}

  if (!key) {
    return res.status(400).json({ message: 'key is required.' })
  }

  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${key.split('/').pop()}"`,
    })

    const downloadUrl = await getSignedUrl(s3, command, { expiresIn: 300 })

    return res.json({
      downloadUrl,
      fileName: key.split('/').pop(),
    })
  } catch (error) {
    console.error('Generate download URL failed:', error)
    return res.status(500).json({ message: 'Could not generate download URL.' })
  }
})

app.listen(port, () => {
  console.log(`API server running at http://localhost:${port}`)
})

