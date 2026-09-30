import { useEffect, useRef, useState } from 'react'

interface GalleryItem {
  id: string
  name: string
  prompt: string
  src: string
  createdAt: number
}

const GALLERY_STORAGE_KEY = 'comfyui-pwa-gallery-v1'

function loadGallery(): GalleryItem[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(GALLERY_STORAGE_KEY) || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function ImageGalleryPage({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<GalleryItem[]>(loadGallery)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(GALLERY_STORAGE_KEY, JSON.stringify(items))
    } catch {
      // Keep the current gallery visible if storage is full.
    }
  }, [items])

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
          prompt: '',
          src,
          createdAt: Date.now(),
        }, ...current])
      }
      reader.readAsDataURL(file)
    })
  }

  function updatePrompt(id: string, prompt: string) {
    setItems((current) => current.map((item) => item.id === id ? { ...item, prompt } : item))
  }

  function removeItem(id: string) {
    setItems((current) => current.filter((item) => item.id !== id))
  }

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
          <article className="gallery-card" key={item.id}>
            <div className="gallery-card-image">
              <img src={item.src} alt={item.name} loading="lazy" />
              <button type="button" className="gallery-delete-btn" onClick={() => removeItem(item.id)} aria-label={'Delete ' + item.name} title="Delete">×</button>
            </div>
            <div className="gallery-card-body">
              <textarea value={item.prompt} onChange={(e) => updatePrompt(item.id, e.target.value)} placeholder="Prompt..." aria-label={'Prompt for ' + item.name} rows={2} />
              <div className="gallery-card-name">{item.name}</div>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}
