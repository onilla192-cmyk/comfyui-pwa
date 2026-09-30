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
  const inputRef = useRef<HTMLInputElement | null>(null)
  const armTimer = useRef<number | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(GALLERY_STORAGE_KEY, JSON.stringify(items))
    } catch {}
  }, [items])

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
          <span>{items.length} image{items.length === 1 ? '' : 's'}</span>
        </div>
      </header>

      <div className="gallery-grid">
        <button type="button" className="gallery-add-card" onClick={() => inputRef.current?.click()}>
          <span className="gallery-add-icon">+</span>
          <strong>Add Image</strong>
          <span>Upload an image</span>
          <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={(e) => { addImages(e.target.files); e.currentTarget.value = '' }} />
        </button>

        {items.map((item) => (
          <button
            type="button"
            className={'gallery-card' + (armedId === item.id ? ' gallery-card-armed' : '')}
            key={item.id}
            onClick={() => tapItem(item)}
            aria-label={'Open ' + item.name}
          >
            <img src={item.src} alt={item.name} loading="lazy" draggable={false} />
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
