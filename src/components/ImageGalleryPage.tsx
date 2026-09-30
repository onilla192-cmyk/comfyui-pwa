import { useEffect, useRef, useState } from 'react'

interface GalleryItem {
  id: string
  name: string
  src: string
  createdAt: number
}

type Figure = 'one' | 'two'

const GALLERY_STORAGE_KEY = 'comfyui-pwa-gallery-v1'

function loadGallery(): GalleryItem[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(GALLERY_STORAGE_KEY) || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function openGalleryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(GALLERY_DB_NAME, GALLERY_DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(GALLERY_STORE_NAME)) db.createObjectStore(GALLERY_STORE_NAME, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Could not open gallery storage'))
  })
}

async function readGalleryDb(): Promise<GalleryItem[]> {
  const db = await openGalleryDb()
  return new Promise((resolve, reject) => {
    const request = db.transaction(GALLERY_STORE_NAME, 'readonly').objectStore(GALLERY_STORE_NAME).getAll()
    request.onsuccess = () => {
      db.close()
      resolve((request.result || []).sort((a: GalleryItem, b: GalleryItem) => b.createdAt - a.createdAt))
    }
    request.onerror = () => {
      db.close()
      reject(request.error || new Error('Could not read gallery storage'))
    }
  })
}

async function writeGalleryDb(items: GalleryItem[]): Promise<void> {
  const db = await openGalleryDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(GALLERY_STORE_NAME, 'readwrite')
    const store = tx.objectStore(GALLERY_STORE_NAME)
    store.clear()
    items.forEach((item) => store.put(item))
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not save gallery')) }
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Could not save gallery')) }
  })
}

async function migrateLegacyGallery(): Promise<GalleryItem[]> {
  const existing = await readGalleryDb()
  if (existing.length) return existing
  const legacy = loadGallery()
  if (legacy.length) await writeGalleryDb(legacy)
  return legacy
}

export function ImageGalleryPage({
  onClose,
  onSetFigure,
}: {
  onClose: () => void
  onSetFigure: (which: Figure, item: GalleryItem) => void
}) {
  const [items, setItems] = useState<GalleryItem[]>(loadGallery)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [armedId, setArmedId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [multiSelectMode, setMultiSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [storageReady, setStorageReady] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const armTimer = useRef<number | null>(null)

  useEffect(() => {
    let active = true
    void migrateLegacyGallery().then((stored) => {
      if (active) {
        setItems(stored)
        setStorageReady(true)
      }
    }).catch(() => {
      if (active) {
        setItems(loadGallery())
        setStorageReady(true)
      }
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!storageReady) return
    void writeGalleryDb(items)
  }, [items, storageReady])

  useEffect(() => () => {
    if (armTimer.current) window.clearTimeout(armTimer.current)
  }, [])

  function addImages(files: FileList | null) {
    if (!files?.length) return
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith('image/')) return
      const reader = new FileReader()
      reader.onload = () => {
        const src = typeof reader.result === 'string' ? reader.result : ''
        if (!src) return
        setItems((current) => [{
          id: 'gallery-' + Date.now() + '-' + Math.random().toString(36).slice(2),
          name: file.name,
          src,
          createdAt: Date.now(),
        }, ...current])
      }
      reader.readAsDataURL(file)
    })
  }

  function tapItem(item: GalleryItem) {
    if (navigator.vibrate) navigator.vibrate(18)
    if (multiSelectMode) {
      setSelectedIds((current) => {
        const next = new Set(current)
        if (next.has(item.id)) next.delete(item.id)
        else next.add(item.id)
        return next
      })
      return
    }
    if (armedId === item.id) {
      if (armTimer.current) window.clearTimeout(armTimer.current)
      setArmedId(null)
      setSelectedId(item.id)
      return
    }
    setArmedId(item.id)
    if (armTimer.current) window.clearTimeout(armTimer.current)
    armTimer.current = window.setTimeout(() => {
      setArmedId((current) => current === item.id ? null : current)
    }, 850)
  }

  function toggleMultiSelect() {
    setMultiSelectMode((current) => !current)
    setSelectedIds(new Set())
    setSelectedId(null)
    setArmedId(null)
    setSidebarOpen(false)
  }

  function deleteSelected() {
    if (!selectedIds.size) return
    setItems((current) => current.filter((item) => !selectedIds.has(item.id)))
    setSelectedIds(new Set())
    setMultiSelectMode(false)
  }

  function deleteItem(id: string) {
    setItems((current) => current.filter((item) => item.id !== id))
    setSelectedId(null)
    setArmedId(null)
  }

  const selected = items.find((item) => item.id === selectedId) || null

  return (
    <div className="gallery-page">
      <header className="gallery-page-header">
        <button type="button" className="gallery-back-btn" onClick={onClose} aria-label="Back to editor">←</button>
        <div>
          <h1>Image Gallery</h1>
          <span>{items.length} image{items.length === 1 ? '' : 's'}{multiSelectMode && selectedIds.size ? ' • ' + selectedIds.size + ' selected' : ''}</span>
        </div>
        <button
          type="button"
          className="gallery-menu-btn"
          onClick={() => setSidebarOpen(true)}
          aria-label="Open gallery menu"
          aria-expanded={sidebarOpen}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
      </header>

      <div className={'gallery-grid' + (multiSelectMode ? ' gallery-grid-multiselect' : '')}>
        <button type="button" className="gallery-add-card" onClick={() => inputRef.current?.click()}>
          <span className="gallery-add-icon">+</span>
          <strong>Add Image</strong>
          <span>Upload an image</span>
          <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={(e) => { addImages(e.target.files); e.currentTarget.value = '' }} />
        </button>

        {items.map((item) => (
          <button
            type="button"
            className={'gallery-card' + (armedId === item.id ? ' gallery-card-armed' : '') + (selectedIds.has(item.id) ? ' gallery-card-selected' : '')}
            key={item.id}
            onClick={() => tapItem(item)}
            aria-label={multiSelectMode ? ((selectedIds.has(item.id) ? 'Deselect ' : 'Select ') + item.name) : 'Open ' + item.name}
            aria-pressed={multiSelectMode ? selectedIds.has(item.id) : undefined}
          >
            <img src={item.src} alt={item.name} loading="lazy" draggable={false} />
            {multiSelectMode && <span className="gallery-select-mark" aria-hidden="true">{selectedIds.has(item.id) ? '✓' : ''}</span>}
          </button>
        ))}
      </div>

      {sidebarOpen && (
        <div className="gallery-sidebar-backdrop" onClick={() => setSidebarOpen(false)}>
          <aside className="gallery-sidebar" onClick={(e) => e.stopPropagation()}>
            <div className="gallery-sidebar-header">
              <h2>Gallery Menu</h2>
              <button type="button" className="gallery-sidebar-close" onClick={() => setSidebarOpen(false)} aria-label="Close gallery menu">×</button>
            </div>
            <button type="button" className={'gallery-sidebar-action' + (multiSelectMode ? ' active' : '')} onClick={toggleMultiSelect}>
              <span className="gallery-sidebar-action-icon">✓</span>
              <span>{multiSelectMode ? 'Exit Multiselect' : 'Multiselect'}</span>
            </button>
            {multiSelectMode && (
              <div className="gallery-batch-actions">
                <span>{selectedIds.size} selected</span>
                <button type="button" className="gallery-batch-delete" disabled={!selectedIds.size} onClick={deleteSelected}>Delete Selected</button>
                <button type="button" className="gallery-batch-cancel" onClick={toggleMultiSelect}>Cancel</button>
              </div>
            )}
          </aside>
        </div>
      )}

      {selected && (
        <div className="gallery-viewer-backdrop" onClick={() => setSelectedId(null)}>
          <section className="gallery-viewer" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="gallery-viewer-close" onClick={() => setSelectedId(null)} aria-label="Close image">×</button>
            <div className="gallery-viewer-image-wrap">
              <img src={selected.src} alt={selected.name} />
            </div>
            <div className="gallery-viewer-actions">
              <button type="button" onClick={() => { onSetFigure('one', selected); setSelectedId(null) }}>Figure A</button>
              <button type="button" onClick={() => { onSetFigure('two', selected); setSelectedId(null) }}>Figure B</button>
              <button type="button" className="gallery-viewer-delete" onClick={() => deleteItem(selected.id)}>Delete</button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
