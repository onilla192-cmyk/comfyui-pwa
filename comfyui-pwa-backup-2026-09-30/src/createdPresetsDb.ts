export interface GalleryPreset {
  id: string
  title: string
  prompt: string
  createdAt: number
}

const DB_NAME = 'comfyui-pwa-gallery'
const PRESET_STORE = 'presets'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('imageData')) db.createObjectStore('imageData', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' })
      if (!db.objectStoreNames.contains(PRESET_STORE)) db.createObjectStore(PRESET_STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Could not open preset storage'))
  })
}

export async function readCreatedPresets(): Promise<GalleryPreset[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const request = db.transaction(PRESET_STORE, 'readonly').objectStore(PRESET_STORE).getAll()
    request.onsuccess = () => {
      db.close()
      const values = Array.isArray(request.result) ? request.result : []
      resolve(values.filter((v): v is GalleryPreset =>
        !!v && typeof v.id === 'string' && typeof v.title === 'string' && typeof v.prompt === 'string'
      ).sort((a, b) => a.createdAt - b.createdAt))
    }
    request.onerror = () => { db.close(); reject(request.error || new Error('Could not read Created Presets')) }
  })
}

export async function createCreatedPreset(title: string, prompt: string): Promise<GalleryPreset> {
  const cleanTitle = title.trim()
  const cleanPrompt = prompt.trim()
  if (!cleanTitle || !cleanPrompt) throw new Error('Preset title and prompt are required.')
  const existing = await readCreatedPresets()
  if (existing.some((p) => p.title.toLowerCase() === cleanTitle.toLowerCase())) {
    throw new Error('A preset with that title already exists.')
  }
  const preset: GalleryPreset = { id: 'preset-' + Date.now() + '-' + Math.random().toString(36).slice(2), title: cleanTitle, prompt: cleanPrompt, createdAt: Date.now() }
  await putCreatedPreset(preset)
  return preset
}

export async function updateCreatedPreset(id: string, title: string, prompt: string): Promise<GalleryPreset> {
  const cleanTitle = title.trim()
  const cleanPrompt = prompt.trim()
  if (!cleanTitle || !cleanPrompt) throw new Error('Preset title and prompt are required.')
  const existing = await readCreatedPresets()
  if (existing.some((p) => p.id !== id && p.title.toLowerCase() === cleanTitle.toLowerCase())) {
    throw new Error('A preset with that title already exists.')
  }
  const current = existing.find((p) => p.id === id)
  if (!current) throw new Error('Preset not found.')
  const updated = { ...current, title: cleanTitle, prompt: cleanPrompt }
  await putCreatedPreset(updated)
  return updated
}

async function putCreatedPreset(preset: GalleryPreset): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PRESET_STORE, 'readwrite')
    tx.objectStore(PRESET_STORE).put(preset)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not save preset')) }
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Could not save preset')) }
  })
}

export async function deleteCreatedPreset(id: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PRESET_STORE, 'readwrite')
    tx.objectStore(PRESET_STORE).delete(id)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not delete preset')) }
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Could not delete preset')) }
  })
}

export function exportCreatedPresets(presets: GalleryPreset[]): void {
  const payload = { format: 'comfyui-pwa-created-presets', version: 1, exportedAt: new Date().toISOString(), presets }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'comfyui-created-presets.json'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export async function importCreatedPresets(file: File): Promise<number> {
  let parsed: unknown
  try { parsed = JSON.parse(await file.text()) } catch { throw new Error('The selected file is not valid JSON.') }
  const source = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as { presets?: unknown }).presets) ? (parsed as { presets: unknown[] }).presets : null
  if (!source) throw new Error('This file does not contain a presets list.')
  const imported = source.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
    .filter(v => typeof v.title === 'string' && v.title.trim() && typeof v.prompt === 'string' && v.prompt.trim())
    .map((v, i) => ({ id: typeof v.id === 'string' && v.id.trim() ? v.id : 'preset-imported-' + Date.now() + '-' + i + '-' + Math.random().toString(36).slice(2), title: (v.title as string).trim(), prompt: (v.prompt as string).trim(), createdAt: typeof v.createdAt === 'number' ? v.createdAt : Date.now() }))
  if (!imported.length) throw new Error('No valid presets were found in the selected file.')
  const existing = await readCreatedPresets()
  const ids = new Set(existing.map(p => p.id))
  const titles = new Set(existing.map(p => p.title.toLowerCase()))
  const toAdd = imported.filter(p => !ids.has(p.id) && !titles.has(p.title.toLowerCase()))
  if (!toAdd.length) return 0
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PRESET_STORE, 'readwrite')
    const store = tx.objectStore(PRESET_STORE)
    toAdd.forEach(p => store.put(p))
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not import presets')) }
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Could not import presets')) }
  })
  return toAdd.length
}
