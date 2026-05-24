import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, CopyObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

// Direct browser upload to Cloudflare R2 (no backend needed)
const r2Client = new S3Client({
  region: 'auto',
  endpoint: import.meta.env.VITE_R2_ENDPOINT || 'https://577a1c11c46c1edf27c9f3243acc797a.r2.cloudflarestorage.com',
  credentials: {
    accessKeyId: import.meta.env.VITE_R2_ACCESS_KEY_ID,
    secretAccessKey: import.meta.env.VITE_R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
})

// Multipart chunk settings
const CHUNK_SIZE = 10 * 1024 * 1024 // 10 MB per chunk
const MAX_RETRIES = 3
const RETRY_DELAYS = [1000, 2000, 4000] // ms for retry 1, 2, 3
const LONG_PRESS_MS = 450

const bucketName = import.meta.env.VITE_R2_BUCKET_NAME || 'movieui'
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const LIKE_DEVICE_ID_STORAGE_KEY = 'movieui_like_device_id'
const UPLOAD_DEVICE_ID_STORAGE_KEY = 'movieui_upload_device_id'

const VIDEO_EXTS = /\.(mp4|mov|avi|mkv|webm|m4v|flv|wmv|3gp)$/i
const IMAGE_EXTS = /\.(jpg|jpeg|png|gif|webp|bmp|avif|svg)$/i

const getFileType = (fileName = '') => {
  if (VIDEO_EXTS.test(fileName)) return 'video'
  if (IMAGE_EXTS.test(fileName)) return 'image'
  return 'other'
}

const isSupportedFile = (file) => {
  if (!file) return false
  if (file.type.startsWith('video/') || file.type.startsWith('image/')) return true
  return VIDEO_EXTS.test(file.name) || IMAGE_EXTS.test(file.name)
}

const formatBytes = (bytes = 0) => {
  if (bytes === 0) return '0 B'
  const unit = 1024
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.floor(Math.log(bytes) / Math.log(unit))
  return `${(bytes / unit ** index).toFixed(2)} ${units[index]}`
}

const sanitizeFileName = (name = '') => name.replace(/[^a-zA-Z0-9._-]/g, '_')

const buildObjectKey = (fileName, durationSeconds) => `${Date.now()}__dur-${durationSeconds}__${sanitizeFileName(fileName)}`

const getApiUrl = (path) => `${apiBaseUrl}${path}`

const getOrCreateLikeDeviceId = () => {
  const existing = window.localStorage.getItem(LIKE_DEVICE_ID_STORAGE_KEY)
  if (existing) return existing
  const nextId = (window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^a-zA-Z0-9_-]/g, '')
  window.localStorage.setItem(LIKE_DEVICE_ID_STORAGE_KEY, nextId)
  return nextId
}

const getOrCreateUploadDeviceId = () => {
  const existing = window.localStorage.getItem(UPLOAD_DEVICE_ID_STORAGE_KEY)
  if (existing) return existing
  const nextId = (window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^a-zA-Z0-9_-]/g, '')
  window.localStorage.setItem(UPLOAD_DEVICE_ID_STORAGE_KEY, nextId)
  return nextId
}

const parseObjectKey = (key = '') => {
  const encodedMatch = key.match(/^\d+__dur-(\d+)__(.+)$/)
  if (encodedMatch) {
    return {
      fileName: encodedMatch[2],
      durationSeconds: Number(encodedMatch[1]),
    }
  }

  const legacyName = key.split('-').slice(2).join('-') || key
  return {
    fileName: legacyName,
    durationSeconds: null,
  }
}

// Capture a thumbnail frame at ~2s from a video File as a JPEG Blob
const captureThumbnail = (file) => new Promise((resolve) => {
  const video = document.createElement('video')
  const canvas = document.createElement('canvas')
  const objectUrl = URL.createObjectURL(file)

  const cleanup = () => {
    URL.revokeObjectURL(objectUrl)
    video.removeAttribute('src')
    video.load()
  }

  video.preload = 'metadata'
  video.muted = true
  video.playsInline = true

  video.onloadedmetadata = () => {
    // Seek to 2s or 10% of duration whichever is smaller
    video.currentTime = Math.min(2, video.duration * 0.1)
  }

  video.onseeked = () => {
    canvas.width = 320
    canvas.height = Math.round((video.videoHeight / video.videoWidth) * 320) || 180
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    canvas.toBlob((blob) => {
      cleanup()
      resolve(blob)
    }, 'image/jpeg', 0.75)
  }

  video.onerror = () => {
    cleanup()
    resolve(null)
  }

  video.src = objectUrl
})

// For images, resize to 320px wide and return as JPEG blob thumbnail
const captureImageThumbnail = (file) => new Promise((resolve) => {
  const img = new Image()
  const objectUrl = URL.createObjectURL(file)
  img.onload = () => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = Math.round((img.naturalHeight / img.naturalWidth) * 320) || 180
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    URL.revokeObjectURL(objectUrl)
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.75)
  }
  img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(null) }
  img.src = objectUrl
})

const readFileDurationSeconds = (file) => new Promise((resolve) => {
  const tempVideo = document.createElement('video')
  const objectUrl = URL.createObjectURL(file)

  const cleanup = () => {
    URL.revokeObjectURL(objectUrl)
    tempVideo.removeAttribute('src')
    tempVideo.load()
  }

  tempVideo.preload = 'metadata'
  tempVideo.onloadedmetadata = () => {
    const duration = Number.isFinite(tempVideo.duration) ? Math.max(0, Math.floor(tempVideo.duration)) : 0
    cleanup()
    resolve(duration)
  }
  tempVideo.onerror = () => {
    cleanup()
    resolve(0)
  }
  tempVideo.src = objectUrl
})

function App() {
   const fileInputRef = useRef(null)
   const statusTimerRef = useRef(null)
   const menuRef = useRef(null)
   const uploadAbortControllerRef = useRef(null)
   const mobileActiveTimerRef = useRef(null)
   const selectionLongPressTimerRef = useRef(null)
   const selectionLongPressHandledRef = useRef(false)
   const [uploadQueue, setUploadQueue] = useState([])
   const [uploadStatuses, setUploadStatuses] = useState({})
   const [currentUploadIndex, setCurrentUploadIndex] = useState(-1)
   const [videos, setVideos] = useState([])
   const [status, setStatus] = useState('')
   const [isUploading, setIsUploading] = useState(false)
  const [isLoadingVideos, setIsLoadingVideos] = useState(false)
  const [configError, setConfigError] = useState('')
  const [uploadProgress, setUploadProgress] = useState(0)
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [previewKey, setPreviewKey] = useState(null)
  const [previewUrl, setPreviewUrl] = useState(null)
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedVideos, setSelectedVideos] = useState(new Set())
  const [isSelectionMode, setIsSelectionMode] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
   const [videoDurations, setVideoDurations] = useState({})
   const [copiedKey, setCopiedKey] = useState(null)
   const [thumbnailUrls, setThumbnailUrls] = useState({})
   const [activeTab, setActiveTab] = useState('all') // 'all' | 'video' | 'image'
   const [openMenuKey, setOpenMenuKey] = useState(null) // Mobile menu state
   const [sortBy, setSortBy] = useState('newest') // 'newest'|'oldest'|'name-az'|'name-za'|'largest'|'smallest'
   const [mobileActiveKey, setMobileActiveKey] = useState(null)
   const [likesByKey, setLikesByKey] = useState({})
   const [isSyncingLikes, setIsSyncingLikes] = useState(false)
   const [pendingLikeKeys, setPendingLikeKeys] = useState(new Set())
   const [likesSyncError, setLikesSyncError] = useState('')
   const [shareModalUrl, setShareModalUrl] = useState(null)
   const [ownershipByKey, setOwnershipByKey] = useState({})
   const likeDeviceIdRef = useRef('')
   const uploadDeviceIdRef = useRef('')

  const setTimedStatus = (msg, delay = 5000) => {
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
    setStatus(msg)
    statusTimerRef.current = setTimeout(() => setStatus(''), delay)
  }

    // Check if R2 credentials are configured and load any resumed session
    useEffect(() => {
      likeDeviceIdRef.current = getOrCreateLikeDeviceId()
      uploadDeviceIdRef.current = getOrCreateUploadDeviceId()
      if (!import.meta.env.VITE_R2_ACCESS_KEY_ID || !import.meta.env.VITE_R2_SECRET_ACCESS_KEY) {
        setConfigError('R2 credentials not configured in .env.local')
      } else {
        fetchVideos()
      }
    }, [])

   // Close menu when clicking outside
   useEffect(() => {
     const handleClickOutside = (event) => {
       if (menuRef.current && !menuRef.current.contains(event.target)) {
         setOpenMenuKey(null)
       }
     }

     if (openMenuKey) {
       document.addEventListener('click', handleClickOutside)
       return () => document.removeEventListener('click', handleClickOutside)
     }
   }, [openMenuKey])

  useEffect(() => () => {
    if (selectionLongPressTimerRef.current) clearTimeout(selectionLongPressTimerRef.current)
  }, [])

  const selectedFileLabel = useMemo(() => {
    if (uploadQueue.length === 0) return 'No files selected'
    if (uploadQueue.length === 1) {
      const file = uploadQueue[0]
      const sizeInMb = (file.size / (1024 * 1024)).toFixed(2)
      return `1 file selected: ${file.name} (${sizeInMb} MB)`
    }
    const totalSize = uploadQueue.reduce((sum, f) => sum + f.size, 0)
    return `${uploadQueue.length} files selected (${formatBytes(totalSize)})`
  }, [uploadQueue])

  const storageSummary = useMemo(() => {
    const totalBytes = videos.reduce((sum, item) => sum + (item.size || 0), 0)
    return {
      totalFiles: videos.length,
      totalBytes,
      videoCount: videos.filter(v => v.fileType === 'video').length,
      imageCount: videos.filter(v => v.fileType === 'image').length,
    }
  }, [videos])

  const fetchLikesForKeys = async (keys) => {
    if (!keys.length) {
      setLikesByKey({})
      return
    }

    setIsSyncingLikes(true)
    try {
      const params = new URLSearchParams()
      keys.forEach((key) => params.append('keys', key))

      const response = await fetch(getApiUrl(`/api/likes?${params.toString()}`), {
        method: 'GET',
        headers: {
          'x-device-id': likeDeviceIdRef.current,
        },
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(payload.message || `Likes sync failed (${response.status})`)
      }

      const payload = await response.json()
      setLikesByKey(payload.likesByKey || {})
      setLikesSyncError('')
    } catch (error) {
      setLikesSyncError(error.message)
      setTimedStatus(`Likes sync issue: ${error.message}`, 4500)
    } finally {
      setIsSyncingLikes(false)
    }
   }


   const fetchOwnershipForKeys = async (keys) => {
     if (!keys.length) {
       setOwnershipByKey({})
       return
     }

     try {
       const ownershipMap = {}
       for (const key of keys) {
         try {
           const ownerKey = `__owners__/${encodeURIComponent(key)}.json`
           const response = await r2Client.send(new GetObjectCommand({
             Bucket: bucketName,
             Key: ownerKey,
           }))
           const text = await response.Body.transformToString()
           const ownerData = JSON.parse(text)
           ownershipMap[key] = ownerData.deviceId
         } catch {
           // No ownership record means pre-existing file or upload without ownership tracking
           ownershipMap[key] = null
         }
       }
       setOwnershipByKey(ownershipMap)
     } catch (error) {
       // Non-critical — continue without ownership info
       console.error('Failed to fetch ownership info:', error)
     }
   }

  // Bug fix #3 — paginate through ALL objects (ListObjectsV2 max 1000/page)
  const fetchVideos = async () => {
    if (configError) return
    setIsLoadingVideos(true)
    try {
      let allItems = []
      let continuationToken = undefined
      do {
        const command = new ListObjectsV2Command({
          Bucket: bucketName,
          ContinuationToken: continuationToken,
        })
        const response = await r2Client.send(command)
        allItems = [...allItems, ...(response.Contents ?? [])]
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
      } while (continuationToken)

       const videoList = allItems
         .filter((item) => item.Key && !item.Key.startsWith('thumbnails/') && !item.Key.startsWith('__likes__/') && !item.Key.startsWith('__owners__/'))
         .map((item) => {
           const parsed = parseObjectKey(item.Key)
           return {
             key: item.Key,
             fileName: parsed.fileName,
             fileType: getFileType(parsed.fileName),
             durationSeconds: parsed.durationSeconds,
             sizeLabel: formatBytes(item.Size),
             size: item.Size,
             lastModified: item.LastModified,
           }
         })
         .sort((a, b) => b.lastModified - a.lastModified)

       setVideos(videoList)
       await fetchLikesForKeys(videoList.map((video) => video.key))
       await fetchOwnershipForKeys(videoList.map((video) => video.key))

      const knownDurations = {}
      videoList.forEach((video) => {
        if (Number.isFinite(video.durationSeconds) && video.durationSeconds > 0) {
          knownDurations[video.key] = video.durationSeconds
        }
      })
      if (Object.keys(knownDurations).length > 0) {
        setVideoDurations((prev) => ({ ...prev, ...knownDurations }))
      }

      // First check which thumbnails actually exist in R2 to avoid 404 signed-URL requests
      const existingThumbKeys = new Set()
      try {
        let thumbToken = undefined
        do {
          const thumbList = await r2Client.send(new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: 'thumbnails/',
            ContinuationToken: thumbToken,
          }))
          ;(thumbList.Contents ?? []).forEach((item) => existingThumbKeys.add(item.Key))
          thumbToken = thumbList.IsTruncated ? thumbList.NextContinuationToken : undefined
        } while (thumbToken)
      } catch { /* non-critical — proceed without thumbnail list */ }

      // Generate signed URLs only for thumbnails that actually exist
      const thumbEntries = await Promise.all(
        videoList.map(async (video) => {
          try {
            const thumbKey = `thumbnails/${video.key}.jpg`
            if (!existingThumbKeys.has(thumbKey)) return [video.key, null]
            const url = await getSignedUrl(r2Client, new GetObjectCommand({ Bucket: bucketName, Key: thumbKey }), { expiresIn: 60 * 60 })
            return [video.key, url]
          } catch {
            return [video.key, null]
          }
        })
      )
      const thumbMap = Object.fromEntries(thumbEntries.filter(([, url]) => url !== null))
      setThumbnailUrls((prev) => ({ ...prev, ...thumbMap }))
    } catch (error) {
      setStatus(`Failed to load files: ${error.message}`)
    } finally {
      setIsLoadingVideos(false)
    }
  }

  const onFileChange = (event) => {
    const files = event.target.files ?? []
    const newFiles = Array.from(files).filter(f => {
      if (!isSupportedFile(f)) {
        setTimedStatus(`Unsupported file: ${f.name}. Please select video or image files.`, 4000)
        return false
      }
      return true
    })
    if (newFiles.length > 0) {
      setUploadQueue((prev) => [...prev, ...newFiles])
    }
  }

  const removeFromQueue = (index) => {
    setUploadQueue((prev) => prev.filter((_, i) => i !== index))
    setUploadStatuses((prev) => {
      const next = { ...prev }
      delete next[index]
      return next
    })
  }

  const clearQueue = () => {
    setUploadQueue([])
    setUploadStatuses({})
    setCurrentUploadIndex(-1)
  }

  const onFileInputClick = (event) => {
    event.target.value = ''
  }

  const isAbortError = (error) => {
    const message = String(error?.message || '').toLowerCase()
    return error?.name === 'AbortError' || message.includes('abort') || message.includes('aborted')
  }

  const waitWithAbort = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)

    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      reject(new DOMException('Operation aborted', 'AbortError'))
    }

    if (signal?.aborted) return onAbort()
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })

  const uploadSingleFile = async (fileToUpload, queueIndex, abortSignal) => {
    const fileType = getFileType(fileToUpload.name) || (fileToUpload.type.startsWith('image/') ? 'image' : 'video')
    const isImage = fileType === 'image'

    setUploadStatuses((prev) => ({ ...prev, [queueIndex]: 'reading-metadata' }))
    const durationSeconds = isImage ? 0 : await readFileDurationSeconds(fileToUpload)

    const objectKey = buildObjectKey(fileToUpload.name, durationSeconds)
    let uploadIdToUse = null

    try {
      if (isImage) {
        setUploadStatuses((prev) => ({ ...prev, [queueIndex]: 'uploading' }))
        const buffer = await fileToUpload.arrayBuffer()
        await r2Client.send(new PutObjectCommand({
          Bucket: bucketName,
          Key: objectKey,
          Body: new Uint8Array(buffer),
          ContentType: fileToUpload.type || 'image/jpeg',
        }), { abortSignal })
      } else {
        const totalParts = Math.ceil(fileToUpload.size / CHUNK_SIZE)
        const createCommand = new CreateMultipartUploadCommand({
          Bucket: bucketName,
          Key: objectKey,
          ContentType: fileToUpload.type || 'video/mp4',
        })
        const createResponse = await r2Client.send(createCommand, { abortSignal })
        uploadIdToUse = createResponse.UploadId

        const uploadedParts = {}
        let uploadedBytes = 0

        for (let partNum = 1; partNum <= totalParts; partNum++) {
          const start = (partNum - 1) * CHUNK_SIZE
          const end = Math.min(start + CHUNK_SIZE, fileToUpload.size)
          const partData = fileToUpload.slice(start, end)
          const partBuffer = await partData.arrayBuffer()

          let lastError
          for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
              const uploadCommand = new UploadPartCommand({
                Bucket: bucketName,
                Key: objectKey,
                PartNumber: partNum,
                UploadId: uploadIdToUse,
                Body: new Uint8Array(partBuffer),
              })
              const uploadResponse = await r2Client.send(uploadCommand, { abortSignal })
              uploadedParts[partNum] = uploadResponse.ETag
              break
            } catch (err) {
              lastError = err
              if (isAbortError(err) || abortSignal.aborted) throw err
              if (attempt < MAX_RETRIES) {
                await waitWithAbort(RETRY_DELAYS[attempt], abortSignal)
              }
            }
          }

          if (lastError && !uploadedParts[partNum]) {
            throw new Error(`Failed to upload part ${partNum} after ${MAX_RETRIES + 1} attempts: ${lastError.message}`)
          }

          uploadedBytes += (end - start)
          setUploadProgress(Math.min(Math.round((uploadedBytes / fileToUpload.size) * 100), 99))
        }

        const sortedParts = Object.entries(uploadedParts)
          .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
          .map(([partNum, ETag]) => ({ PartNumber: parseInt(partNum), ETag }))

        await r2Client.send(new CompleteMultipartUploadCommand({
          Bucket: bucketName,
          Key: objectKey,
          UploadId: uploadIdToUse,
          MultipartUpload: { Parts: sortedParts },
        }), { abortSignal })
      }

      // Generate and upload thumbnail
      setUploadStatuses((prev) => ({ ...prev, [queueIndex]: 'generating-thumbnail' }))
      try {
        const thumbBlob = isImage
          ? await captureImageThumbnail(fileToUpload)
          : await captureThumbnail(fileToUpload)
        if (thumbBlob) {
          const thumbKey = `thumbnails/${objectKey}.jpg`
          const thumbBuffer = await thumbBlob.arrayBuffer()
          await r2Client.send(new PutObjectCommand({
            Bucket: bucketName,
            Key: thumbKey,
            Body: new Uint8Array(thumbBuffer),
            ContentType: 'image/jpeg',
          }), { abortSignal })
          const thumbUrl = await getSignedUrl(r2Client, new GetObjectCommand({ Bucket: bucketName, Key: thumbKey }), { expiresIn: 60 * 60 })
          setThumbnailUrls((prev) => ({ ...prev, [objectKey]: thumbUrl }))
        }
      } catch {
        // Non-critical
      }

      // Store ownership info
      try {
        const ownerKey = `__owners__/${encodeURIComponent(objectKey)}.json`
        const ownerData = JSON.stringify({
          deviceId: uploadDeviceIdRef.current,
          uploadedAt: new Date().toISOString(),
        })
        await r2Client.send(new PutObjectCommand({
          Bucket: bucketName,
          Key: ownerKey,
          Body: new TextEncoder().encode(ownerData),
          ContentType: 'application/json',
        }), { abortSignal })
      } catch (error) {
        console.error('Failed to store ownership info:', error)
      }

      setUploadStatuses((prev) => ({ ...prev, [queueIndex]: 'completed' }))
      if (durationSeconds > 0) {
        setVideoDurations((prev) => ({ ...prev, [objectKey]: durationSeconds }))
      }
    } catch (error) {
      const isAbort = isAbortError(error)
      if (uploadIdToUse) {
        try {
          await r2Client.send(new AbortMultipartUploadCommand({ Bucket: bucketName, Key: objectKey, UploadId: uploadIdToUse }))
        } catch {
          // Ignore
        }
      }
      if (isAbort) {
        setUploadStatuses((prev) => ({ ...prev, [queueIndex]: 'cancelled' }))
      } else {
        setUploadStatuses((prev) => ({ ...prev, [queueIndex]: `failed: ${error.message}` }))
      }
      throw error
    }
  }

  const uploadBulkVideos = async () => {
    if (uploadQueue.length === 0) {
      setStatus('Add files first.')
      return
    }

    if (configError) {
      setStatus('R2 credentials not configured.')
      return
    }

    setIsUploading(true)
    const uploadAbortController = new AbortController()
    uploadAbortControllerRef.current = uploadAbortController

    try {
      const totalFiles = uploadQueue.length
      for (let idx = 0; idx < totalFiles; idx++) {
        if (uploadAbortController.signal.aborted) break

        setCurrentUploadIndex(idx)
        setStatus(`Uploading ${idx + 1} of ${totalFiles}: ${uploadQueue[idx].name}`)
        setUploadProgress(0)

        try {
          await uploadSingleFile(uploadQueue[idx], idx, uploadAbortController.signal)
        } catch (error) {
          if (!isAbortError(error)) {
            console.error(`File ${idx + 1} failed:`, error)
            // Continue to next file
          }
        }
      }

      setStatus('')
      setTimedStatus(`✅ Uploaded ${totalFiles} file(s) successfully.`)
      setUploadQueue([])
      setUploadStatuses({})
      setCurrentUploadIndex(-1)
      await fetchVideos()
    } catch (error) {
      setTimedStatus(`Upload batch failed: ${error.message}`, 5000)
    } finally {
      uploadAbortControllerRef.current = null
      setIsUploading(false)
      setUploadProgress(0)
    }
  }

  const uploadVideoMultipart = () => uploadBulkVideos()

  const cancelUpload = () => {
    if (!uploadAbortControllerRef.current) return
    uploadAbortControllerRef.current.abort()
    setStatus('Canceling uploads...')
  }

  const uploadVideo = () => uploadBulkVideos()

  const previewVideo = async (key) => {
    setIsLoadingPreview(true)
    setStatus('Loading preview...')
    try {
      const url = await getSignedUrl(r2Client, new GetObjectCommand({ Bucket: bucketName, Key: key }), { expiresIn: 60 * 10 })
      setPreviewKey(key)
      setPreviewUrl(url)
      setTimedStatus('Preview ready.')
    } catch (error) {
      setTimedStatus(`Preview failed: ${error.message}`, 5000)
    } finally {
      setIsLoadingPreview(false)
    }
  }

  const closePreview = () => {
    if (previewUrl && previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl)
    setPreviewKey(null)
    setPreviewUrl(null)
  }

  const downloadVideo = async (key) => {
    setStatus('Starting download...')
    setDownloadProgress(0)

    try {
      const downloadName = parseObjectKey(key).fileName
      const command = new GetObjectCommand({
        Bucket: bucketName,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${downloadName.replace(/"/g, '')}"`,
      })

      // Use short-lived signed URL so browser streams directly from R2.
      const url = await getSignedUrl(r2Client, command, { expiresIn: 60 * 10 })
      const link = document.createElement('a')
      link.href = url
      link.download = downloadName
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)

      setTimedStatus('Download started.')
      setDownloadProgress(0)
    } catch (error) {
      setTimedStatus(`Download failed: ${error.message}`, 5000)
      setDownloadProgress(0)
    }
  }

  const bulkDownloadVideos = async () => {
    if (selectedVideos.size === 0) {
      setStatus('No files selected.')
      return
    }

    const selectedList = filteredVideos.filter((v) => selectedVideos.has(v.key))
    const totalSize = selectedList.reduce((sum, item) => sum + (item.size || 0), 0)

    if (!window.confirm(`Download ${selectedVideos.size} file(s) (${formatBytes(totalSize)})?\nBrowser will queue them for download.`)) return

    setStatus(`Starting download of ${selectedVideos.size} file(s)...`)
    let successCount = 0
    let failCount = 0

    try {
      for (const key of selectedVideos) {
        try {
          const downloadName = parseObjectKey(key).fileName
          const command = new GetObjectCommand({
            Bucket: bucketName,
            Key: key,
            ResponseContentDisposition: `attachment; filename="${downloadName.replace(/"/g, '')}"`,
          })

          const url = await getSignedUrl(r2Client, command, { expiresIn: 60 * 10 })
          const link = document.createElement('a')
          link.href = url
          link.download = downloadName
          document.body.appendChild(link)
          link.click()
          document.body.removeChild(link)

          successCount++
          setStatus(`Downloaded ${successCount} of ${selectedVideos.size}...`)
          // Small delay between downloads to avoid overwhelming the browser
          await new Promise((resolve) => setTimeout(resolve, 200))
        } catch (error) {
          failCount++
          console.error(`Failed to download file:`, error)
        }
      }

      setTimedStatus(`✅ Downloaded ${successCount} file(s)${failCount > 0 ? ` (${failCount} failed)` : ''}.`)
    } catch (error) {
      setTimedStatus(`Bulk download failed: ${error.message}`, 5000)
    } finally {
      setDownloadProgress(0)
    }
  }

  const renameVideo = async (video) => {
    const ownerId = ownershipByKey[video.key]
    if (ownerId && ownerId !== uploadDeviceIdRef.current) {
      setTimedStatus('❌ You can only rename files you uploaded.', 5000)
      return
    }

    const currentName = video?.fileName || parseObjectKey(video.key).fileName
    const nextNameRaw = window.prompt('Enter new file name:', currentName)
    if (!nextNameRaw) return
    const nextName = nextNameRaw.trim()
    if (!nextName || nextName === currentName) return

    const durationToKeep = Number.isFinite(video.durationSeconds) ? video.durationSeconds : (videoDurations[video.key] || 0)
    const nextKey = buildObjectKey(nextName, durationToKeep)
    const copySource = `${bucketName}/${encodeURIComponent(video.key).replace(/%2F/g, '/')}`

    setStatus('Renaming file...')
    try {
      await r2Client.send(new CopyObjectCommand({
        Bucket: bucketName,
        Key: nextKey,
        CopySource: copySource,
      }))

      const oldThumbKey = `thumbnails/${video.key}.jpg`
      const newThumbKey = `thumbnails/${nextKey}.jpg`
      const oldOwnerKey = `__owners__/${encodeURIComponent(video.key)}.json`
      const newOwnerKey = `__owners__/${encodeURIComponent(nextKey)}.json`
      try {
        await r2Client.send(new CopyObjectCommand({
          Bucket: bucketName,
          Key: newThumbKey,
          CopySource: `${bucketName}/${encodeURIComponent(oldThumbKey).replace(/%2F/g, '/')}`,
        }))
        await r2Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: oldThumbKey }))
      } catch {
        // No thumbnail for this file is okay.
      }

      try {
        await r2Client.send(new CopyObjectCommand({
          Bucket: bucketName,
          Key: newOwnerKey,
          CopySource: `${bucketName}/${encodeURIComponent(oldOwnerKey).replace(/%2F/g, '/')}`,
        }))
        await r2Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: oldOwnerKey }))
      } catch {
        // No ownership record for legacy files is okay.
      }

      await r2Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: video.key }))
      setTimedStatus('File renamed successfully.')
      await fetchVideos()
    } catch (error) {
      setTimedStatus(`Rename failed: ${error.message}`, 5000)
    }
  }

   // Bug fix #1 — also delete the orphaned thumbnail from R2
   const deleteVideo = async (key) => {
     // Check ownership
     const ownerId = ownershipByKey[key]
     if (ownerId && ownerId !== uploadDeviceIdRef.current) {
       setTimedStatus('❌ You can only delete files you uploaded.', 5000)
       return
     }

     const file = videos.find(v => v.key === key)
     const fileName = file?.fileName || parseObjectKey(key).fileName
     const fileSize = file?.sizeLabel || ''
     if (!window.confirm(`Delete "${fileName}"${fileSize ? ` (${fileSize})` : ''}?\nThis action cannot be undone.`)) return

     setStatus('Deleting...')
     try {
       await r2Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }))
       try {
         await r2Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: `thumbnails/${key}.jpg` }))
       } catch { /* thumbnail may not exist — ignore */ }
       try {
         await r2Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: `__owners__/${encodeURIComponent(key)}.json` }))
       } catch { /* ownership record may not exist — ignore */ }
       setThumbnailUrls(prev => { const n = { ...prev }; delete n[key]; return n })
       setLikesByKey((prev) => { const next = { ...prev }; delete next[key]; return next })
       setOwnershipByKey((prev) => { const next = { ...prev }; delete next[key]; return next })
       setTimedStatus('File deleted successfully.')
       await fetchVideos()
     } catch (error) {
       setTimedStatus(`Delete failed: ${error.message}`, 5000)
     }
   }

  const toggleVideoSelection = (key) => {
    const newSelected = new Set(selectedVideos)
    if (newSelected.has(key)) {
      newSelected.delete(key)
    } else {
      newSelected.add(key)
    }
    setSelectedVideos(newSelected)
  }

  const exitSelectionMode = () => {
    setIsSelectionMode(false)
    setSelectedVideos(new Set())
  }

  const clearSelectionLongPressTimer = () => {
    if (selectionLongPressTimerRef.current) {
      clearTimeout(selectionLongPressTimerRef.current)
      selectionLongPressTimerRef.current = null
    }
  }

  const startSelectionLongPress = (event, key) => {
    if (isSelectionMode) return
    if (event.target.closest('button, input, textarea, select, a, video')) return
    clearSelectionLongPressTimer()
    selectionLongPressHandledRef.current = false
    selectionLongPressTimerRef.current = setTimeout(() => {
      selectionLongPressHandledRef.current = true
      setIsSelectionMode(true)
      setSelectedVideos(new Set([key]))
      setOpenMenuKey(null)
      setTimedStatus('Selection mode enabled.')
    }, LONG_PRESS_MS)
  }

  const endSelectionLongPress = () => {
    clearSelectionLongPressTimer()
  }

  const handleCardClick = (event, key) => {
    if (!isSelectionMode) return
    if (event.target.closest('button, input, textarea, select, a, video')) return
    if (selectionLongPressHandledRef.current) {
      selectionLongPressHandledRef.current = false
      return
    }
    toggleVideoSelection(key)
  }

  const toggleSelectAll = () => {
    if (selectedVideos.size === filteredVideos.length) {
      setSelectedVideos(new Set())
    } else {
      setSelectedVideos(new Set(filteredVideos.map(v => v.key)))
    }
  }

   const bulkDeleteVideos = async () => {
     // Check ownership for all selected videos
     const unowned = Array.from(selectedVideos).filter(key => {
       const ownerId = ownershipByKey[key]
       return ownerId && ownerId !== uploadDeviceIdRef.current
     })
     if (unowned.length > 0) {
       setTimedStatus(`❌ You can only delete ${unowned.length} of the ${selectedVideos.size} selected file(s) (you don't own the others).`, 5000)
       return
     }

     if (selectedVideos.size === 0) { setStatus('No files selected.'); return }
     const selectedList = filteredVideos.filter(v => selectedVideos.has(v.key))
     const totalSize = selectedList.reduce((sum, item) => sum + (item.size || 0), 0)
     if (!window.confirm(`Delete ${selectedVideos.size} file(s) (${formatBytes(totalSize)})?\nThis action cannot be undone.`)) return

     setStatus('Deleting files...')
     try {
       for (const key of selectedVideos) {
         await r2Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }))
         try {
           await r2Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: `thumbnails/${key}.jpg` }))
         } catch { /* ignore missing thumbnail */ }
         try {
           await r2Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: `__owners__/${encodeURIComponent(key)}.json` }))
         } catch { /* ignore missing ownership record */ }
       }
       setTimedStatus(`Deleted ${selectedVideos.size} file(s) successfully.`)
       setSelectedVideos(new Set())
       setLikesByKey((prev) => {
         const next = { ...prev }
         for (const key of selectedVideos) delete next[key]
         return next
       })
       setOwnershipByKey((prev) => {
         const next = { ...prev }
         for (const key of selectedVideos) delete next[key]
         return next
       })
       await fetchVideos()
     } catch (error) {
       setTimedStatus(`Bulk delete failed: ${error.message}`, 5000)
     }
   }

  const toggleLike = async (key) => {
    if (pendingLikeKeys.has(key)) return

    const hadLikeEntry = Object.prototype.hasOwnProperty.call(likesByKey, key)
    const previousLike = likesByKey[key] || { count: 0, likedByMe: false, updatedAt: Date.now() }
    const nextLikedByMe = !Boolean(previousLike.likedByMe)
    const nextCount = Math.max(0, Number(previousLike.count || 0) + (nextLikedByMe ? 1 : -1))

    setPendingLikeKeys((prev) => {
      const next = new Set(prev)
      next.add(key)
      return next
    })

    // Optimistic update keeps tap feedback immediate while the network call is in flight.
    setLikesByKey((prev) => ({
      ...prev,
      [key]: {
        ...previousLike,
        likedByMe: nextLikedByMe,
        count: nextCount,
        updatedAt: Date.now(),
      },
    }))

    try {
      const response = await fetch(getApiUrl('/api/likes/toggle'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-device-id': likeDeviceIdRef.current,
        },
        body: JSON.stringify({ key }),
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(payload.message || `Like action failed (${response.status})`)
      }

      const payload = await response.json()
      setLikesByKey((prev) => ({
        ...prev,
        [key]: payload.like,
      }))
      setLikesSyncError('')
    } catch (error) {
      setLikesByKey((prev) => {
        const next = { ...prev }
        if (hadLikeEntry) next[key] = previousLike
        else delete next[key]
        return next
      })
      setLikesSyncError(error.message)
      setTimedStatus(`Could not update like: ${error.message}`, 4500)
    } finally {
      setPendingLikeKeys((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const extractDuration = (e, key) => {
    const duration = e.target.duration
    if (duration && !isNaN(duration)) {
      setVideoDurations(prev => ({
        ...prev,
        [key]: Math.floor(duration)
      }))
    }
  }

  const formatDuration = (seconds) => {
    if (!seconds || isNaN(seconds)) return 'Unknown'
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = Math.floor(seconds % 60)
    if (hours > 0) return `${hours}h ${minutes}m ${secs}s`
    if (minutes > 0) return `${minutes}m ${secs}s`
    return `${secs}s`
  }

  // Feature #5 — upload date formatting
  const formatDate = (date) => {
    if (!date) return ''
    return new Date(date).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })
  }

  // Feature #4 — sort + filter
  const filteredVideos = useMemo(() => {
    let list = videos
    if (activeTab === 'video') list = list.filter(v => v.fileType === 'video')
    else if (activeTab === 'image') list = list.filter(v => v.fileType === 'image')
    if (searchQuery.trim()) list = list.filter(v => v.fileName.toLowerCase().includes(searchQuery.toLowerCase()))
    const sorted = [...list]
    switch (sortBy) {
      case 'newest':   sorted.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified)); break
      case 'oldest':   sorted.sort((a, b) => new Date(a.lastModified) - new Date(b.lastModified)); break
      case 'name-az':  sorted.sort((a, b) => a.fileName.localeCompare(b.fileName)); break
      case 'name-za':  sorted.sort((a, b) => b.fileName.localeCompare(a.fileName)); break
      case 'largest':  sorted.sort((a, b) => b.size - a.size); break
      case 'smallest': sorted.sort((a, b) => a.size - b.size); break
    }
    return sorted
  }, [videos, searchQuery, activeTab, sortBy])

  // Feature #6 — prev/next navigation
  const previewIndex = useMemo(
    () => filteredVideos.findIndex(v => v.key === previewKey),
    [previewKey, filteredVideos]
  )

  const navigatePreview = async (direction) => {
    const newIndex = previewIndex + direction
    if (newIndex < 0 || newIndex >= filteredVideos.length) return
    await previewVideo(filteredVideos[newIndex].key)
  }

  // Keyboard: Escape = close, ← → = prev/next
  useEffect(() => {
    const handleKey = (e) => {
      if (!previewUrl) return
      if (e.key === 'Escape') closePreview()
      if (e.key === 'ArrowLeft')  navigatePreview(-1)
      if (e.key === 'ArrowRight') navigatePreview(1)
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [previewUrl, previewIndex, filteredVideos])
  const copyToClipboard = async (key) => {
    try {
      const url = await getSignedUrl(
        r2Client,
        new GetObjectCommand({ Bucket: bucketName, Key: key }),
        { expiresIn: 60 * 60 * 24 } // 24 hours
      )
      // Show modal instead of using clipboard API to avoid permission dialog
      setShareModalUrl(url)
    } catch (error) {
      setTimedStatus(`Failed to generate link: ${error.message}`, 5000)
    }
  }

  const handleDragOver = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }

  const handleDragLeave = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }

  const handleDrop = async (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    const files = e.dataTransfer.files
    if (files.length > 0) {
      const file = files[0]
      if (!isSupportedFile(file)) {
        setTimedStatus('Unsupported file type. Please drop a video or image.', 4000)
        return
      }
      setSelectedFile(file)
      setStatus(`Selected: ${file.name}`)
    }
  }

  const triggerMobileCardEffect = (key) => {
    if (mobileActiveTimerRef.current) clearTimeout(mobileActiveTimerRef.current)
    setMobileActiveKey(key)
    mobileActiveTimerRef.current = setTimeout(() => setMobileActiveKey(null), 350)
  }


  const previewFileType = previewKey ? getFileType(parseObjectKey(previewKey).fileName) : null

  return (
    <main className="app-shell">
      <div>
        <h1>🎬 Media Vault</h1>
        <p className="subtitle">Upload, manage, and share your videos & images securely in the cloud</p>
      </div>

      {configError ? (
        <section className="panel error">
          <p className="error-message">⚠️ {configError}</p>
          <p>Create <code>.env.local</code> in your project root:</p>
          <pre>{`VITE_R2_ENDPOINT=https://577a1c11c46c1edf27c9f3243acc797a.r2.cloudflarestorage.com
VITE_R2_ACCESS_KEY_ID=your_access_key
VITE_R2_SECRET_ACCESS_KEY=your_secret_key
VITE_R2_BUCKET_NAME=movieui`}</pre>
          <p>Then restart dev server with: <code>npm run dev</code></p>
        </section>
      ) : null}

      <section className="panel">
        <h2>Upload Files</h2>
        <div
          className={`drag-drop-area ${isDragOver ? 'drag-over' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setIsDragOver(false)
            const files = e.dataTransfer.files
            if (files.length > 0) {
              const newFiles = Array.from(files).filter(f => {
                if (!isSupportedFile(f)) {
                  setTimedStatus(`Unsupported file: ${f.name}`, 4000)
                  return false
                }
                return true
              })
              if (newFiles.length > 0) {
                setUploadQueue((prev) => [...prev, ...newFiles])
              }
            }
          }}
        >
          <p className="drag-drop-text">Drag & drop multiple videos or images here, or click to select</p>
          <input ref={fileInputRef} type="file" accept="video/*,image/*" multiple onClick={onFileInputClick} onChange={onFileChange} disabled={configError} />
        </div>
        <p className="file-hint">{selectedFileLabel}</p>

        {uploadQueue.length > 0 && (
          <div style={{ marginTop: '1rem', marginBottom: '1rem' }}>
            <h3 style={{ marginTop: 0, marginBottom: '0.5rem', fontSize: '0.95rem', color: 'var(--text-h)' }}>
              Upload Queue ({uploadQueue.length} file{uploadQueue.length !== 1 ? 's' : ''})
            </h3>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: '200px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', backgroundColor: 'var(--bg)' }}>
              {uploadQueue.map((file, idx) => (
                <li key={idx} style={{ padding: '0.6rem 0.8rem', borderBottom: idx < uploadQueue.length - 1 ? '1px solid var(--border)' : 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.85rem' }}>
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{ whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', color: 'var(--text)', marginBottom: '0.3rem' }}>
                      {idx + 1}. {file.name}
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      {formatBytes(file.size)}
                    </div>
                  </div>
                  <div style={{ marginLeft: '0.8rem', minWidth: '120px', textAlign: 'right' }}>
                    {uploadStatuses[idx] ? (
                      <span style={{ fontSize: '0.8rem', color: uploadStatuses[idx] === 'completed' ? 'var(--success)' : uploadStatuses[idx].startsWith('failed') ? 'var(--danger)' : 'var(--accent)' }}>
                        {uploadStatuses[idx] === 'completed' ? '✓ Done' : uploadStatuses[idx] === 'cancelled' ? '✗ Cancelled' : uploadStatuses[idx].startsWith('failed') ? '✗ ' + uploadStatuses[idx] : uploadStatuses[idx].replace(/-/g, ' ').charAt(0).toUpperCase() + uploadStatuses[idx].slice(1)}
                      </span>
                    ) : (
                      <span style={{ fontSize: '0.8rem', color: 'var(--text)' }}>Pending</span>
                    )}
                  </div>
                  {!isUploading && uploadStatuses[idx] !== 'completed' && (
                    <button type="button" onClick={() => removeFromQueue(idx)} style={{ marginLeft: '0.6rem', background: 'transparent', border: 'none', color: 'var(--text)', cursor: 'pointer', padding: '0.3rem', lineHeight: 1 }} title="Remove">✕</button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="upload-actions-row">
          <button type="button" onClick={uploadVideo} disabled={isUploading || uploadQueue.length === 0 || configError} style={{ marginTop: '10px' }}>
            {isUploading ? `Uploading (${currentUploadIndex + 1}/${uploadQueue.length})...` : 'Upload All'}
          </button>
          {uploadQueue.length > 0 && !isUploading && (
            <button type="button" onClick={clearQueue} style={{ marginTop: '10px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text)' }}>
              Clear Queue
            </button>
          )}
          {isUploading && (
            <button type="button" className="btn-cancel-upload" onClick={cancelUpload} style={{ marginTop: '10px' }}>
              Cancel Upload
            </button>
          )}
        </div>

        {isUploading && (
          <div style={{ marginTop: '1rem' }}>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${uploadProgress}%` }}></div>
              <span className="progress-text">{uploadProgress}%</span>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="videos-header">
          <h2>Files</h2>
          <button type="button" onClick={fetchVideos} disabled={isLoadingVideos || isSyncingLikes || configError}>
            {isLoadingVideos ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        {likesSyncError ? <p className="likes-warning">Likes syncing issue: {likesSyncError}</p> : null}

        <div className="storage-summary">
          <span>🗂 {storageSummary.totalFiles} files</span>
          <span>🎬 {storageSummary.videoCount}</span>
          <span>🖼️ {storageSummary.imageCount}</span>
          <span>💾 {formatBytes(storageSummary.totalBytes)} used</span>
        </div>

        <div className="tab-bar">
          {['all', 'video', 'image'].map(tab => (
            <button
              key={tab}
              type="button"
              className={`tab-btn ${activeTab === tab ? 'active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab === 'all' ? '🗂 All' : tab === 'video' ? '🎬 Videos' : '🖼️ Images'}
            </button>
          ))}
        </div>

        <div className="search-sort-row">
          <div className="search-bar">
            <input
              type="text"
              placeholder="🔍 Search by name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              disabled={configError}
            />
          </div>
          <select
            className="sort-select"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            disabled={configError}
          >
            <option value="newest">🕐 Newest first</option>
            <option value="oldest">🕐 Oldest first</option>
            <option value="name-az">🔤 Name A → Z</option>
            <option value="name-za">🔤 Name Z → A</option>
            <option value="largest">📦 Largest first</option>
            <option value="smallest">📦 Smallest first</option>
          </select>
        </div>

        {filteredVideos.length > 0 && isSelectionMode && (
          <div className="bulk-actions">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={selectedVideos.size === filteredVideos.length && filteredVideos.length > 0}
                onChange={toggleSelectAll}
              />
              Select All ({selectedVideos.size}/{filteredVideos.length})
            </label>
            <button type="button" onClick={exitSelectionMode}>
              Done
            </button>
            {selectedVideos.size > 0 && (
              <>
                <button type="button" onClick={bulkDownloadVideos} className="btn-bulk-download">
                  ⬇️ Download {selectedVideos.size} Selected
                </button>
                <button type="button" onClick={bulkDeleteVideos} className="btn-bulk-delete">
                  🗑️ Delete {selectedVideos.size} Selected
                </button>
              </>
            )}
          </div>
        )}

        {isLoadingVideos && videos.length === 0 ? (
          <ul className="video-list skeleton-list">
            {Array.from({ length: 6 }).map((_, idx) => (
              <li key={`skeleton-${idx}`} className="video-item skeleton-card">
                <div className="skeleton-thumb"></div>
                <div className="skeleton-line"></div>
                <div className="skeleton-line short"></div>
              </li>
            ))}
          </ul>
        ) : filteredVideos.length === 0 ? (
          <p className="empty-state">
            {searchQuery ? 'No files match your search.' : 'No files found in bucket.'}
          </p>
        ) : (
           <ul className="video-list" ref={menuRef}>
             {filteredVideos.map((video) => (
               <li
                 key={video.key}
                 className={`video-item ${mobileActiveKey === video.key ? 'mobile-active' : ''}`}
                 onClick={(event) => handleCardClick(event, video.key)}
                 onTouchStart={(event) => {
                   triggerMobileCardEffect(video.key)
                   startSelectionLongPress(event, video.key)
                 }}
                 onTouchEnd={endSelectionLongPress}
                 onTouchCancel={endSelectionLongPress}
               >
                 {isSelectionMode ? (
                   <input
                     type="checkbox"
                     checked={selectedVideos.has(video.key)}
                     onChange={() => toggleVideoSelection(video.key)}
                     className="video-checkbox"
                   />
                 ) : null}

                  {/* 3-dot menu — absolute positioned on card, visually overlays top-right of thumbnail */}
                  <div className="video-menu-container">
                    <button
                      type="button"
                      className="video-menu-btn"
                      onClick={(e) => { e.stopPropagation(); setOpenMenuKey(openMenuKey === video.key ? null : video.key) }}
                      title="More options"
                    >⋯</button>
                     {openMenuKey === video.key && (
                       <div className="video-menu-dropdown">
                         <button
                           type="button"
                           className={`video-menu-item ${ownershipByKey[video.key] && ownershipByKey[video.key] !== uploadDeviceIdRef.current ? 'disabled' : ''}`}
                           title={ownershipByKey[video.key] && ownershipByKey[video.key] !== uploadDeviceIdRef.current ? 'Only owner can rename' : 'Rename'}
                           onClick={() => { renameVideo(video); setOpenMenuKey(null) }}
                           disabled={ownershipByKey[video.key] && ownershipByKey[video.key] !== uploadDeviceIdRef.current}
                         >✏️</button>
                         <button type="button" className="video-menu-item" title="Copy link" onClick={() => { copyToClipboard(video.key); setOpenMenuKey(null) }}>🔗</button>
                         <button type="button" className="video-menu-item" title="Download"  onClick={() => { downloadVideo(video.key);   setOpenMenuKey(null) }}>⬇️</button>
                         <button
                           type="button"
                           className={`video-menu-item dangerous ${ownershipByKey[video.key] && ownershipByKey[video.key] !== uploadDeviceIdRef.current ? 'disabled' : ''}`}
                           title={ownershipByKey[video.key] && ownershipByKey[video.key] !== uploadDeviceIdRef.current ? 'Only owner can delete' : 'Delete'}
                           onClick={() => { deleteVideo(video.key); setOpenMenuKey(null) }}
                           disabled={ownershipByKey[video.key] && ownershipByKey[video.key] !== uploadDeviceIdRef.current}
                         >🗑️</button>
                       </div>
                     )}
                  </div>

                  {/* Clicking thumbnail/play opens preview */}
                  {thumbnailUrls[video.key] ? (
                    <div
                      className="video-thumbnail-wrap"
                      onClick={() => (isSelectionMode ? toggleVideoSelection(video.key) : previewVideo(video.key))}
                      style={{ cursor: 'pointer' }}
                    >
                      <img
                        src={thumbnailUrls[video.key]}
                        alt={video.fileName}
                        className="video-thumbnail"
                        onError={(e) => {
                          e.target.parentElement.style.display = 'none'
                          e.target.parentElement.nextSibling && (e.target.parentElement.nextSibling.style.display = 'flex')
                        }}
                      />
                      {video.fileType === 'video' && (
                        <div className="thumbnail-play-btn" aria-label="Play video">▶</div>
                      )}
                    </div>
                  ) : null}
                  <div
                    className="video-thumbnail-placeholder"
                    style={{ display: thumbnailUrls[video.key] ? 'none' : 'flex', cursor: 'pointer' }}
                    onClick={() => (isSelectionMode ? toggleVideoSelection(video.key) : previewVideo(video.key))}
                  >{video.fileType === 'image' ? '🖼️' : '🎬'}</div>

                  <div className="video-info">
                    <p className="video-name">{video.fileName}</p>
                    <p className="video-meta">
                      <span className={`file-type-badge ${video.fileType}`}>{video.fileType}</span>
                      {' '}{video.sizeLabel}
                      {(video.durationSeconds || videoDurations[video.key])
                        ? <> · {formatDuration(video.durationSeconds || videoDurations[video.key])}</>
                        : null}
                    </p>
                    <p className="video-date">📅 {formatDate(video.lastModified)}</p>
                     <div className="video-engagement-row">
                       {(() => {
                         const likeState = likesByKey[video.key] || { count: 0, likedByMe: false }
                         const isLikePending = pendingLikeKeys.has(video.key)
                         return (
                      <>
                      <button
                        type="button"
                         className={`btn-like ${likeState.likedByMe ? 'liked' : ''} ${isLikePending ? 'pending' : ''}`}
                        onClick={() => toggleLike(video.key)}
                         disabled={isLikePending}
                         title={likeState.likedByMe ? 'Unlike' : 'Like'}
                      >
                        <span aria-hidden="true">♥</span>
                         <span>{isLikePending ? 'Saving...' : (likeState.likedByMe ? 'Liked' : 'Like')}</span>
                      </button>
                      <span className="likes-count" aria-live="polite">
                         {likeState.count ?? 0}
                      </span>
                      </>
                         )
                       })()}
                    </div>
                  </div>
                   <div className="video-actions">
                     <button type="button" onClick={() => copyToClipboard(video.key)} className={`btn-copy ${copiedKey === video.key ? 'copied' : ''}`} title="Copy link">
                       {copiedKey === video.key ? '✓' : '🔗'}
                     </button>
                     <button type="button" onClick={() => downloadVideo(video.key)} className="btn-download" title="Download">⬇️</button>
                     <button
                       type="button"
                       onClick={() => deleteVideo(video.key)}
                       className={`btn-delete ${ownershipByKey[video.key] && ownershipByKey[video.key] !== uploadDeviceIdRef.current ? 'disabled' : ''}`}
                       title={ownershipByKey[video.key] && ownershipByKey[video.key] !== uploadDeviceIdRef.current ? 'Only owner can delete' : 'Delete'}
                       disabled={ownershipByKey[video.key] && ownershipByKey[video.key] !== uploadDeviceIdRef.current}
                     >🗑️</button>
                   </div>
               </li>
             ))}
           </ul>
         )}

        {downloadProgress > 0 && downloadProgress < 100 && (
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${downloadProgress}%` }}></div>
            <span className="progress-text">{downloadProgress}%</span>
          </div>
        )}
      </section>

      {status ? <p className="status-box">{status}</p> : null}

      {previewUrl && (
        <div className="preview-modal-overlay" onClick={closePreview}>
          <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="preview-header">
              <h3 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '80%' }}>
                {previewFileType === 'image' ? '🖼️' : '🎬'} {previewKey ? parseObjectKey(previewKey).fileName : ''}
              </h3>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text)', whiteSpace: 'nowrap' }}>
                  {previewIndex + 1} / {filteredVideos.length}
                </span>
                <button className="close-btn" onClick={closePreview}>✕</button>
              </div>
            </div>
            {previewFileType === 'image' ? (
              <img
                src={previewUrl}
                alt="preview"
                style={{ width: '100%', maxHeight: '60vh', objectFit: 'contain', display: 'block', borderRadius: 'var(--radius-md)', background: '#000', margin: 'var(--spacing-xl) 0' }}
              />
            ) : (
              <video
                src={previewUrl}
                controls
                autoPlay
                preload="metadata"
                onLoadedMetadata={(e) => { if (previewKey) extractDuration(e, previewKey) }}
                className="preview-video"
                style={{ width: '100%', maxHeight: '60vh' }}
              />
            )}
            <div className="preview-actions">
              <button
                className="btn-nav-preview"
                onClick={() => navigatePreview(-1)}
                disabled={previewIndex <= 0}
                title="Previous (←)"
              >← Prev</button>
              <button onClick={() => downloadVideo(previewKey)} className="btn-download-from-preview">
                ⬇️ Download
              </button>
              <button onClick={closePreview} className="btn-close-preview">Close</button>
              <button
                className="btn-nav-preview"
                onClick={() => navigatePreview(1)}
                disabled={previewIndex >= filteredVideos.length - 1}
                title="Next (→)"
              >Next →</button>
            </div>
          </div>
        </div>
      )}

      {shareModalUrl && (
        <div className="preview-modal-overlay" onClick={() => setShareModalUrl(null)}>
          <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="preview-header">
              <h3>📋 Share Link</h3>
              <button className="close-btn" onClick={() => setShareModalUrl(null)}>✕</button>
            </div>
            <div style={{ padding: 'var(--spacing-xl)', minHeight: '150px' }}>
              <p style={{ marginBottom: 'var(--spacing-md)', color: 'var(--text)' }}>
                Link valid for 24 hours. Select all and copy manually:
              </p>
              <textarea
                readOnly
                value={shareModalUrl}
                style={{
                  width: '100%',
                  height: '100px',
                  padding: 'var(--spacing-md)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  fontFamily: 'monospace',
                  fontSize: '0.85rem',
                  resize: 'none',
                  color: 'var(--text-h)',
                  backgroundColor: 'var(--bg)',
                }}
                onClick={(e) => e.target.select()}
              />
            </div>
            <div className="preview-actions">
              <button onClick={() => setShareModalUrl(null)} className="btn-close-preview">Close</button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

export default App
