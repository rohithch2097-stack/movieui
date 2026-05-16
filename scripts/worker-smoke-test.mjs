const baseUrl = process.env.WORKER_BASE_URL || 'http://127.0.0.1:8787'

const check = async (path) => {
  const response = await fetch(`${baseUrl}${path}`)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status}): ${text}`)
  }
  return text
}

try {
  const health = await check('/api/health')
  const videos = await check('/api/videos')

  console.log('Health:', health)
  console.log('Videos:', videos)
  console.log('Worker smoke test passed.')
} catch (error) {
  console.error('Worker smoke test failed:', error.message)
  process.exit(1)
}

