#!/usr/bin/env node

/**
 * Complete system verification script for Video Upload to Cloudflare R2
 * Run this after starting the Worker dev server to verify everything is wired correctly
 */

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
}

const log = {
  info: (msg) => console.log(`${colors.blue}ℹ${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
}

const workerUrl = 'http://127.0.0.1:8787'
let passCount = 0
let failCount = 0

const test = async (name, fn) => {
  try {
    await fn()
    log.success(name)
    passCount++
  } catch (error) {
    log.error(name)
    console.log(`  ${error.message}`)
    failCount++
  }
}

const main = async () => {
  console.log(`\n${colors.blue}Video Upload to R2 - System Verification${colors.reset}\n`)

  await test('Worker is running on port 8787', async () => {
    const res = await fetch(`${workerUrl}/api/health`)
    if (!res.ok) throw new Error(`Got ${res.status}`)
  })

  await test('Health endpoint returns correct shape', async () => {
    const res = await fetch(`${workerUrl}/api/health`)
    const data = await res.json()
    if (!data.ok) throw new Error('Missing "ok" field')
  })

  await test('List videos endpoint is accessible', async () => {
    const res = await fetch(`${workerUrl}/api/videos`)
    if (!res.ok) throw new Error(`Got ${res.status}`)
  })

  await test('List videos returns videos array', async () => {
    const res = await fetch(`${workerUrl}/api/videos`)
    const data = await res.json()
    if (!Array.isArray(data.videos)) throw new Error('Missing "videos" array')
  })

  await test('Upload URL generation works', async () => {
    const res = await fetch(`${workerUrl}/api/videos/upload-url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fileName: 'test.mp4',
        fileType: 'video/mp4',
      }),
    })
    if (!res.ok) throw new Error(`Got ${res.status}`)
    const data = await res.json()
    if (!data.uploadUrl) throw new Error('Missing "uploadUrl"')
  })

  await test('CORS headers are present', async () => {
    const res = await fetch(`${workerUrl}/api/health`)
    const cors = res.headers.get('access-control-allow-origin')
    if (!cors) throw new Error('Missing CORS header')
  })

  console.log(`\n${colors.blue}Summary${colors.reset}`)
  console.log(`  ${colors.green}Passed: ${passCount}${colors.reset}`)
  if (failCount > 0) {
    console.log(`  ${colors.red}Failed: ${failCount}${colors.reset}`)
  }

  console.log(`\n${colors.green}Setup complete!${colors.reset}`)
  console.log(`\nNext steps:`)
  console.log(`  1. Open http://localhost:5173 in your browser`)
  console.log(`  2. Select a video file and click "Upload to R2"`)
  console.log(`  3. Check Cloudflare Dashboard > R2 > movieui for your video\n`)

  process.exit(failCount > 0 ? 1 : 0)
}

main().catch((err) => {
  log.error('Verification failed')
  console.error(err)
  process.exit(1)
})

