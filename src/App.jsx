import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { S3Client, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3'
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

  // Check if R2 credentials are configured and load any resumed session
  useEffect(() => {
    if (!import.meta.env.VITE_R2_ACCESS_KEY_ID || !import.meta.env.VITE_R2_SECRET_ACCESS_KEY) {
      setConfigError('R2 credentials not configured in .env.local')
    } else {
      fetchVideos()
    }
  }, [])

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
        .filter((item) => item.Key)
        .map((item) => {
          const parsed = parseObjectKey(item.Key)
          return {
            key: item.Key,
            fileName: parsed.fileName,
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
    } catch (error) {
      setStatus(`Failed to load videos: ${error.message}`)
    } finally {
      setIsLoadingVideos(false)
    }
  }

  const onFileChange = (event) => {
    const nextFile = event.target.files?.[0] ?? null
    setSelectedFile(nextFile)
  }

  const onFileInputClick = (event) => {
    // Allow selecting the same file again without needing a page refresh.
    event.target.value = ''
  }

  const uploadVideoMultipart = async () => {
    const fileToUpload = selectedFile

    if (!fileToUpload) {
      setStatus('Select a video file first.')
      return
    }

    if (configError) {
      setStatus('R2 credentials not configured. Set environment variables in .env.local')
      return
    }

    setStatus('Reading video metadata...')
    const durationSeconds = await readFileDurationSeconds(fileToUpload)

    setIsUploading(true)
    const objectKey = buildObjectKey(fileToUpload.name, durationSeconds)
    let uploadIdToUse = null

    try {
      const totalParts = Math.ceil(fileToUpload.size / CHUNK_SIZE)
      setStatus('Initializing multipart upload...')
      const createCommand = new CreateMultipartUploadCommand({
        Bucket: bucketName,
        Key: objectKey,
        ContentType: fileToUpload.type || 'video/mp4',
      })
      const createResponse = await r2Client.send(createCommand)
      uploadIdToUse = createResponse.UploadId

      // Upload parts
      const uploadedParts = {}
      let uploadedBytes = 0

      for (let partNum = 1; partNum <= totalParts; partNum++) {
        const start = (partNum - 1) * CHUNK_SIZE
        const end = Math.min(start + CHUNK_SIZE, fileToUpload.size)
        const partData = fileToUpload.slice(start, end)
        const partBuffer = await partData.arrayBuffer()

        // Retry logic for part upload
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
        const progress = Math.round((uploadedBytes / fileToUpload.size) * 100)
        setUploadProgress(Math.min(progress, 99))
      }

      // Complete multipart upload
      setStatus('Finalizing upload...')
      const sortedParts = Object.entries(uploadedParts)
        .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
        .map(([partNum, ETag]) => ({ PartNumber: parseInt(partNum), ETag }))

      const completeCommand = new CompleteMultipartUploadCommand({
        Bucket: bucketName,
        Key: objectKey,
        UploadId: uploadIdToUse,
        MultipartUpload: { Parts: sortedParts },
      })
      await r2Client.send(completeCommand)

      setStatus('✅ Upload completed successfully.')
      setSelectedFile(null)
      if (durationSeconds > 0) {
        setVideoDurations((prev) => ({ ...prev, [objectKey]: durationSeconds }))
      }
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
      setUploadProgress(0)
      await fetchVideos()
    } catch (error) {
      // Ensure partial multipart session does not remain if upload fails.
      if (uploadIdToUse) {
        try {
          await r2Client.send(new AbortMultipartUploadCommand({
            Bucket: bucketName,
            Key: objectKey,
            UploadId: uploadIdToUse,
          }))
        } catch {
          // Ignore abort errors; primary error is shown below.
        }
      }

      setStatus(`Upload failed. Please try again from start. Error: ${error.message}`)
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
      const command = new GetObjectCommand({
        Bucket: bucketName,
        Key: key,
      })

      // Stream preview directly from R2 with a short-lived signed URL.
      const url = await getSignedUrl(r2Client, command, { expiresIn: 60 * 10 })

      setPreviewKey(key)
      setPreviewUrl(url)
      setStatus('Preview ready.')
    } catch (error) {
      setStatus(`Preview failed: ${error.message}`)
    } finally {
      setIsLoadingPreview(false)
    }
  }

  const closePreview = () => {
    if (previewUrl && previewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(previewUrl)
    }
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

      setStatus('Download started.')
      setDownloadProgress(0)
    } catch (error) {
      setStatus(`Download failed: ${error.message}`)
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
      setStatus('Video deleted successfully.')
      await fetchVideos()
    } catch (error) {
      setStatus(`Delete failed: ${error.message}`)
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
      setStatus(`Deleted ${deleted} video(s) successfully.`)
      setSelectedVideos(new Set())
      await fetchVideos()
    } catch (error) {
      setStatus(`Bulk delete failed: ${error.message}`)
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
    setStatus(`Link copied to clipboard!`)
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
      if (!file.type.startsWith('video/')) {
        setStatus('Please drop a video file.')
        return
      }
      setSelectedFile(file)
      setStatus(`Selected: ${file.name}`)
    }
  }

  const filteredVideos = useMemo(() => {
    if (!searchQuery.trim()) return videos
    return videos.filter(v =>
      v.fileName.toLowerCase().includes(searchQuery.toLowerCase())
    )
  }, [videos, searchQuery])

  return (
    <main className="app-shell">
      <h1>Video Vault (Cloudflare R2)</h1>
      <p className="subtitle">Upload and download videos directly to R2 (no backend required).</p>

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
        <h2>Upload Video</h2>
        <div
          className={`drag-drop-area ${isDragOver ? 'drag-over' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <p className="drag-drop-text">Drag & drop a video here, or click to select</p>
          <input ref={fileInputRef} type="file" accept="video/*" onClick={onFileInputClick} onChange={onFileChange} disabled={configError} />
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
          <h2>Available Videos</h2>
          <button type="button" onClick={fetchVideos} disabled={isLoadingVideos || configError}>
            {isLoadingVideos ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        <div className="search-bar">
          <input
            type="text"
            placeholder="🔍 Search videos by name..."
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
              <button
                type="button"
                onClick={bulkDeleteVideos}
                className="btn-bulk-delete"
              >
                🗑️ Delete {selectedVideos.size} Selected
              </button>
            )}
          </div>
        )}

        {filteredVideos.length === 0 ? (
          <p className="empty-state">
            {searchQuery ? 'No videos match your search.' : 'No videos found in bucket.'}
          </p>
        ) : (
          <ul className="video-list">
            {filteredVideos.map((video) => (
              <li key={video.key} className="video-item">
                <input
                  type="checkbox"
                  checked={selectedVideos.has(video.key)}
                  onChange={() => toggleVideoSelection(video.key)}
                  className="video-checkbox"
                />
                <div className="video-info">
                  <p className="video-name">{video.fileName}</p>
                  <p className="video-meta">
                    {video.sizeLabel}
                    {(video.durationSeconds || videoDurations[video.key])
                      ? <> • {formatDuration(video.durationSeconds || videoDurations[video.key])}</>
                      : null}
                  </p>
                </div>
                <div className="video-actions">
                  <button
                    type="button"
                    onClick={() => previewVideo(video.key)}
                    disabled={isLoadingPreview}
                    className="btn-preview"
                  >
                    👁️
                  </button>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(video.key)}
                    className={`btn-copy ${copiedKey === video.key ? 'copied' : ''}`}
                    title="Copy shareable link"
                  >
                    {copiedKey === video.key ? '✓' : '🔗'}
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadVideo(video.key)}
                    className="btn-download"
                  >
                    ⬇️
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteVideo(video.key)}
                    className="btn-delete"
                  >
                    🗑️
                  </button>
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
              <h3>Video Preview</h3>
              <button className="close-btn" onClick={closePreview}>✕</button>
            </div>
            <video
              src={previewUrl}
              controls
              autoPlay
              preload="metadata"
              onLoadedMetadata={(e) => {
                if (previewKey) extractDuration(e, previewKey)
              }}
              className="preview-video"
              style={{ width: '100%', maxHeight: '70vh' }}
            />
            <div className="preview-actions">
              <button onClick={() => downloadVideo(previewKey)} className="btn-download-from-preview">
                ⬇️ Download This Video
              </button>
              <button onClick={closePreview} className="btn-close-preview">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

export default App
