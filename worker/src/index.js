const json = (data, init = {}) => {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(data), { ...init, headers })
}

const formatBytes = (bytes = 0) => {
  if (bytes === 0) return '0 B'
  const unit = 1024
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.floor(Math.log(bytes) / Math.log(unit))
  return `${(bytes / unit ** index).toFixed(2)} ${units[index]}`
}

const LIKE_OBJECT_PREFIX = '__likes__/'
const MAX_LIKE_UPDATE_RETRIES = 6

const getCorsHeaders = (env) => ({
  'access-control-allow-origin': env.ALLOWED_ORIGIN ?? '*',
  'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
  'access-control-allow-headers': 'content-type,x-device-id',
})

const withCors = (response, env) => {
  const headers = new Headers(response.headers)
  const cors = getCorsHeaders(env)
  Object.entries(cors).forEach(([key, value]) => headers.set(key, value))
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

const sanitizeFileName = (fileName) => fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
const sanitizeDeviceId = (deviceId) => String(deviceId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128)
const getLikeObjectKey = (videoKey) => `${LIKE_OBJECT_PREFIX}${encodeURIComponent(videoKey)}.json`
const isReservedKey = (key) => key.startsWith('thumbnails/') || key.startsWith(LIKE_OBJECT_PREFIX)

const normalizeLikeRecord = (record) => {
  if (!record || typeof record !== 'object') return { count: 0, likers: [], updatedAt: Date.now() }
  const likerSet = new Set(Array.isArray(record.likers) ? record.likers.map(sanitizeDeviceId).filter(Boolean) : [])
  return {
    count: likerSet.size,
    likers: Array.from(likerSet),
    updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : Date.now(),
  }
}

const readLikeRecord = async (env, videoKey) => {
  const likeObject = await env.VIDEOS_BUCKET.get(getLikeObjectKey(videoKey))
  if (!likeObject) return { likeRecord: normalizeLikeRecord(null), etag: null }
  const parsed = await likeObject.json().catch(() => null)
  return { likeRecord: normalizeLikeRecord(parsed), etag: likeObject.etag }
}

const writeLikeRecord = async (env, videoKey, nextRecord, etag) => {
  const putOptions = {
    httpMetadata: { contentType: 'application/json' },
    onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' },
  }
  const result = await env.VIDEOS_BUCKET.put(getLikeObjectKey(videoKey), JSON.stringify(nextRecord), putOptions)
  return result !== null
}

const updateLikeRecordWithRetry = async (env, videoKey, updater) => {
  for (let attempt = 0; attempt < MAX_LIKE_UPDATE_RETRIES; attempt += 1) {
    const { likeRecord, etag } = await readLikeRecord(env, videoKey)
    const nextRecord = normalizeLikeRecord(updater(likeRecord))
    nextRecord.updatedAt = Date.now()
    const wrote = await writeLikeRecord(env, videoKey, nextRecord, etag)
    if (wrote) return nextRecord
  }
  throw new Error('Could not update likes due to concurrent updates. Please retry.')
}

const getObjectKey = (path) => {
  const prefix = '/api/videos/upload/'
  if (path.startsWith(prefix)) return decodeURIComponent(path.slice(prefix.length))
  const downloadPrefix = '/api/videos/download/'
  if (path.startsWith(downloadPrefix)) return decodeURIComponent(path.slice(downloadPrefix.length))
  return null
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const { pathname } = url

    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }), env)
    }

    if (!env.VIDEOS_BUCKET) {
      return withCors(
        json({ message: 'R2 bucket binding missing. Add VIDEOS_BUCKET in wrangler.toml.' }, { status: 500 }),
        env
      )
    }

    if (request.method === 'GET' && pathname === '/api/health') {
      return withCors(json({ ok: true, service: 'cloudflare-worker-r2' }), env)
    }

    if (request.method === 'GET' && pathname === '/api/videos') {
      try {
        const listed = await env.VIDEOS_BUCKET.list()
        const videos = listed.objects
          .filter((item) => !isReservedKey(item.key))
          .map((item) => ({
            key: item.key,
            fileName: item.key,
            sizeLabel: formatBytes(item.size),
          }))
        return withCors(json({ videos }), env)
      } catch (error) {
        return withCors(json({ message: `Could not fetch videos from R2. ${error.message}` }, { status: 500 }), env)
      }
    }

    if (request.method === 'GET' && pathname === '/api/likes') {
      try {
        const deviceId = sanitizeDeviceId(request.headers.get('x-device-id'))
        const keys = url.searchParams.getAll('keys').map(String).filter(Boolean)
        if (!keys.length) return withCors(json({ likesByKey: {} }), env)

        const likesByKey = {}
        await Promise.all(
          keys.map(async (key) => {
            if (isReservedKey(key)) return
            const { likeRecord } = await readLikeRecord(env, key)
            likesByKey[key] = {
              count: likeRecord.count,
              likedByMe: Boolean(deviceId && likeRecord.likers.includes(deviceId)),
              updatedAt: likeRecord.updatedAt,
            }
          })
        )
        return withCors(json({ likesByKey }), env)
      } catch (error) {
        return withCors(json({ message: `Could not load likes. ${error.message}` }, { status: 500 }), env)
      }
    }

    if (request.method === 'POST' && pathname === '/api/likes/toggle') {
      try {
        const deviceId = sanitizeDeviceId(request.headers.get('x-device-id'))
        if (!deviceId) return withCors(json({ message: 'Missing x-device-id header.' }, { status: 400 }), env)

        const { key } = await request.json()
        if (!key) return withCors(json({ message: 'key is required.' }, { status: 400 }), env)

        const videoKey = String(key)
        if (isReservedKey(videoKey)) return withCors(json({ message: 'Invalid key.' }, { status: 400 }), env)

        const nextLikeRecord = await updateLikeRecordWithRetry(env, videoKey, (prev) => {
          const likeSet = new Set(prev.likers)
          if (likeSet.has(deviceId)) likeSet.delete(deviceId)
          else likeSet.add(deviceId)
          return { count: likeSet.size, likers: Array.from(likeSet), updatedAt: Date.now() }
        })

        return withCors(json({
          like: {
            count: nextLikeRecord.count,
            likedByMe: nextLikeRecord.likers.includes(deviceId),
            updatedAt: nextLikeRecord.updatedAt,
          },
        }), env)
      } catch (error) {
        return withCors(json({ message: `Could not toggle like. ${error.message}` }, { status: 409 }), env)
      }
    }

    if (request.method === 'POST' && pathname === '/api/videos/upload-url') {
      try {
        const { fileName, fileType } = await request.json()
        if (!fileName || !fileType) {
          return withCors(json({ message: 'fileName and fileType are required.' }, { status: 400 }), env)
        }
        if (!String(fileType).startsWith('video/')) {
          return withCors(json({ message: 'Only video uploads are allowed.' }, { status: 400 }), env)
        }
        const safeName = sanitizeFileName(String(fileName))
        const objectKey = `${Date.now()}-${crypto.randomUUID()}-${safeName}`
        const uploadUrl = `${url.origin}/api/videos/upload/${encodeURIComponent(objectKey)}`
        return withCors(json({ uploadUrl, key: objectKey }), env)
      } catch (error) {
        return withCors(json({ message: `Could not prepare upload URL. ${error.message}` }, { status: 500 }), env)
      }
    }

    if (request.method === 'PUT' && pathname.startsWith('/api/videos/upload/')) {
      const objectKey = getObjectKey(pathname)
      if (!objectKey || isReservedKey(objectKey)) {
        return withCors(json({ message: 'Invalid upload key.' }, { status: 400 }), env)
      }
      const contentType = request.headers.get('content-type') ?? 'application/octet-stream'
      if (!contentType.startsWith('video/')) {
        return withCors(json({ message: 'Only video uploads are allowed.' }, { status: 400 }), env)
      }
      try {
        await env.VIDEOS_BUCKET.put(objectKey, request.body, { httpMetadata: { contentType } })
        return withCors(new Response(null, { status: 200 }), env)
      } catch (error) {
        return withCors(json({ message: `Could not upload video to R2. ${error.message}` }, { status: 500 }), env)
      }
    }

    if (request.method === 'POST' && pathname === '/api/videos/download-url') {
      try {
        const { key } = await request.json()
        if (!key || isReservedKey(String(key))) {
          return withCors(json({ message: 'key is required.' }, { status: 400 }), env)
        }
        const fileName = String(key).split('/').pop()
        const downloadUrl = `${url.origin}/api/videos/download/${encodeURIComponent(String(key))}`
        return withCors(json({ downloadUrl, fileName }), env)
      } catch (error) {
        return withCors(json({ message: `Could not prepare download URL. ${error.message}` }, { status: 500 }), env)
      }
    }

    if (request.method === 'GET' && pathname.startsWith('/api/videos/download/')) {
      const objectKey = getObjectKey(pathname)
      if (!objectKey || isReservedKey(objectKey)) {
        return withCors(json({ message: 'Invalid download key.' }, { status: 400 }), env)
      }
      const object = await env.VIDEOS_BUCKET.get(objectKey)
      if (!object) return withCors(json({ message: 'Video not found.' }, { status: 404 }), env)
      const fileName = objectKey.split('/').pop()
      const headers = new Headers()
      headers.set('content-type', object.httpMetadata?.contentType ?? 'application/octet-stream')
      headers.set('content-disposition', `attachment; filename="${fileName}"`)
      return withCors(new Response(object.body, { status: 200, headers }), env)
    }

    return withCors(json({ message: 'Not found' }, { status: 404 }), env)
  },
}
