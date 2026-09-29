import { useEffect, useRef, useState } from 'react'
import { cacheFile, deleteCachedFiles, getCachedFile } from '../imageCache'

export interface PromptVaultImageRef {
  id: string
  filename: string
  mimeType: string
  cacheKey: string
}

export interface PromptVaultItem {
  id: string
  name: string
  prompt: string
  image: string
  images: string[]
  imageRefs: PromptVaultImageRef[]
}

const KEY = 'comfyui-console-prompt-vault-v1'
const TAP_DELAY = 650

function readVault(): PromptVaultItem[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function VaultImage({ cacheKey }: { cacheKey: string }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    let objectUrl = ''
    let live = true
    void getCachedFile(cacheKey).then((blob) => {
      if (live && blob) {
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      }
    })
    return () => {
      live = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [cacheKey])
  return url ? <img src={url} alt="" loading="lazy" draggable={false} /> : <div className="prompt-vault-image-empty">No image</div>
}

export function PromptVaultPage({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<PromptVaultItem[]>(readVault)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [armedId, setArmedId] = useState<string | null>(null)
  const [editing, setEditing] = useState<PromptVaultItem | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPrompt, setNewPrompt] = useState('')
  const [newImage, setNewImage] = useState<File | null>(null)
  const [newImagePreview, setNewImagePreview] = useState('')
  const armedTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const save = () => {
      setItems(readVault())
      setSelected(new Set())
      setArmedId(null)
      setEditing(null)
      if (armedTimerRef.current) window.clearTimeout(armedTimerRef.current)
    }
    window.addEventListener('prompt-vault-updated', save)
    return () => {
      window.removeEventListener('prompt-vault-updated', save)
      if (armedTimerRef.current) window.clearTimeout(armedTimerRef.current)
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(items))
  }, [items])

  useEffect(() => {
    return () => {
      if (newImagePreview) URL.revokeObjectURL(newImagePreview)
    }
  }, [newImagePreview])

  const armCard = (id: string) => {
    if (armedTimerRef.current) window.clearTimeout(armedTimerRef.current)
    if (armedId === id) {
      setArmedId(null)
      const item = items.find((entry) => entry.id === id)
      if (item) setEditing(item)
      if (navigator.vibrate) navigator.vibrate(12)
      return
    }
    setArmedId(id)
    armedTimerRef.current = window.setTimeout(() => setArmedId(null), TAP_DELAY)
  }

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const updatePrompt = (id: string, prompt: string) => {
    setItems((current) => current.map((item) => item.id === id ? { ...item, prompt } : item))
    setEditing((current) => current?.id === id ? { ...current, prompt } : current)
  }

  const sendToMainPrompt = (prompt: string) => {
    window.dispatchEvent(new CustomEvent('history-send-to-main-prompt', { detail: prompt }))
  }

  const deleteItem = async (item: PromptVaultItem) => {
    if (!window.confirm(`Delete “${item.name}” from Prompt Vault? This also removes its cached thumbnail.`)) return
    await deleteCachedFiles(item.imageRefs.map((ref) => ref.cacheKey))
    setItems((current) => current.filter((entry) => entry.id !== item.id))
    setSelected((current) => {
      const next = new Set(current)
      next.delete(item.id)
      return next
    })
    setEditing(null)
  }

  const deleteSelected = async () => {
    const chosen = items.filter((item) => selected.has(item.id))
    if (!chosen.length) return
    if (!window.confirm(`Delete ${chosen.length} selected card${chosen.length === 1 ? '' : 's'} from Prompt Vault? This also removes their cached images.`)) return
    await deleteCachedFiles(chosen.flatMap((item) => item.imageRefs.map((ref) => ref.cacheKey)))
    const ids = new Set(chosen.map((item) => item.id))
    setItems((current) => current.filter((item) => !ids.has(item.id)))
    setSelected(new Set())
  }

  const createCard = async () => {
    if (!newPrompt.trim() && !newImage) return
    const id = `vault-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const name = newName.trim() || 'Untitled Prompt'
    let imageRef: PromptVaultImageRef | undefined
    if (newImage) {
      const cacheKey = `prompt-vault-${id}`
      await cacheFile(cacheKey, newImage)
      imageRef = { id: `${id}-image`, filename: newImage.name, mimeType: newImage.type || 'image/*', cacheKey }
    }
    const item: PromptVaultItem = {
      id,
      name,
      prompt: newPrompt,
      image: '',
      images: [],
      imageRefs: imageRef ? [imageRef] : [],
    }
    setItems((current) => [...current, item])
    setCreating(false)
    setNewName('')
    setNewPrompt('')
    setNewImage(null)
    setNewImagePreview('')
  }

  const selectAll = () => setSelected(new Set(items.map((item) => item.id)))
  const allSelected = items.length > 0 && selected.size === items.length

  if (editing) {
    return (
      <section className="prompt-vault-editor-page" aria-label="Edit Prompt Vault prompt">
        <header className="prompt-vault-editor-header">
          <div>
            <h2>{editing.name}</h2>
            <span>Prompt Vault</span>
          </div>
          <button type="button" className="prompt-vault-close" onClick={() => setEditing(null)} aria-label="Close prompt editor">×</button>
        </header>
        <div className="prompt-vault-editor-body">
          {editing.imageRefs[0] && <div className="prompt-vault-editor-thumbnail"><VaultImage cacheKey={editing.imageRefs[0].cacheKey} /></div>}
          <label htmlFor="prompt-vault-editor-text">Prompt</label>
          <textarea
            id="prompt-vault-editor-text"
            autoFocus
            value={editing.prompt}
            onChange={(event) => updatePrompt(editing.id, event.target.value)}
            placeholder="Enter prompt..."
          />
          <div className="prompt-vault-editor-actions">
            <button type="button" className="prompt-vault-send-main" disabled={!editing.prompt.trim()} onClick={() => sendToMainPrompt(editing.prompt)}>Send to Main Prompt</button>
            <button type="button" className="prompt-vault-editor-delete" onClick={() => void deleteItem(editing)}>Delete Card</button>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="prompt-vault-page" aria-label="Prompt Vault">
      <header className="prompt-vault-header">
        <div className="prompt-vault-brand">
          <div>
            <h2>Prompt Vault</h2>
            <span>{items.length} saved prompt{items.length === 1 ? '' : 's'}</span>
          </div>
        </div>
        <button className="prompt-vault-close" type="button" onClick={onClose} aria-label="Close Prompt Vault">×</button>
      </header>

      <div className="prompt-vault-toolbar">
        <strong>{selected.size} selected</strong>
        <div>
          <button type="button" className="prompt-vault-new" onClick={() => setCreating(true)}>New Card</button>
          <button type="button" className="prompt-vault-select-all" onClick={() => allSelected ? setSelected(new Set()) : selectAll()} disabled={!items.length}>{allSelected ? 'Clear All' : 'Select All'}</button>
          <button type="button" className="prompt-vault-delete" onClick={() => void deleteSelected()} disabled={!selected.size}>Delete Selected</button>
        </div>
      </div>

      <div className="prompt-vault-list">
        {items.map((item) => (
          <article
            className={`prompt-vault-card${armedId === item.id ? ' armed' : ''}${selected.has(item.id) ? ' selected' : ''}`}
            key={item.id}
            onClick={() => armCard(item.id)}
            onContextMenu={(event) => event.preventDefault()}
            aria-label={`${item.name}. Single tap highlights. Double tap opens prompt editor.`}
          >
            <div className="prompt-vault-card-image">
              {item.imageRefs[0] ? <VaultImage cacheKey={item.imageRefs[0].cacheKey} /> : <div className="prompt-vault-image-empty">No image</div>}
            </div>
            <button
              type="button"
              className="prompt-vault-select"
              onClick={(event) => { event.stopPropagation(); toggleSelected(item.id) }}
              aria-label={selected.has(item.id) ? `Deselect ${item.name}` : `Select ${item.name}`}
              aria-pressed={selected.has(item.id)}
            >{selected.has(item.id) ? '✓' : ''}</button>
            <div className="prompt-vault-card-body">
              <strong title={item.name}>{item.name}</strong>
              <div className="prompt-vault-prompt" title={item.prompt || 'No prompt provided.'}>{item.prompt || 'No prompt provided.'}</div>
            </div>
          </article>
        ))}
        {!items.length && <div className="prompt-vault-empty"><strong>Prompt Vault is empty</strong><span>Create a card or move imported cards from Datasets here.</span></div>}
      </div>

      {creating && (
        <div className="prompt-vault-modal-backdrop" onClick={() => setCreating(false)}>
          <section className="prompt-vault-create-modal" onClick={(event) => event.stopPropagation()}>
            <header><div><h2>New Card</h2><span>Create a Prompt Vault card</span></div><button type="button" className="prompt-vault-close" onClick={() => setCreating(false)}>×</button></header>
            <label className="prompt-vault-create-field">Name<input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Card name" /></label>
            <label className="prompt-vault-create-field">Thumbnail<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => {
              const file = event.target.files?.[0] || null
              if (newImagePreview) URL.revokeObjectURL(newImagePreview)
              setNewImage(file)
              setNewImagePreview(file ? URL.createObjectURL(file) : '')
            }} /></label>
            {newImagePreview && <img className="prompt-vault-create-preview" src={newImagePreview} alt="Thumbnail preview" />}
            <label className="prompt-vault-create-field">Prompt<textarea value={newPrompt} onChange={(event) => setNewPrompt(event.target.value)} placeholder="Enter prompt..." rows={8} /></label>
            <div className="prompt-vault-create-actions"><button type="button" onClick={() => setCreating(false)}>Cancel</button><button type="button" className="prompt-vault-send-main" onClick={() => void createCard()} disabled={!newPrompt.trim() && !newImage}>Create Card</button></div>
          </section>
        </div>
      )}
    </section>
  )
}
