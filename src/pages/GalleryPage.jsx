import { useEffect, useMemo, useState } from 'react'
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import './pages.css'

const VIDEO_EXTS = /\.(mp4|mov|avi|mkv|webm|m4v|flv|wmv|3gp)$/i
const IMAGE_EXTS = /\.(jpg|jpeg|png|gif|webp|bmp|avif|svg)$/i

const bucketName = import.meta.env.VITE_R2_BUCKET_NAME || 'movieui'

const COLLECTIONS = [
  { id: 'all', label: 'All', keywords: [] },
  { id: 'pre-wedding', label: 'Pre-Wedding', keywords: ['prewed', 'pre-wedding', 'prewedding', 'save-the-date', 'save_date'] },
  { id: 'events', label: 'Events', keywords: ['ceremony', 'wedding', 'muhurtham', 'ritual', 'mandap', 'reception', 'stage', 'party', 'dance', 'sangeet', 'family', 'parents', 'brother', 'sister', 'relatives'] },
  { id: 'candid', label: 'Candid', keywords: ['candid', 'candids', 'smile', 'laugh', 'fun'] },
]

const r2Client = new S3Client({
  region: 'auto',
  endpoint: import.meta.env.VITE_R2_ENDPOINT || 'https://577a1c11c46c1edf27c9f3243acc797a.r2.cloudflarestorage.com',
  credentials: {
    accessKeyId: import.meta.env.VITE_R2_ACCESS_KEY_ID,
    secretAccessKey: import.meta.env.VITE_R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
})

const getFileType = (fileName = '') => {
  if (VIDEO_EXTS.test(fileName)) return 'video'
  if (IMAGE_EXTS.test(fileName)) return 'image'
  return 'other'
}

const parseObjectKey = (key = '') => {
  const encodedMatch = key.match(/^\d+__dur-(\d+)__(.+)$/)
  if (encodedMatch) return { fileName: encodedMatch[2], durationSeconds: Number(encodedMatch[1]) }
  return { fileName: key.split('-').slice(2).join('-') || key, durationSeconds: null }
}

const formatDate = (value) => {
  if (!value) return 'Unknown date'
  try {
    return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(new Date(value))
  } catch {
    return String(value)
  }
}

export default function GalleryPage() {
  const [items, setItems] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeCollection, setActiveCollection] = useState('all')
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('newest')
  const [viewMode, setViewMode] = useState('grid')
  const [previewIndex, setPreviewIndex] = useState(-1)
  const [previewUrl, setPreviewUrl] = useState('')
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)
  const [thumbnailUrls, setThumbnailUrls] = useState({})

  useEffect(() => {
    const load = async () => {
      setIsLoading(true)
      setError('')
      try {
        let allItems = []
        let continuationToken = undefined
        do {
          const response = await r2Client.send(new ListObjectsV2Command({
            Bucket: bucketName,
            ContinuationToken: continuationToken,
          }))
          allItems = [...allItems, ...(response.Contents ?? [])]
          continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
        } while (continuationToken)

        const collectionMap = {}
        const collectionObjectSet = new Set()

        let collectionToken = undefined
        do {
          const collectionList = await r2Client.send(new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: '__collections__/',
            ContinuationToken: collectionToken,
          }))
          ;(collectionList.Contents ?? []).forEach((item) => {
            if (item?.Key) collectionObjectSet.add(item.Key)
          })
          collectionToken = collectionList.IsTruncated ? collectionList.NextContinuationToken : undefined
        } while (collectionToken)

        const normalized = allItems
          .filter((obj) => obj?.Key)
          .filter((obj) => !obj.Key.startsWith('thumbnails/') && !obj.Key.startsWith('__likes__/') && !obj.Key.startsWith('__owners__/') && !obj.Key.startsWith('__guest_names__/') && !obj.Key.startsWith('__collections__/'))
          .map((obj) => {
            const parsed = parseObjectKey(obj.Key)
            return {
              key: obj.Key,
              fileName: parsed.fileName,
              fileType: getFileType(parsed.fileName),
              lastModified: obj.LastModified,
            }
          })
          .filter((obj) => obj.fileType === 'image' || obj.fileType === 'video')

        for (const item of normalized) {
          const collectionObjectKey = `__collections__/${encodeURIComponent(item.key)}.json`
          if (!collectionObjectSet.has(collectionObjectKey)) continue
          try {
            const collectionResponse = await r2Client.send(new GetObjectCommand({
              Bucket: bucketName,
              Key: collectionObjectKey,
            }))
            const collectionText = await collectionResponse.Body.transformToString()
            const collectionData = JSON.parse(collectionText)
            collectionMap[item.key] = collectionData?.collectionId || null
          } catch {
            collectionMap[item.key] = null
          }
        }

        const enriched = normalized.map((item) => ({
          ...item,
          collectionId: collectionMap[item.key] || null,
        }))

        setItems(enriched)

        // Load thumbnails from R2
        try {
          const existingThumbKeys = new Set()
          let thumbToken = undefined
          do {
            const thumbList = await r2Client.send(new ListObjectsV2Command({
              Bucket: bucketName,
              Prefix: 'thumbnails/',
              ContinuationToken: thumbToken,
            }))
            ;(thumbList.Contents ?? []).forEach((t) => existingThumbKeys.add(t.Key))
            thumbToken = thumbList.IsTruncated ? thumbList.NextContinuationToken : undefined
          } while (thumbToken)

          const thumbEntries = await Promise.all(
            enriched.map(async (item) => {
              try {
                const thumbKey = `thumbnails/${item.key}.jpg`
                if (!existingThumbKeys.has(thumbKey)) return [item.key, null]
                const url = await getSignedUrl(r2Client, new GetObjectCommand({ Bucket: bucketName, Key: thumbKey }), { expiresIn: 60 * 60 })
                return [item.key, url]
              } catch {
                return [item.key, null]
              }
            })
          )
          setThumbnailUrls(Object.fromEntries(thumbEntries.filter(([, url]) => url !== null)))
        } catch {
          // thumbnails non-critical
        }

      } catch (err) {
        setError(`Failed to load gallery: ${err.message}`)
      } finally {
        setIsLoading(false)
      }
    }

    void load()
  }, [])

  const detectCollection = (item) => {
    if (item?.collectionId && COLLECTIONS.some((collection) => collection.id === item.collectionId)) {
      return item.collectionId
    }
    const fileName = item?.fileName || ''
    const lower = fileName.toLowerCase()
    for (const collection of COLLECTIONS) {
      if (collection.id === 'all') continue
      if (collection.keywords.some((keyword) => lower.includes(keyword))) return collection.id
    }
    return 'candid'
  }

  const collectionCounts = useMemo(() => {
    const counts = Object.fromEntries(COLLECTIONS.map((collection) => [collection.id, 0]))
    counts.all = items.length
    items.forEach((item) => {
      const collectionId = detectCollection(item)
      counts[collectionId] = (counts[collectionId] || 0) + 1
    })
    return counts
  }, [items])

  const filteredItems = useMemo(() => {
    let next = [...items]

    if (activeCollection !== 'all') {
      next = next.filter((it) => detectCollection(it) === activeCollection)
    }

    if (search.trim()) {
      const query = search.trim().toLowerCase()
      next = next.filter((it) => it.fileName.toLowerCase().includes(query))
    }

    if (sortBy === 'newest') next.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified))
    if (sortBy === 'oldest') next.sort((a, b) => new Date(a.lastModified) - new Date(b.lastModified))

    return next
  }, [items, activeCollection, search, sortBy])

  const openPreview = async (index) => {
    const target = filteredItems[index]
    if (!target) return
    setPreviewIndex(index)
    setIsLoadingPreview(true)
    try {
      const signed = await getSignedUrl(
        r2Client,
        new GetObjectCommand({ Bucket: bucketName, Key: target.key }),
        { expiresIn: 60 * 10 }
      )
      setPreviewUrl(signed)
    } catch (err) {
      setError(`Preview failed: ${err.message}`)
      setPreviewIndex(-1)
    } finally {
      setIsLoadingPreview(false)
    }
  }

  const closePreview = () => {
    setPreviewIndex(-1)
    setPreviewUrl('')
  }

  const navigatePreview = async (direction) => {
    if (filteredItems.length < 2) return
    const nextIndex = (previewIndex + direction + filteredItems.length) % filteredItems.length
    await openPreview(nextIndex)
  }

  const downloadCurrent = () => {
    const target = filteredItems[previewIndex]
    if (!target || !previewUrl) return
    const a = document.createElement('a')
    a.href = previewUrl
    a.download = target.fileName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  return (
    <main className="invite-page-shell gallery-page-shell">
      <header className="invite-page-header">
        <a className="invite-back-link" href="#/">← Back to Main</a>
        <h1>Gallery</h1>
        <p>A glimpse of our beautiful moments.</p>
      </header>

      <section className="invite-card gallery-toolbar-card">
        <div className="gallery-collection-tabs" role="tablist" aria-label="Gallery collection filters">
          {COLLECTIONS.map((collection) => (
            <button
              key={collection.id}
              type="button"
              className={`gallery-collection-btn${activeCollection === collection.id ? ' active' : ''}`}
              onClick={() => setActiveCollection(collection.id)}
            >
              {collection.label}
            </button>
          ))}
        </div>

        <div className="gallery-toolbar-controls">
          <input
            type="text"
            className="gallery-search"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select className="gallery-sort" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
          </select>
          <div className="gallery-view-toggle">
            <button type="button" className={viewMode === 'grid' ? 'active' : ''} onClick={() => setViewMode('grid')} title="Grid view">⊞</button>
            <button type="button" className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')} title="List view">≡</button>
          </div>
        </div>
      </section>

      {error ? <section className="invite-card"><p className="gallery-error">{error}</p></section> : null}

      <section className="invite-card gallery-content-card">
        {isLoading ? (
          <ul className="gallery-media-list grid-mode">
            {Array.from({ length: 9 }).map((_, i) => (
              <li key={i} className="gallery-media-item">
                <div className="gallery-thumb-skeleton" />
              </li>
            ))}
          </ul>
        ) : filteredItems.length === 0 ? (
          <p className="gallery-empty">No media found for this filter.</p>
        ) : viewMode === 'grid' ? (
          <ul className="gallery-media-list grid-mode">
            {filteredItems.map((item, index) => (
              <li key={item.key} className="gallery-media-item">
                <button type="button" className="gallery-thumb-btn" onClick={() => openPreview(index)}>
                  {thumbnailUrls[item.key] ? (
                    <img
                      src={thumbnailUrls[item.key]}
                      alt={item.fileName}
                      className="gallery-thumb-img"
                      loading="lazy"
                    />
                  ) : (
                    <span className="gallery-thumb-placeholder">
                      {item.fileType === 'image' ? '🖼️' : '🎬'}
                    </span>
                  )}
                  {item.fileType === 'video' && (
                    <span className="gallery-thumb-video-badge" aria-hidden="true">▶</span>
                  )}
                  <span className="gallery-thumb-overlay">
                    <span className="gallery-thumb-date">{formatDate(item.lastModified)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="gallery-media-list list-mode">
            {filteredItems.map((item, index) => (
              <li key={item.key} className="gallery-media-item">
                <button type="button" className="gallery-media-card" onClick={() => openPreview(index)}>
                  <span className="gallery-list-thumb">
                    {thumbnailUrls[item.key] ? (
                      <img src={thumbnailUrls[item.key]} alt={item.fileName} className="gallery-list-thumb-img" loading="lazy" />
                    ) : (
                      <span className="gallery-media-icon" aria-hidden="true">{item.fileType === 'image' ? '🖼️' : '🎬'}</span>
                    )}
                    {item.fileType === 'video' && <span className="gallery-list-video-badge">▶</span>}
                  </span>
                  <span className="gallery-media-meta">
                    <strong title={item.fileName}>{item.fileName}</strong>
                    <small>{formatDate(item.lastModified)}</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {previewIndex >= 0 ? (
        <div className="preview-modal-overlay" onClick={closePreview}>
          <div className="preview-modal gallery-preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="preview-header">
              <h3>{filteredItems[previewIndex]?.fileName || ''}</h3>
              <div className="gallery-preview-actions-head">
                <span style={{ fontSize: '0.8rem', color: 'var(--text)' }}>{previewIndex + 1} / {filteredItems.length}</span>
                <button type="button" className="close-btn" onClick={closePreview}>✕</button>
              </div>
            </div>

            <div className="gallery-preview-body">
              {isLoadingPreview ? (
                <p className="gallery-empty">Loading preview...</p>
              ) : filteredItems[previewIndex]?.fileType === 'video' ? (
                <video className="gallery-preview-media" src={previewUrl} controls autoPlay />
              ) : (
                <img className="gallery-preview-media" src={previewUrl} alt="preview" />
              )}
            </div>

            <div className="preview-actions">
              <button type="button" className="btn-nav-preview" onClick={() => navigatePreview(-1)}>← Prev</button>
              <button type="button" className="btn-download-from-preview" onClick={downloadCurrent}>⬇ Download</button>
              <button type="button" className="btn-nav-preview" onClick={() => navigatePreview(1)}>Next →</button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}
