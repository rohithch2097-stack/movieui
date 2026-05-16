import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3'
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

const bucketName = import.meta.env.VITE_R2_BUCKET_NAME || 'movieui'

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
   const [selectedFile, setSelectedFile] = useState(null)
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
  const [isDragOver, setIsDragOver] = useState(false)
   const [videoDurations, setVideoDurations] = useState({})
   const [copiedKey, setCopiedKey] = useState(null)
   const [thumbnailUrls, setThumbnailUrls] = useState({})
   const [activeTab, setActiveTab] = useState('all') // 'all' | 'video' | 'image'
   const [openMenuKey, setOpenMenuKey] = useState(null) // Mobile menu state

  const setTimedStatus = (msg, delay = 5000) => {
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
    setStatus(msg)
    statusTimerRef.current = setTimeout(() => setStatus(''), delay)
  }

   // Check if R2 credentials are configured and load any resumed session
   useEffect(() => {
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

  const selectedFileLabel = useMemo(() => {
    if (!selectedFile) return 'No file selected'
    const sizeInMb = (selectedFile.size / (1024 * 1024)).toFixed(2)
    return `${selectedFile.name} (${sizeInMb} MB)`
  }, [selectedFile])

  const fetchVideos = async () => {
    if (configError) return // skip if not configured
    setIsLoadingVideos(true)
    try {
      const command = new ListObjectsV2Command({ Bucket: bucketName })
      const response = await r2Client.send(command)

      const videoList = (response.Contents ?? [])
        .filter((item) => item.Key && !item.Key.startsWith('thumbnails/'))
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
        .sort((a, b) => b.lastModified - a.lastModified) // Sort by newest first

      setVideos(videoList)

      const knownDurations = {}
      videoList.forEach((video) => {
        if (Number.isFinite(video.durationSeconds) && video.durationSeconds > 0) {
          knownDurations[video.key] = video.durationSeconds
        }
      })
      if (Object.keys(knownDurations).length > 0) {
        setVideoDurations((prev) => ({ ...prev, ...knownDurations }))
      }

      // Generate signed thumbnail URLs only — browser will naturally hide broken ones via onError
      // We use setThumbnailUrls with function form so existing valid URLs are preserved
      const thumbEntries = await Promise.all(
        videoList.map(async (video) => {
          try {
            const thumbKey = `thumbnails/${video.key}.jpg`
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
    const nextFile = event.target.files?.[0] ?? null
    if (nextFile && !isSupportedFile(nextFile)) {
      setTimedStatus('Unsupported file type. Please select a video or image.', 4000)
      return
    }
    setSelectedFile(nextFile)
  }

  const onFileInputClick = (event) => {
    event.target.value = ''
  }

  const uploadVideoMultipart = async () => {
    const fileToUpload = selectedFile

    if (!fileToUpload) {
      setStatus('Select a file first.')
      return
    }

    if (configError) {
      setStatus('R2 credentials not configured.')
      return
    }

    const fileType = getFileType(fileToUpload.name) || (fileToUpload.type.startsWith('image/') ? 'image' : 'video')
    const isImage = fileType === 'image'

    setStatus('Reading file metadata...')
    const durationSeconds = isImage ? 0 : await readFileDurationSeconds(fileToUpload)

    setIsUploading(true)
    const objectKey = buildObjectKey(fileToUpload.name, durationSeconds)
    let uploadIdToUse = null

    try {
      if (isImage) {
        // Images are small — single PutObject, no multipart needed
        setStatus('Uploading image...')
        const buffer = await fileToUpload.arrayBuffer()
        setUploadProgress(50)
        await r2Client.send(new PutObjectCommand({
          Bucket: bucketName,
          Key: objectKey,
          Body: new Uint8Array(buffer),
          ContentType: fileToUpload.type || 'image/jpeg',
        }))
        setUploadProgress(100)
      } else {
        // Videos use multipart chunked upload
        const totalParts = Math.ceil(fileToUpload.size / CHUNK_SIZE)
        setStatus('Initializing multipart upload...')
        const createCommand = new CreateMultipartUploadCommand({
          Bucket: bucketName,
          Key: objectKey,
          ContentType: fileToUpload.type || 'video/mp4',
        })
        const createResponse = await r2Client.send(createCommand)
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
              setStatus(`Uploading part ${partNum}/${totalParts} (attempt ${attempt + 1}/${MAX_RETRIES + 1})...`)
              const uploadCommand = new UploadPartCommand({
                Bucket: bucketName,
                Key: objectKey,
                PartNumber: partNum,
                UploadId: uploadIdToUse,
                Body: new Uint8Array(partBuffer),
              })
              const uploadResponse = await r2Client.send(uploadCommand)
              uploadedParts[partNum] = uploadResponse.ETag
              break
            } catch (err) {
              lastError = err
              if (attempt < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[attempt]))
              }
            }
          }

          if (lastError && !uploadedParts[partNum]) {
            throw new Error(`Failed to upload part ${partNum} after ${MAX_RETRIES + 1} attempts: ${lastError.message}`)
          }

          uploadedBytes += (end - start)
          setUploadProgress(Math.min(Math.round((uploadedBytes / fileToUpload.size) * 100), 99))
        }

        setStatus('Finalizing upload...')
        const sortedParts = Object.entries(uploadedParts)
          .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
          .map(([partNum, ETag]) => ({ PartNumber: parseInt(partNum), ETag }))

        await r2Client.send(new CompleteMultipartUploadCommand({
          Bucket: bucketName,
          Key: objectKey,
          UploadId: uploadIdToUse,
          MultipartUpload: { Parts: sortedParts },
        }))
      }

      setTimedStatus('✅ Upload completed successfully.')
      setSelectedFile(null)
      if (durationSeconds > 0) {
        setVideoDurations((prev) => ({ ...prev, [objectKey]: durationSeconds }))
      }
      if (fileInputRef.current) fileInputRef.current.value = ''
      setUploadProgress(0)

      // Generate and upload thumbnail
      setStatus('Generating thumbnail...')
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
          }))
          const thumbUrl = await getSignedUrl(r2Client, new GetObjectCommand({ Bucket: bucketName, Key: thumbKey }), { expiresIn: 60 * 60 })
          setThumbnailUrls((prev) => ({ ...prev, [objectKey]: thumbUrl }))
        }
      } catch { /* thumbnail failure is non-critical */ }
      setStatus('')

      await fetchVideos()
    } catch (error) {
      if (uploadIdToUse) {
        try {
          await r2Client.send(new AbortMultipartUploadCommand({ Bucket: bucketName, Key: objectKey, UploadId: uploadIdToUse }))
        } catch { /* ignore */ }
      }
      setTimedStatus(`Upload failed: ${error.message}`, 5000)
      setUploadProgress(0)
    } finally {
      setIsUploading(false)
    }
  }

  const uploadVideo = () => uploadVideoMultipart()

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

  const deleteVideo = async (key) => {
    if (!window.confirm(`Delete this video? This action cannot be undone.`)) {
      return
    }

    setStatus('Deleting video...')
    try {
      const command = new DeleteObjectCommand({
        Bucket: bucketName,
        Key: key,
      })

      await r2Client.send(command)
      setTimedStatus('Video deleted successfully.')
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

  const toggleSelectAll = () => {
    if (selectedVideos.size === filteredVideos.length) {
      setSelectedVideos(new Set())
    } else {
      setSelectedVideos(new Set(filteredVideos.map(v => v.key)))
    }
  }

  const bulkDeleteVideos = async () => {
    if (selectedVideos.size === 0) {
      setStatus('No videos selected.')
      return
    }

    if (!window.confirm(`Delete ${selectedVideos.size} video(s)? This action cannot be undone.`)) {
      return
    }

    setStatus('Deleting videos...')
    try {
      let deleted = 0
      for (const key of selectedVideos) {
        const command = new DeleteObjectCommand({ Bucket: bucketName, Key: key })
        await r2Client.send(command)
        deleted++
      }
      setTimedStatus(`Deleted ${deleted} video(s) successfully.`)
      setSelectedVideos(new Set())
      await fetchVideos()
    } catch (error) {
      setTimedStatus(`Bulk delete failed: ${error.message}`, 5000)
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

    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`
    } else {
      return `${secs}s`
    }
  }

  const copyToClipboard = (key) => {
    const link = `${import.meta.env.VITE_R2_ENDPOINT}/${bucketName}/${key}`
    navigator.clipboard.writeText(link)
    setCopiedKey(key)
    setTimedStatus('Link copied to clipboard!')
    setTimeout(() => setCopiedKey(null), 2000)
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

  const filteredVideos = useMemo(() => {
    let list = videos
    if (activeTab === 'video') list = list.filter(v => v.fileType === 'video')
    else if (activeTab === 'image') list = list.filter(v => v.fileType === 'image')
    if (!searchQuery.trim()) return list
    return list.filter(v => v.fileName.toLowerCase().includes(searchQuery.toLowerCase()))
  }, [videos, searchQuery, activeTab])

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
        <h2>Upload File</h2>
        <div
          className={`drag-drop-area ${isDragOver ? 'drag-over' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <p className="drag-drop-text">Drag & drop a video or image here, or click to select</p>
          <input ref={fileInputRef} type="file" accept="video/*,image/*" onClick={onFileInputClick} onChange={onFileChange} disabled={configError} />
        </div>
        <p className="file-hint">{selectedFileLabel}</p>
        <button type="button" onClick={uploadVideo} disabled={isUploading || !selectedFile || configError} style={{ marginTop: '10px' }}>
          {isUploading ? 'Uploading...' : 'Upload to R2'}
        </button>
        {uploadProgress > 0 && uploadProgress < 100 && (
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${uploadProgress}%` }}></div>
            <span className="progress-text">{uploadProgress}%</span>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="videos-header">
          <h2>Files</h2>
          <button type="button" onClick={fetchVideos} disabled={isLoadingVideos || configError}>
            {isLoadingVideos ? 'Refreshing...' : 'Refresh'}
          </button>
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

        <div className="search-bar">
          <input
            type="text"
            placeholder="🔍 Search by name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            disabled={configError}
          />
        </div>

        {filteredVideos.length > 0 && (
          <div className="bulk-actions">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={selectedVideos.size === filteredVideos.length && filteredVideos.length > 0}
                onChange={toggleSelectAll}
              />
              Select All ({selectedVideos.size}/{filteredVideos.length})
            </label>
            {selectedVideos.size > 0 && (
              <button type="button" onClick={bulkDeleteVideos} className="btn-bulk-delete">
                🗑️ Delete {selectedVideos.size} Selected
              </button>
            )}
          </div>
        )}

        {filteredVideos.length === 0 ? (
          <p className="empty-state">
            {searchQuery ? 'No files match your search.' : 'No files found in bucket.'}
          </p>
        ) : (
           <ul className="video-list" ref={menuRef}>
             {filteredVideos.map((video) => (
               <li key={video.key} className="video-item">
                 <input
                   type="checkbox"
                   checked={selectedVideos.has(video.key)}
                   onChange={() => toggleVideoSelection(video.key)}
                   className="video-checkbox"
                 />

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
                        <button type="button" className="video-menu-item" title="Copy link" onClick={() => { copyToClipboard(video.key); setOpenMenuKey(null) }}>🔗</button>
                        <button type="button" className="video-menu-item" title="Download"  onClick={() => { downloadVideo(video.key);   setOpenMenuKey(null) }}>⬇️</button>
                        <button type="button" className="video-menu-item dangerous" title="Delete" onClick={() => { deleteVideo(video.key); setOpenMenuKey(null) }}>🗑️</button>
                      </div>
                    )}
                  </div>

                  {/* Clicking thumbnail/play opens preview */}
                  {thumbnailUrls[video.key] ? (
                    <div
                      className="video-thumbnail-wrap"
                      onClick={() => previewVideo(video.key)}
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
                    onClick={() => previewVideo(video.key)}
                  >{video.fileType === 'image' ? '🖼️' : '🎬'}</div>

                  <div className="video-info">
                    <p className="video-name">{video.fileName}</p>
                    <p className="video-meta">
                      <span className={`file-type-badge ${video.fileType}`}>{video.fileType}</span>
                      {' '}{video.sizeLabel}
                      {(video.durationSeconds || videoDurations[video.key])
                        ? <> • {formatDuration(video.durationSeconds || videoDurations[video.key])}</>
                        : null}
                    </p>
                  </div>
                  <div className="video-actions">
                    <button type="button" onClick={() => copyToClipboard(video.key)} className={`btn-copy ${copiedKey === video.key ? 'copied' : ''}`} title="Copy link">
                      {copiedKey === video.key ? '✓' : '🔗'}
                    </button>
                    <button type="button" onClick={() => downloadVideo(video.key)} className="btn-download" title="Download">⬇️</button>
                    <button type="button" onClick={() => deleteVideo(video.key)} className="btn-delete" title="Delete">🗑️</button>
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
              <button className="close-btn" onClick={closePreview}>✕</button>
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
              <button onClick={() => downloadVideo(previewKey)} className="btn-download-from-preview">
                ⬇️ Download
              </button>
              <button onClick={closePreview} className="btn-close-preview">Close</button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

export default App
