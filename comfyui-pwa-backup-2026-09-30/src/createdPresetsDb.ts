export interface CreatedPreset {
  id: string
  title: string
  prompt: string
  createdAt: number
  thumbnail?: PresetThumbnail
  folderId?: string
}

export interface CreatedPresetFolder {
  id: string
  name: string
  createdAt: number
}

export interface PresetThumbnail {
  dataUrl: string
  width: number
  height: number
  type: string
  size: number
}

function isPresetThumbnail(value: unknown): value is PresetThumbnail {
  if (!value || typeof value !== 'object') return false
  const thumbnail = value as Partial<PresetThumbnail>
  return typeof thumbnail.dataUrl === 'string' && thumbnail.dataUrl.startsWith('data:image/') &&
    typeof thumbnail.width === 'number' && thumbnail.width > 0 &&
    typeof thumbnail.height === 'number' && thumbnail.height > 0 &&
    typeof thumbnail.type === 'string' && thumbnail.type.startsWith('image/') &&
    typeof thumbnail.size === 'number' && thumbnail.size >= 0
}

const DB_NAME = 'comfyui-pwa-created-presets'
const DB_VERSION = 2
const PRESET_STORE = 'presets'
const FOLDER_STORE = 'folders'
const LEGACY_PRESETS_KEY = 'comfyui-pwa-created-presets'
const LEGACY_PRESETS_ARCHIVE_KEY = 'comfyui-pwa-created-presets-archive'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(PRESET_STORE)) db.createObjectStore(PRESET_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(FOLDER_STORE)) db.createObjectStore(FOLDER_STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Could not open preset storage'))
  })
}

async function importLegacyPresetRecords(): Promise<void> {
  if (typeof indexedDB.databases !== 'function') return
  let databases: Array<{ name?: string }> = []
  try { databases = await indexedDB.databases() } catch { return }
  const target = DB_NAME
  const candidates = databases.map((entry) => entry.name).filter((name): name is string => !!name && name !== target)
  if (!candidates.length) return
  const imported: CreatedPreset[] = []
  for (const databaseName of candidates) {
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      if (!db.objectStoreNames.contains(PRESET_STORE)) { db.close(); continue }
      const records = await new Promise<unknown[]>((resolve, reject) => {
        const request = db.transaction(PRESET_STORE, 'readonly').objectStore(PRESET_STORE).getAll()
        request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : [])
        request.onerror = () => reject(request.error)
      })
      db.close()
      records.forEach((value) => {
        if (!value || typeof value !== 'object') return
        const item = value as Record<string, unknown>
        if (typeof item.id !== 'string' || typeof item.title !== 'string' || typeof item.prompt !== 'string') return
        imported.push({
          id: item.id,
          title: item.title,
          prompt: item.prompt,
          createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
          ...(isPresetThumbnail(item.thumbnail) ? { thumbnail: item.thumbnail } : {}),
        })
      })
    } catch {}
  }
  if (!imported.length) return
  const current = await readCreatedPresetsInternal()
  const ids = new Set(current.map((p) => p.id))
  const titles = new Set(current.map((p) => p.title.toLowerCase()))
  const toAdd = imported.filter((p) => !ids.has(p.id) && !titles.has(p.title.toLowerCase()))
  if (!toAdd.length) return
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PRESET_STORE, 'readwrite')
    const store = tx.objectStore(PRESET_STORE)
    toAdd.forEach((p) => store.put(p))
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not migrate presets')) }
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Could not migrate presets')) }
  })
}

async function readCreatedPresetsInternal(): Promise<CreatedPreset[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const request = db.transaction(PRESET_STORE, 'readonly').objectStore(PRESET_STORE).getAll()
    request.onsuccess = () => {
      db.close()
      const values = Array.isArray(request.result) ? request.result : []
      const presets = values.filter((v): v is Record<string, unknown> =>
        !!v && typeof v === 'object' && typeof (v as Record<string, unknown>).id === 'string' &&
        typeof (v as Record<string, unknown>).title === 'string' && typeof (v as Record<string, unknown>).prompt === 'string'
      ).map((value): CreatedPreset => ({
        id: value.id as string,
        title: value.title as string,
        prompt: value.prompt as string,
        createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
        ...(isPresetThumbnail(value.thumbnail) ? { thumbnail: value.thumbnail } : {}),
        ...(typeof value.folderId === 'string' && value.folderId ? { folderId: value.folderId } : {}),
      }))
      resolve(presets.sort((a, b) => a.createdAt - b.createdAt))
    }
    request.onerror = () => { db.close(); reject(request.error || new Error('Could not read Created Presets')) }
  })
}

export async function readCreatedPresets(): Promise<CreatedPreset[]> {
  await importLegacyPresetRecords()
  return readCreatedPresetsInternal()
}

export async function readCreatedPresetFolders(): Promise<CreatedPresetFolder[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const request = db.transaction(FOLDER_STORE, 'readonly').objectStore(FOLDER_STORE).getAll()
    request.onsuccess = () => {
      db.close()
      const folders = (Array.isArray(request.result) ? request.result : [])
        .filter((value): value is { id: string; name: string; createdAt?: number } =>
          !!value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' &&
          typeof (value as { name?: unknown }).name === 'string'
        )
        .map((value) => ({ id: value.id, name: value.name, createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now() }))
      resolve(folders.sort((a, b) => a.createdAt - b.createdAt))
    }
    request.onerror = () => { db.close(); reject(request.error || new Error('Could not read preset folders')) }
  })
}

export async function createCreatedPresetFolder(name: string): Promise<CreatedPresetFolder> {
  const cleanName = name.trim()
  if (!cleanName) throw new Error('Enter a folder name.')
  const existing = await readCreatedPresetFolders()
  if (existing.some((folder) => folder.name.toLowerCase() === cleanName.toLowerCase())) {
    throw new Error('A folder with that name already exists.')
  }
  const folder: CreatedPresetFolder = {
    id: 'preset-folder-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    name: cleanName,
    createdAt: Date.now(),
  }
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(FOLDER_STORE, 'readwrite')
    tx.objectStore(FOLDER_STORE).add(folder)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not create folder')) }
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Could not create folder')) }
  })
  return folder
}

export async function deleteCreatedPresetFolder(id: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([PRESET_STORE, FOLDER_STORE], 'readwrite')
    const presets = tx.objectStore(PRESET_STORE)
    const request = presets.getAll()
    request.onsuccess = () => {
      const values = Array.isArray(request.result) ? request.result : []
      values.forEach((value) => {
        if (!value || typeof value !== 'object' || (value as { folderId?: unknown }).folderId !== id) return
        const preset = { ...(value as Record<string, unknown>) }
        delete preset.folderId
        presets.put(preset)
      })
      tx.objectStore(FOLDER_STORE).delete(id)
    }
    request.onerror = () => { try { tx.abort() } catch {} }
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not delete folder')) }
    tx.onabort = () => { db.close(); reject(tx.error || request.error || new Error('Could not delete folder')) }
  })
}

export async function moveCreatedPresetsToFolder(ids: string[], folderId: string | null): Promise<void> {
  const targetIds = new Set(ids)
  if (!targetIds.size) return
  await verifyPresetFolder(folderId)
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PRESET_STORE, 'readwrite')
    const store = tx.objectStore(PRESET_STORE)
    const request = store.getAll()
    request.onsuccess = () => {
      const values = Array.isArray(request.result) ? request.result : []
      values.forEach((value) => {
        if (!value || typeof value !== 'object' || !targetIds.has((value as { id?: string }).id || '')) return
        const preset = { ...(value as Record<string, unknown>) }
        if (folderId) preset.folderId = folderId
        else delete preset.folderId
        store.put(preset)
      })
    }
    request.onerror = () => { try { tx.abort() } catch {} }
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not move presets')) }
    tx.onabort = () => { db.close(); reject(tx.error || request.error || new Error('Could not move presets')) }
  })
}

async function verifyPresetFolder(folderId?: string | null): Promise<void> {
  if (!folderId) return
  const folders = await readCreatedPresetFolders()
  if (!folders.some((folder) => folder.id === folderId)) throw new Error('The selected folder no longer exists.')
}

export async function createCreatedPreset(title: string, prompt: string, thumbnail?: PresetThumbnail | null, folderId?: string | null): Promise<CreatedPreset> {
  const cleanTitle = title.trim()
  const cleanPrompt = prompt.trim()
  if (!cleanTitle || !cleanPrompt) throw new Error('Preset title and prompt are required.')
  await verifyPresetFolder(folderId)
  const existing = await readCreatedPresets()
  if (existing.some((p) => p.title.toLowerCase() === cleanTitle.toLowerCase())) {
    throw new Error('A preset with that title already exists.')
  }
  const preset: CreatedPreset = { id: 'preset-' + Date.now() + '-' + Math.random().toString(36).slice(2), title: cleanTitle, prompt: cleanPrompt, createdAt: Date.now(), ...(thumbnail ? { thumbnail } : {}), ...(folderId ? { folderId } : {}) }
  await putCreatedPreset(preset)
  return preset
}

export async function updateCreatedPreset(id: string, title: string, prompt: string, thumbnail?: PresetThumbnail | null, folderId?: string | null): Promise<CreatedPreset> {
  const cleanTitle = title.trim()
  const cleanPrompt = prompt.trim()
  if (!cleanTitle || !cleanPrompt) throw new Error('Preset title and prompt are required.')
  await verifyPresetFolder(folderId)
  const existing = await readCreatedPresets()
  if (existing.some((p) => p.id !== id && p.title.toLowerCase() === cleanTitle.toLowerCase())) {
    throw new Error('A preset with that title already exists.')
  }
  const current = existing.find((p) => p.id === id)
  if (!current) throw new Error('Preset not found.')
  const updated = { ...current, title: cleanTitle, prompt: cleanPrompt }
  if (folderId !== undefined) {
    if (folderId) updated.folderId = folderId
    else delete updated.folderId
  }
  if (thumbnail !== undefined) {
    if (thumbnail) updated.thumbnail = thumbnail
    else delete updated.thumbnail
  }
  await putCreatedPreset(updated)
  const saved = await readCreatedPresetsInternal()
  const verified = saved.find((preset) => preset.id === id)
  if (!verified || verified.title !== cleanTitle || verified.prompt !== cleanPrompt) {
    throw new Error('Preset changes could not be verified after saving.')
  }
  return verified
}

async function putCreatedPreset(preset: CreatedPreset): Promise<void> {
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
  // Delete from the current preset store first.
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PRESET_STORE, 'readwrite')
    tx.objectStore(PRESET_STORE).delete(id)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not delete preset')) }
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Could not delete preset')) }
  })

  // Also remove legacy localStorage copies. Otherwise readCreatedPresets()
  // can merge the deleted record back into the current list.
  for (const key of [LEGACY_PRESETS_KEY, LEGACY_PRESETS_ARCHIVE_KEY]) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '[]')
      if (!Array.isArray(value)) continue
      const filtered = value.filter((item) => !item || typeof item !== 'object' || (item as { id?: unknown }).id !== id)
      if (filtered.length !== value.length) {
        localStorage.setItem(key, JSON.stringify(filtered))
      }
    } catch {}
  }

  // If an older IndexedDB database still contains the preset, remove that
  // copy as well so the legacy importer cannot resurrect it.
  if (typeof indexedDB.databases === 'function') {
    try {
      const databases = await indexedDB.databases()
      for (const entry of databases) {
        const databaseName = entry.name
        if (!databaseName || databaseName === DB_NAME) continue
        try {
          const legacyDb = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(databaseName)
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error || request.error)
          })
          if (!legacyDb.objectStoreNames.contains(PRESET_STORE)) {
            legacyDb.close()
            continue
          }
          await new Promise<void>((resolve, reject) => {
            const tx = legacyDb.transaction(PRESET_STORE, 'readwrite')
            tx.objectStore(PRESET_STORE).delete(id)
            tx.oncomplete = () => { legacyDb.close(); resolve() }
            tx.onerror = () => { legacyDb.close(); reject(tx.error) }
            tx.onabort = () => { legacyDb.close(); reject(tx.error) }
          })
        } catch {}
      }
    } catch {}
  }

  // Read back the current store and verify the deleted id is truly gone.
  const remaining = await readCreatedPresetsInternal()
  if (remaining.some((preset) => preset.id === id)) {
    throw new Error('Preset could not be verified as deleted.')
  }
}

export function exportCreatedPresets(presets: CreatedPreset[]): void {
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
    .map((v, i) => ({ id: typeof v.id === 'string' && v.id.trim() ? v.id : 'preset-imported-' + Date.now() + '-' + i + '-' + Math.random().toString(36).slice(2), title: (v.title as string).trim(), prompt: (v.prompt as string).trim(), createdAt: typeof v.createdAt === 'number' ? v.createdAt : Date.now(), ...(isPresetThumbnail(v.thumbnail) ? { thumbnail: v.thumbnail } : {}) }))
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
