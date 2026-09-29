import { useEffect, useState } from 'react'
import { deleteCachedFiles, getCachedFile } from '../imageCache'

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

  return url
    ? <img src={url} alt="" loading="lazy" draggable={false} />
    : <div className="prompt-vault-image-empty">No image</div>
}

export function PromptVaultPage({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<PromptVaultItem[]>(readVault)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    const save = () => {
      setItems(readVault())
      setSelected(new Set())
    }
    window.addEventListener('prompt-vault-updated', save)
    return () => window.removeEventListener('prompt-vault-updated', save)
  }, [])

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(items))
  }, [items])

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const deleteSelected = async () => {
    const chosen = items.filter((item) => selected.has(item.id))
    if (!chosen.length) return
    if (!window.confirm(`Delete ${chosen.length} selected card${chosen.length === 1 ? '' : 's'} from Prompt Vault? This also removes their cached images.`)) return
    const keys = chosen.flatMap((item) => item.imageRefs.map((ref) => ref.cacheKey))
    await deleteCachedFiles(keys)
    const ids = new Set(chosen.map((item) => item.id))
    setItems((current) => current.filter((item) => !ids.has(item.id)))
    setSelected(new Set())
  }

  const selectAll = () => setSelected(new Set(items.map((item) => item.id)))
  const allSelected = items.length > 0 && selected.size === items.length

  return (
    <section className="prompt-vault-page" aria-label="Prompt Vault">
      <header className="prompt-vault-header">
        <div className="prompt-vault-brand">
          <span className="prompt-vault-brand-badge" aria-hidden="true">★</span>
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
          <button type="button" className="prompt-vault-select-all" onClick={() => allSelected ? setSelected(new Set()) : selectAll()} disabled={!items.length}>
            {allSelected ? 'Clear All' : 'Select All'}
          </button>
          <button type="button" className="prompt-vault-delete" onClick={() => void deleteSelected()} disabled={!selected.size}>
            Delete Selected
          </button>
        </div>
      </div>

      <div className="prompt-vault-list">
        {items.map((item, index) => (
          <article className={`prompt-vault-card${selected.has(item.id) ? ' selected' : ''}`} key={item.id}>
            <div className="prompt-vault-card-ribbon" aria-hidden="true" />
            <button
              type="button"
              className="prompt-vault-select"
              onClick={() => toggleSelected(item.id)}
              aria-label={selected.has(item.id) ? `Deselect ${item.name}` : `Select ${item.name}`}
              aria-pressed={selected.has(item.id)}
            >
              {selected.has(item.id) ? '✓' : ''}
            </button>
            <div className="prompt-vault-card-image">
              {item.imageRefs[0]
                ? <VaultImage cacheKey={item.imageRefs[0].cacheKey} />
                : <div className="prompt-vault-image-empty">No image</div>}
              <span className="prompt-vault-number">{index + 1}</span>
            </div>
            <div className="prompt-vault-card-body">
              <strong title={item.name}>{item.name}</strong>
              <div className="prompt-vault-prompt" title={item.prompt || 'No prompt provided.'}>
                {item.prompt || 'No prompt provided.'}
              </div>
              {item.imageRefs.length > 1 && <span className="prompt-vault-image-count">{item.imageRefs.length} images</span>}
            </div>
          </article>
        ))}
        {!items.length && (
          <div className="prompt-vault-empty">
            <strong>Prompt Vault is empty</strong>
            <span>Move imported cards from Datasets here to keep your favorite prompts in one place.</span>
          </div>
        )}
      </div>
    </section>
  )
}
