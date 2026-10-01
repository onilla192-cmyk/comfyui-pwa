import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

interface GalleryItem {
  id: string
  name: string
  src: string
  thumbnailSrc?: string
  createdAt: number
  folderId: string | null
}

interface GalleryStoredItem {
  id: string
  name: string
  thumbnailSrc: string
  createdAt: number
  folderId: string | null
}

interface GalleryImageData {
  id: string
  src: string
}

interface GalleryFolder {
  id: string
  name: string
  createdAt: number
}

export interface GalleryPreset {
  id: string
  title: string
  prompt: string
  createdAt: number
}

type Figure = 'one' | 'two'

const GALLERY_STORAGE_KEY = 'comfyui-pwa-gallery-v1'
const GALLERY_DB_NAME = 'comfyui-pwa-gallery'
const GALLERY_DB_VERSION = 8
const GALLERY_STORE_NAME = 'images'
const GALLERY_IMAGE_DATA_STORE_NAME = 'imageData'
const GALLERY_FOLDER_STORE_NAME = 'folders'
const GALLERY_PRESET_STORE_NAME = 'presets'

function loadGallery(): GalleryItem[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(GALLERY_STORAGE_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.map((item) => ({ ...item, folderId: item.folderId ?? null })) : []
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
      if (!db.objectStoreNames.contains(GALLERY_IMAGE_DATA_STORE_NAME)) db.createObjectStore(GALLERY_IMAGE_DATA_STORE_NAME, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(GALLERY_FOLDER_STORE_NAME)) db.createObjectStore(GALLERY_FOLDER_STORE_NAME, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(GALLERY_PRESET_STORE_NAME)) db.createObjectStore(GALLERY_PRESET_STORE_NAME, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Could not open gallery storage'))
  })
}

async function readGalleryDb(): Promise<{ items: GalleryItem[]; folders: GalleryFolder[]; presets: GalleryPreset[] }> {
  const db = await openGalleryDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction([GALLERY_STORE_NAME, GALLERY_FOLDER_STORE_NAME, GALLERY_PRESET_STORE_NAME], 'readonly')
    const imageRequest = tx.objectStore(GALLERY_STORE_NAME).getAll()
    const folderRequest = tx.objectStore(GALLERY_FOLDER_STORE_NAME).getAll()
    const presetRequest = tx.objectStore(GALLERY_PRESET_STORE_NAME).getAll()
    tx.oncomplete = () => {
      db.close()
      const items = (imageRequest.result || []).map((item: GalleryStoredItem & { src?: string }) => ({
        ...item,
        src: typeof item.src === 'string' ? item.src : '',
        folderId: item.folderId ?? null,
      })).sort((a: GalleryItem, b: GalleryItem) => b.createdAt - a.createdAt)
      const folders = (folderRequest.result || []).sort((a: GalleryFolder, b: GalleryFolder) => a.createdAt - b.createdAt)
      const presets = (presetRequest.result || []).sort((a: GalleryPreset, b: GalleryPreset) => a.createdAt - b.createdAt)
      resolve({ items, folders, presets })
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error || new Error('Could not read gallery storage'))
    }
  })
}

async function getGalleryImageSrc(id: string): Promise<string> {
  const db = await openGalleryDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(GALLERY_IMAGE_DATA_STORE_NAME, 'readonly')
    const request = tx.objectStore(GALLERY_IMAGE_DATA_STORE_NAME).get(id)
    request.onsuccess = () => resolve(typeof request.result?.src === 'string' ? request.result.src : '')
    request.onerror = () => reject(request.error || new Error('Could not load image'))
    tx.oncomplete = () => db.close()
    tx.onerror = () => {
      db.close()
      reject(tx.error || new Error('Could not load image'))
    }
  })
}

async function putGalleryImageData(id: string, src: string): Promise<void> {
  const db = await openGalleryDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(GALLERY_IMAGE_DATA_STORE_NAME, 'readwrite')
    tx.objectStore(GALLERY_IMAGE_DATA_STORE_NAME).put({ id, src } satisfies GalleryImageData)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not save image')) }
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Could not save image')) }
  })
}

async function deleteGalleryImageData(id: string): Promise<void> {
  const db = await openGalleryDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(GALLERY_IMAGE_DATA_STORE_NAME, 'readwrite')
    tx.objectStore(GALLERY_IMAGE_DATA_STORE_NAME).delete(id)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not delete image')) }
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Could not delete image')) }
  })
}

async function deleteGalleryFolders(ids: string[]): Promise<void> {
  if (!ids.length) return
  const db = await openGalleryDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(GALLERY_FOLDER_STORE_NAME, 'readwrite')
    const store = tx.objectStore(GALLERY_FOLDER_STORE_NAME)
    ids.forEach((id) => store.delete(id))
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not delete folders')) }
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Could not delete folders')) }
  })
}

async function deleteGalleryImageDataMany(ids: string[]): Promise<void> {
  if (!ids.length) return
  const db = await openGalleryDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(GALLERY_IMAGE_DATA_STORE_NAME, 'readwrite')
    const store = tx.objectStore(GALLERY_IMAGE_DATA_STORE_NAME)
    ids.forEach((id) => store.delete(id))
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not delete images')) }
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Could not delete images')) }
  })
}

async function makeThumbnail(src: string, maxSize = 360): Promise<string> {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight))
      const width = Math.max(1, Math.round(image.naturalWidth * scale))
      const height = Math.max(1, Math.round(image.naturalHeight * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) {
        resolve(src)
        return
      }
      context.drawImage(image, 0, 0, width, height)
      resolve(canvas.toDataURL('image/jpeg', 0.78))
    }
    image.onerror = () => resolve(src)
    image.src = src
  })
}

export async function readGalleryPresets(): Promise<GalleryPreset[]> {
  // Use the same non-destructive recovery path as the Gallery itself so the
  // Main Page and Gallery Menu always see the same Created Presets.
  const stored = await readGalleryDb()
  return recoverPresetsFromIndexedDb(stored.presets)
}

async function writeGalleryDb(items: GalleryItem[], folders: GalleryFolder[], presets: GalleryPreset[]): Promise<void> {
  const db = await openGalleryDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction([GALLERY_STORE_NAME, GALLERY_FOLDER_STORE_NAME, GALLERY_PRESET_STORE_NAME], 'readwrite')
    const imageStore = tx.objectStore(GALLERY_STORE_NAME)
    const folderStore = tx.objectStore(GALLERY_FOLDER_STORE_NAME)
    const presetStore = tx.objectStore(GALLERY_PRESET_STORE_NAME)
    imageStore.clear()
    // Never clear folders during an automatic gallery save. Folder records are user data.
    // Never clear the preset store during an automatic gallery save. Presets are user data.
    // Keeping this store append/merge-only prevents an incomplete React state from deleting presets.
    items.forEach((item) => imageStore.put({
      id: item.id,
      name: item.name,
      thumbnailSrc: item.thumbnailSrc || item.src,
      createdAt: item.createdAt,
      folderId: item.folderId ?? null,
    } satisfies GalleryStoredItem))
    folders.forEach((folder) => folderStore.put(folder))
    // Presets are intentionally merge-only here. Explicit preset deletion is handled separately.
    presets.forEach((preset) => presetStore.put(preset))
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not save gallery')) }
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Could not save gallery')) }
  })
}


function looksLikeGalleryPreset(value: unknown): value is GalleryPreset {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.title === 'string' && typeof item.prompt === 'string'
}

function recoverPresetsFromLocalStorage(existing: GalleryPreset[]): GalleryPreset[] {
  const byId = new Map(existing.map((preset) => [preset.id, preset]))
  const addValue = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    const candidates = Array.isArray(value) ? value : [value]
    for (const candidate of candidates) {
      if (!looksLikeGalleryPreset(candidate)) continue
      const item = candidate as Partial<GalleryPreset>
      const id = typeof item.id === 'string' && item.id
        ? item.id
        : 'preset-recovered-local-' + Date.now() + '-' + Math.random().toString(36).slice(2)
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          title: item.title!,
          prompt: item.prompt!,
          createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
        })
      }
    }
  }
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (!key) continue
      const raw = localStorage.getItem(key)
      if (!raw) continue
      try { addValue(JSON.parse(raw)) } catch {}
    }
  } catch {}
  return Array.from(byId.values()).sort((a, b) => a.createdAt - b.createdAt)
}

async function recoverPresetsFromIndexedDb(existing: GalleryPreset[]): Promise<GalleryPreset[]> {
  const byId = new Map(existing.map((preset) => [preset.id, preset]))
  const databases: string[] = []

  try {
    if (typeof indexedDB.databases === 'function') {
      const entries = await indexedDB.databases()
      for (const entry of entries) {
        if (entry.name && !databases.includes(entry.name)) databases.push(entry.name)
      }
    }
  } catch {}

  if (!databases.includes(GALLERY_DB_NAME)) databases.push(GALLERY_DB_NAME)

  // Read-only recovery. Scan every same-origin store except the two stores
  // that can contain large image blobs. Some of the user's older preset data
  // may have been stored under a non-obvious store name.
  for (const databaseName of databases) {
    let db: IDBDatabase
    try {
      db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error || new Error('Could not open IndexedDB database'))
      })
    } catch {
      continue
    }

    try {
      const storeNames = Array.from(db.objectStoreNames).filter((name) =>
        name !== GALLERY_IMAGE_DATA_STORE_NAME &&
        name !== 'imageData' &&
        name !== 'thumbnails'
      )
      if (!storeNames.length) continue

      await new Promise<void>((resolve) => {
        let remaining = storeNames.length
        const finish = () => {
          remaining -= 1
          if (remaining <= 0) resolve()
        }

        let tx: IDBTransaction
        try {
          tx = db.transaction(storeNames, 'readonly')
        } catch {
          resolve()
          return
        }

        for (const storeName of storeNames) {
          const request = tx.objectStore(storeName).openCursor()

          request.onsuccess = () => {
            const cursor = request.result
            if (!cursor) {
              finish()
              return
            }

            const value = cursor.value
            if (looksLikeGalleryPreset(value)) {
              const item = value as Partial<GalleryPreset>
              const id = typeof item.id === 'string' && item.id
                ? item.id
                : 'preset-recovered-' + Date.now() + '-' + Math.random().toString(36).slice(2)

              if (!byId.has(id)) {
                byId.set(id, {
                  id,
                  title: item.title!,
                  prompt: item.prompt!,
                  createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
                })
              }
            }

            cursor.continue()
          }

          request.onerror = () => finish()
        }

        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
        tx.onabort = () => resolve()
      })
    } finally {
      db.close()
    }
  }

  return Array.from(byId.values()).sort((a, b) => a.createdAt - b.createdAt)
}

async function recoverFoldersFromIndexedDb(existing: GalleryFolder[]): Promise<GalleryFolder[]> {
  const byId = new Map(existing.map((folder) => [folder.id, folder]))
  const databases: string[] = []
  try {
    if (typeof indexedDB.databases === 'function') {
      const entries = await indexedDB.databases()
      for (const entry of entries) if (entry.name && !databases.includes(entry.name)) databases.push(entry.name)
    }
  } catch {}
  if (!databases.includes(GALLERY_DB_NAME)) databases.push(GALLERY_DB_NAME)

  for (const databaseName of databases) {
    let db: IDBDatabase
    try {
      db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error || new Error('Could not open IndexedDB database'))
      })
    } catch { continue }

    try {
      const storeNames = Array.from(db.objectStoreNames).filter((name) => /folder/i.test(name) || name === GALLERY_FOLDER_STORE_NAME)
      if (!storeNames.length) continue
      await new Promise<void>((resolve) => {
        const finish = () => resolve()
        let tx: IDBTransaction
        try { tx = db.transaction(storeNames, 'readonly') } catch { resolve(); return }
        for (const storeName of storeNames) {
          const request = tx.objectStore(storeName).openCursor()
          request.onsuccess = () => {
            const cursor = request.result
            if (!cursor) return
            const value = cursor.value
            if (value && typeof value === 'object') {
              const item = value as Record<string, unknown>
              if (typeof item.id === 'string' && typeof item.name === 'string' && typeof item.createdAt === 'number') {
                if (!byId.has(item.id)) {
                  byId.set(item.id, {
                    id: item.id,
                    name: item.name,
                    createdAt: item.createdAt,
                  })
                }
              }
            }
            cursor.continue()
          }
          request.onerror = () => {}
        }
        tx.oncomplete = finish
        tx.onerror = finish
        tx.onabort = finish
      })
    } finally { db.close() }
  }
  return Array.from(byId.values()).sort((a, b) => a.createdAt - b.createdAt)
}

async function recoverGalleryItemsFromIndexedDb(existing: GalleryItem[]): Promise<GalleryItem[]> {
  const byId = new Map(existing.map((item) => [item.id, item]))
  const databases: string[] = []
  try {
    if (typeof indexedDB.databases === 'function') {
      const entries = await indexedDB.databases()
      for (const entry of entries) if (entry.name && !databases.includes(entry.name)) databases.push(entry.name)
    }
  } catch {}
  if (!databases.includes(GALLERY_DB_NAME)) databases.push(GALLERY_DB_NAME)

  for (const databaseName of databases) {
    let db: IDBDatabase
    try {
      db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error || new Error('Could not open IndexedDB database'))
      })
    } catch { continue }

    try {
      const storeNames = Array.from(db.objectStoreNames)
      if (!storeNames.length) continue
      await new Promise<void>((resolve) => {
        let remaining = storeNames.length
        const finish = () => { remaining -= 1; if (remaining <= 0) resolve() }
        let tx: IDBTransaction
        try { tx = db.transaction(storeNames, 'readonly') } catch { resolve(); return }

        for (const storeName of storeNames) {
          const request = tx.objectStore(storeName).openCursor()
          request.onsuccess = () => {
            const cursor = request.result
            if (!cursor) { finish(); return }
            const value = cursor.value
            if (value && typeof value === 'object') {
              const item = value as Record<string, unknown>
              const id = typeof item.id === 'string' ? item.id : ''
              const src = typeof item.src === 'string' ? item.src : ''
              const thumbnailSrc = typeof item.thumbnailSrc === 'string' ? item.thumbnailSrc : ''
              const name = typeof item.name === 'string' ? item.name : ''
              const createdAt = typeof item.createdAt === 'number' ? item.createdAt : Date.now()
              const folderId = typeof item.folderId === 'string' ? item.folderId : null

              // Recover either original inline gallery records or optimized
              // imageData records. Read-only only: nothing is changed here.
              if (id && src && (src.startsWith('data:image/') || src.startsWith('blob:') || src.startsWith('http://') || src.startsWith('https://'))) {
                const existingItem = byId.get(id)
                if (!existingItem || !existingItem.src) {
                  byId.set(id, {
                    id,
                    name: name || existingItem?.name || 'Recovered Image',
                    src,
                    thumbnailSrc: thumbnailSrc || existingItem?.thumbnailSrc,
                    createdAt: existingItem?.createdAt || createdAt,
                    folderId: existingItem?.folderId ?? folderId,
                  })
                }
              } else if (id && thumbnailSrc) {
                const existingItem = byId.get(id)
                if (!existingItem) {
                  byId.set(id, {
                    id,
                    name: name || 'Recovered Image',
                    src: '',
                    thumbnailSrc,
                    createdAt,
                    folderId,
                  })
                }
              }
            }
            cursor.continue()
          }
          request.onerror = () => finish()
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
        tx.onabort = () => resolve()
      })
    } finally { db.close() }
  }

  return Array.from(byId.values()).sort((a, b) => b.createdAt - a.createdAt)
}

const RECOVERED_FOLDER_NAMES = ['Caucasian Girls', 'Asian Girls', 'Myself', 'My Hunter', 'iPhone Gallery']

function ensureKnownGalleryFolders(folders: GalleryFolder[]): GalleryFolder[] {
  if (folders.length) return folders
  const now = Date.now()
  return RECOVERED_FOLDER_NAMES.map((name, index) => ({
    id: 'folder-recovered-' + index + '-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name,
    createdAt: now + index,
  }))
}

async function migrateLegacyGallery(): Promise<{ items: GalleryItem[]; folders: GalleryFolder[]; presets: GalleryPreset[] }> {
  const stored = await readGalleryDb()

  // Preset recovery is additive and read-only. It never clears or replaces
  // existing preset records with an empty result.
  let recoveredPresets = stored.presets
  try {
    recoveredPresets = recoverPresetsFromLocalStorage(recoveredPresets)
    recoveredPresets = await recoverPresetsFromIndexedDb(recoveredPresets)
  } catch {}

  if (recoveredPresets.length > stored.presets.length) {
    try {
      const db = await openGalleryDb()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(GALLERY_PRESET_STORE_NAME, 'readwrite')
        const store = tx.objectStore(GALLERY_PRESET_STORE_NAME)
        recoveredPresets.forEach((preset) => store.put(preset))
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not restore recovered presets')) }
        tx.onabort = () => { db.close(); reject(tx.error || new Error('Could not restore recovered presets')) }
      })
    } catch {}
  }

  const recoveredFolders = ensureKnownGalleryFolders(await recoverFoldersFromIndexedDb(stored.folders))
  const recoveredItems = await recoverGalleryItemsFromIndexedDb(stored.items)
  // If an older same-origin database still contains original inline image data,
  // copy it into the current imageData store before the normal metadata save.
  // This only adds recovered image bytes; it never clears existing image data.
  for (const item of recoveredItems) {
    if (item.src) {
      try { await putGalleryImageData(item.id, item.src) } catch {}
    }
  }
  const legacyItems = recoveredItems
  const legacy = loadGallery()
  const hasImageData = await new Promise<boolean>((resolve) => {
    const dbPromise = openGalleryDb()
    return dbPromise.then((db) => new Promise<boolean>((resolveInner) => {
      const tx = db.transaction(GALLERY_IMAGE_DATA_STORE_NAME, 'readonly')
      const request = tx.objectStore(GALLERY_IMAGE_DATA_STORE_NAME).count()
      request.onsuccess = () => resolveInner(request.result > 0)
      request.onerror = () => resolveInner(false)
      tx.oncomplete = () => db.close()
    }))
  })
  if (!hasImageData) {
    const sourceItems = legacy.length ? legacy : legacyItems
    const inlineItems = sourceItems.filter((item) => Boolean(item.src))
    for (const item of inlineItems) {
      const thumbnailSrc = item.thumbnailSrc || await makeThumbnail(item.src)
      await putGalleryImageData(item.id, item.src)
      item.thumbnailSrc = thumbnailSrc
    }
    // Preserve the original metadata records. Never clear/rewrite the images
    // store as part of migration.
    if (inlineItems.length) {
      const db = await openGalleryDb()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(GALLERY_STORE_NAME, 'readwrite')
        const store = tx.objectStore(GALLERY_STORE_NAME)
        inlineItems.forEach((item) => store.put({
          id: item.id,
          name: item.name,
          thumbnailSrc: item.thumbnailSrc || '',
          createdAt: item.createdAt,
          folderId: item.folderId ?? null,
        } satisfies GalleryStoredItem))
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not migrate gallery metadata')) }
        tx.onabort = () => { db.close(); reject(tx.error || new Error('Could not migrate gallery metadata')) }
      })
    }
    return { items: sourceItems.map((item) => ({ ...item, src: '' })), folders: recoveredFolders, presets: recoveredPresets }
  }
  return { items: legacyItems, folders: recoveredFolders, presets: recoveredPresets }
}

export function ImageGalleryPage({
  onClose,
  onSetFigure,
}: {
  onClose: () => void
  onSetFigure: (which: Figure, item: GalleryItem, presetPrompt?: string) => void
}) {
  const [items, setItems] = useState<GalleryItem[]>([])
  // Render the known recovered folders immediately. This keeps the folder UI
  // visible even if IndexedDB recovery is still pending or fails.
  const [folders, setFolders] = useState<GalleryFolder[]>(() => ensureKnownGalleryFolders([]))
  const [presets, setPresets] = useState<GalleryPreset[]>([])
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [armedId, setArmedId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [multiSelectMode, setMultiSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(new Set())
  const [deleteFolderOpen, setDeleteFolderOpen] = useState(false)
  const [storageReady, setStorageReady] = useState(false)
  const [viewerSrc, setViewerSrc] = useState<string | null>(null)
  const [viewerLoading, setViewerLoading] = useState(false)
  const [sendFolderOpen, setSendFolderOpen] = useState(false)
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null)
  const [presetMenuOpen, setPresetMenuOpen] = useState(false)
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null)
  const [presetCreatorOpen, setPresetCreatorOpen] = useState(false)
  const [presetMenuExpanded, setPresetMenuExpanded] = useState(false)
  const [presetManagerMode, setPresetManagerMode] = useState<'edit' | 'delete' | null>(null)
  const [presetTitle, setPresetTitle] = useState('')
  const [presetPrompt, setPresetPrompt] = useState('')
  const [recoveredPresets, setRecoveredPresets] = useState<GalleryPreset[]>([])
  const [presetRecoveryScanning, setPresetRecoveryScanning] = useState(false)
  const [presetRecoveryMessage, setPresetRecoveryMessage] = useState<string | null>(null)
  const feedbackTimer = useRef<number | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const armTimer = useRef<number | null>(null)
  const pointerStart = useRef<{ id: string; x: number; y: number } | null>(null)
  const suppressTap = useRef(false)

  useEffect(() => {
    void refreshGalleryPresetList()
  }, [])

  useEffect(() => {
    let active = true
    void migrateLegacyGallery().then((stored) => {
      if (!active) return
      setItems(stored.items)
      setFolders(stored.folders)
      setPresets(stored.presets)
      setStorageReady(true)
    }).catch(async () => {
      if (!active) return

      // Fail closed: a gallery migration/read failure must NEVER turn into an
      // automatic save of empty state. Keep the user's existing IndexedDB
      // records untouched while still showing the recovered folder names.
      const fallbackFolders = ensureKnownGalleryFolders([])
      let fallbackPresets: GalleryPreset[] = []
      try {
        fallbackPresets = await recoverPresetsFromIndexedDb([])
      } catch {}

      if (!active) return
      setItems(loadGallery())
      setFolders(fallbackFolders)
      setPresets(fallbackPresets)

      // Do not enable the automatic writer after a failed migration. This
      // prevents writeGalleryDb() from clearing existing image metadata.
      setStorageReady(false)
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!storageReady) return
    void writeGalleryDb(items, folders, presets)
  }, [items, folders, presets, storageReady])

  useEffect(() => {
    if (!selectedId) {
      setViewerSrc(null)
      return
    }
    let active = true
    setViewerLoading(true)
    void getGalleryImageSrc(selectedId).then((src) => {
      if (active) setViewerSrc(src || null)
    }).catch(() => {
      if (active) setViewerSrc(null)
    }).finally(() => {
      if (active) setViewerLoading(false)
    })
    return () => { active = false }
  }, [selectedId])

  useEffect(() => () => {
    if (armTimer.current) window.clearTimeout(armTimer.current)
    if (feedbackTimer.current) window.clearTimeout(feedbackTimer.current)
  }, [])

  function showFeedback(message: string) {
    setFeedbackMessage(message)
    if (feedbackTimer.current) window.clearTimeout(feedbackTimer.current)
    feedbackTimer.current = window.setTimeout(() => setFeedbackMessage(null), 1400)
  }

  const currentFolder = folders.find((folder) => folder.id === currentFolderId) || null
  const visibleItems = items.filter((item) => (item.folderId ?? null) === currentFolderId)
  const visibleFolders = currentFolderId === null ? folders : []
  const selected = items.find((item) => item.id === selectedId) || null
  const selectedPreset = presets.find((preset) => preset.id === selectedPresetId) || null

  async function addImages(files: FileList | null) {
    if (!files?.length) return
    const selectedFiles = Array.from(files).filter((file) => file.type.startsWith('image/'))
    for (const file of selectedFiles) {
      const src = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
        reader.onerror = () => reject(reader.error || new Error('Could not read image'))
        reader.readAsDataURL(file)
      }).catch(() => '')
      if (!src) continue
      const id = 'gallery-' + Date.now() + '-' + Math.random().toString(36).slice(2)
      const thumbnailSrc = await makeThumbnail(src)
      await putGalleryImageData(id, src)
      setItems((current) => [{
        id,
        name: file.name,
        src: '',
        thumbnailSrc,
        createdAt: Date.now(),
        folderId: currentFolderId,
      }, ...current])
    }
  }

  function renameCurrentFolder() {
    if (!currentFolder) return
    const name = window.prompt('Rename folder', currentFolder.name)?.trim()
    if (!name || name === currentFolder.name) return
    setFolders((current) => current.map((folder) => folder.id === currentFolder.id ? { ...folder, name } : folder))
  }

  async function scanForLostPresets() {
    setPresetRecoveryScanning(true)
    setPresetRecoveryMessage(null)
    try {
      // Strictly read-only: scan same-origin storage and do not write anything.
      let found = recoverPresetsFromLocalStorage([])
      found = await recoverPresetsFromIndexedDb(found)
      setRecoveredPresets(found)
      setPresetRecoveryMessage(found.length
        ? 'Found ' + found.length + ' recoverable preset' + (found.length === 1 ? '' : 's') + '.'
        : 'No recoverable presets were found in this Cloudflare site storage.')
    } catch (error) {
      console.error('Preset recovery scan failed:', error)
      setRecoveredPresets([])
      setPresetRecoveryMessage('The recovery scan could not read this site storage.')
    } finally {
      setPresetRecoveryScanning(false)
    }
  }

  async function restoreRecoveredPresets() {
    if (!recoveredPresets.length) return
    try {
      const db = await openGalleryDb()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(GALLERY_PRESET_STORE_NAME, 'readwrite')
        const store = tx.objectStore(GALLERY_PRESET_STORE_NAME)
        recoveredPresets.forEach((preset) => store.put(preset))
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not restore presets')) }
        tx.onabort = () => { db.close(); reject(tx.error || new Error('Could not restore presets')) }
      })
      setPresets((current) => {
        const map = new Map(current.map((preset) => [preset.id, preset]))
        recoveredPresets.forEach((preset) => map.set(preset.id, preset))
        return Array.from(map.values()).sort((a, b) => a.createdAt - b.createdAt)
      })
      setPresetRecoveryMessage('Presets restored.')
      setRecoveredPresets([])
    } catch (error) {
      console.error('Preset restore failed:', error)
      setPresetRecoveryMessage('Could not restore the recovered presets.')
    }
  }

  async function refreshGalleryPresetList() {
    try {
      const recovered = await readGalleryPresets()
      setPresets(recovered)
    } catch {
      // Never replace existing preset state with an empty array.
    }
  }

  function createPreset() {
    const title = presetTitle.trim()
    const prompt = presetPrompt.trim()
    if (!title || !prompt) return
    if (presets.some((preset) => preset.title.toLowerCase() === title.toLowerCase())) {
      window.alert('A preset with that title already exists.')
      return
    }
    const preset: GalleryPreset = {
      id: 'preset-' + Date.now() + '-' + Math.random().toString(36).slice(2),
      title,
      prompt,
      createdAt: Date.now(),
    }
    setPresets((current) => [...current, preset])
    setSelectedPresetId(preset.id)
    setPresetTitle('')
    setPresetPrompt('')
    setPresetCreatorOpen(false)
    setPresetMenuOpen(false)
    showFeedback('Preset Saved')
  }

  function openPresetCreator() {
    setSelectedPresetId(null)
    setPresetTitle('')
    setPresetPrompt('')
    setPresetCreatorOpen(true)
    setPresetManagerMode(null)
    setPresetMenuExpanded(false)
    setSidebarOpen(false)
  }

  function openPresetManager(mode: 'edit' | 'delete') {
    setPresetManagerMode(mode)
    setPresetMenuExpanded(false)
    setPresetCreatorOpen(false)
    setSidebarOpen(false)
  }

  function editPreset(preset: GalleryPreset) {
    setPresetTitle(preset.title)
    setPresetPrompt(preset.prompt)
    setSelectedPresetId(preset.id)
    setPresetCreatorOpen(true)
    setPresetManagerMode(null)
  }

  function saveEditedPreset() {
    const title = presetTitle.trim()
    const prompt = presetPrompt.trim()
    if (!title || !prompt || !selectedPresetId) return
    if (presets.some((preset) => preset.id !== selectedPresetId && preset.title.toLowerCase() === title.toLowerCase())) {
      window.alert('A preset with that title already exists.')
      return
    }
    setPresets((current) => current.map((preset) => preset.id === selectedPresetId ? { ...preset, title, prompt } : preset))
    setPresetTitle('')
    setPresetPrompt('')
    setPresetCreatorOpen(false)
    setSelectedPresetId(selectedPresetId)
    showFeedback('Preset Updated')
  }

  function deletePreset(presetId: string) {
    setPresets((current) => current.filter((preset) => preset.id !== presetId))
    if (selectedPresetId === presetId) setSelectedPresetId(null)
    showFeedback('Preset Deleted')
  }

  function addFolder() {
    const name = window.prompt('Name this folder', 'New Folder')?.trim()
    if (!name) return
    const folder: GalleryFolder = {
      id: 'folder-' + Date.now() + '-' + Math.random().toString(36).slice(2),
      name,
      createdAt: Date.now(),
    }
    setFolders((current) => [...current, folder])
  }

  function handleCardPointerDown(itemId: string, event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.pointerType === 'mouse') return
    pointerStart.current = { id: itemId, x: event.clientX, y: event.clientY }
    suppressTap.current = false
  }

  function handleCardPointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const start = pointerStart.current
    if (!start || event.pointerType === 'mouse') return
    const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y)
    if (distance > 10) suppressTap.current = true
  }

  function handleCardPointerEnd() {
    pointerStart.current = null
  }

  function handleCardClick(item: GalleryItem) {
    if (suppressTap.current) {
      suppressTap.current = false
      return
    }
    tapItem(item)
  }

  function tapItem(item: GalleryItem) {
    if (navigator.vibrate) navigator.vibrate(18)
    if (multiSelectMode) {
      setSelectedFolderIds(new Set())
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

  function tapFolder(folder: GalleryFolder) {
    if (navigator.vibrate) navigator.vibrate(18)
    if (multiSelectMode) {
      setSelectedIds(new Set())
      setSelectedFolderIds((current) => {
        const next = new Set(current)
        if (next.has(folder.id)) next.delete(folder.id)
        else next.add(folder.id)
        return next
      })
      return
    }
    setCurrentFolderId(folder.id)
    setSelectedId(null)
    setArmedId(null)
  }

  function goToMainGallery() {
    setCurrentFolderId(null)
    setSelectedId(null)
    setArmedId(null)
    setSelectedIds(new Set())
    setSelectedFolderIds(new Set())
    setMultiSelectMode(false)
  }

  function toggleMultiSelect() {
    setMultiSelectMode((current) => !current)
    setSelectedIds(new Set())
    setSelectedFolderIds(new Set())
    setSelectedId(null)
    setArmedId(null)
    setSidebarOpen(false)
    setSendFolderOpen(false)
    setDeleteFolderOpen(false)
  }

  function deleteSelected() {
    if (selectedFolderIds.size) {
      setDeleteFolderOpen(true)
      return
    }
    if (!selectedIds.size) return
    const ids = [...selectedIds]
    void deleteGalleryImageDataMany(ids).catch(() => {})
    setItems((current) => current.filter((item) => !selectedIds.has(item.id)))
    setSelectedIds(new Set())
    setMultiSelectMode(false)
  }

  function resolveFolderDeletion(deleteImages: boolean) {
    if (!selectedFolderIds.size) return
    if (deleteImages) {
      const idsToDelete = items.filter((item) => item.folderId && selectedFolderIds.has(item.folderId)).map((item) => item.id)
      void deleteGalleryImageDataMany(idsToDelete).catch(() => {})
      setItems((current) => current.filter((item) => !item.folderId || !selectedFolderIds.has(item.folderId)))
    } else {
      setItems((current) => current.map((item) => selectedFolderIds.has(item.folderId || '') ? { ...item, folderId: null } : item))
    }
    void deleteGalleryFolders([...selectedFolderIds]).catch(() => {})
    setFolders((current) => current.filter((folder) => !selectedFolderIds.has(folder.id)))
    if (currentFolderId && selectedFolderIds.has(currentFolderId)) setCurrentFolderId(null)
    setSelectedFolderIds(new Set())
    setSelectedIds(new Set())
    setDeleteFolderOpen(false)
    setMultiSelectMode(false)
  }

  function sendSelectedToFolder(folderId: string | null) {
    if (!selectedIds.size) return
    setItems((current) => current.map((item) => selectedIds.has(item.id) ? { ...item, folderId } : item))
    setSelectedIds(new Set())
    setMultiSelectMode(false)
    setSendFolderOpen(false)
    setSidebarOpen(false)
  }

  function deleteItem(id: string) {
    void deleteGalleryImageData(id).catch(() => {})
    setItems((current) => current.filter((item) => item.id !== id))
    setSelectedId(null)
    setArmedId(null)
  }

  return (
    <div className="gallery-page">
      {feedbackMessage && <div className="gallery-feedback" role="status" aria-live="polite">{feedbackMessage}</div>}
      <header className="gallery-page-header">
        <button type="button" className="gallery-back-btn" onClick={currentFolderId ? goToMainGallery : onClose} aria-label={currentFolderId ? 'Back to main gallery' : 'Back to editor'}>←</button>
        <div>
          <h1>{currentFolder ? currentFolder.name : 'Image Gallery'}</h1>
          <span>{visibleItems.length} image{visibleItems.length === 1 ? '' : 's'}{multiSelectMode && (selectedIds.size + selectedFolderIds.size) ? ' • ' + (selectedIds.size + selectedFolderIds.size) + ' selected' : ''}</span>
        </div>
        <div className="gallery-header-actions">
          {currentFolder && <button type="button" className="gallery-edit-folder-btn" onClick={renameCurrentFolder} aria-label="Rename folder" title="Rename folder">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></svg>
          </button>}
          <button type="button" className="gallery-menu-btn" onClick={() => setSidebarOpen(true)} aria-label="Open gallery menu" aria-expanded={sidebarOpen}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          </button>
        </div>
      </header>

      <div className={'gallery-grid' + (multiSelectMode ? ' gallery-grid-multiselect' : '')}>
        {visibleFolders.map((folder) => (
          <button type="button" className={'gallery-folder-card' + (selectedFolderIds.has(folder.id) ? ' gallery-folder-card-selected' : '')} key={folder.id} onPointerDown={(event) => handleCardPointerDown(folder.id, event)} onPointerMove={handleCardPointerMove} onPointerUp={handleCardPointerEnd} onPointerCancel={() => { suppressTap.current = true; pointerStart.current = null }} onClick={() => { if (suppressTap.current) { suppressTap.current = false; return } tapFolder(folder) }} aria-pressed={multiSelectMode ? selectedFolderIds.has(folder.id) : undefined}>
            <span className="gallery-folder-icon">▰</span>
            <strong>{folder.name}</strong>
            <span>{items.filter((item) => item.folderId === folder.id).length} image{items.filter((item) => item.folderId === folder.id).length === 1 ? '' : 's'}</span>
          </button>
        ))}

        <button type="button" className="gallery-add-card" onClick={() => inputRef.current?.click()}>
          <span className="gallery-add-icon">+</span>
          <strong>Add Image</strong>
          <span>Upload an image</span>
          <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={(e) => { addImages(e.target.files); e.currentTarget.value = '' }} />
        </button>

        {visibleItems.map((item) => (
          <button type="button" className={'gallery-card' + (armedId === item.id ? ' gallery-card-armed' : '') + (selectedIds.has(item.id) ? ' gallery-card-selected' : '')} key={item.id} onPointerDown={(event) => handleCardPointerDown(item.id, event)} onPointerMove={handleCardPointerMove} onPointerUp={handleCardPointerEnd} onPointerCancel={() => { suppressTap.current = true; pointerStart.current = null }} onClick={() => handleCardClick(item)} aria-label={multiSelectMode ? ((selectedIds.has(item.id) ? 'Deselect ' : 'Select ') + item.name) : 'Open ' + item.name} aria-pressed={multiSelectMode ? selectedIds.has(item.id) : undefined}>
            <img src={item.thumbnailSrc || item.src} alt={item.name} loading="lazy" decoding="async" draggable={false} />
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
            <button
              type="button"
              className={'gallery-sidebar-action' + (presetMenuExpanded ? ' active' : '')}
              onClick={() => {
                const next = !presetMenuExpanded
                setPresetMenuExpanded(next)
                if (next) void refreshGalleryPresetList()
              }}
              aria-expanded={presetMenuExpanded}
            >
              <span className="gallery-sidebar-action-icon">✦</span>
              <span>Presets</span>
              <span className="gallery-preset-menu-chevron">{presetMenuExpanded ? '⌃' : '⌄'}</span>
            </button>
            {presetMenuExpanded && (
              <div className="gallery-sidebar-submenu">
                <button type="button" onClick={openPresetCreator}>Create Preset</button>
                <button type="button" onClick={() => openPresetManager('edit')} disabled={!presets.length}>Edit Preset</button>
                <button type="button" onClick={() => openPresetManager('delete')} disabled={!presets.length}>Delete Preset</button>
                <button type="button" onClick={scanForLostPresets} disabled={presetRecoveryScanning}>
                  {presetRecoveryScanning ? 'Scanning Presets…' : 'Find Lost Presets'}
                </button>
                {recoveredPresets.length > 0 && (
                  <button type="button" onClick={() => void restoreRecoveredPresets()}>
                    Restore {recoveredPresets.length} Found Preset{recoveredPresets.length === 1 ? '' : 's'}
                  </button>
                )}
                {presetRecoveryMessage && (
                  <div className="gallery-sidebar-preset-recovery-status" role="status">{presetRecoveryMessage}</div>
                )}
                <div className="gallery-sidebar-preset-list" aria-label="Created presets">
                  {presets.length ? presets.map((preset) => (
                    <button
                      type="button"
                      className="gallery-sidebar-preset-item"
                      key={preset.id}
                      onClick={() => {
                        setSelectedPresetId(preset.id)
                        setPresetTitle(preset.title)
                        setPresetPrompt(preset.prompt)
                        setPresetCreatorOpen(true)
                        setPresetMenuExpanded(false)
                        setSidebarOpen(false)
                      }}
                    >
                      <strong>{preset.title}</strong>
                      <span>{preset.prompt}</span>
                    </button>
                  )) : (
                    <div className="gallery-sidebar-preset-empty">No created presets.</div>
                  )}
                </div>
              </div>
            )}
            <button type="button" className="gallery-sidebar-action" onClick={addFolder}>
              <span className="gallery-sidebar-action-icon">+</span>
              <span>Add Folder</span>
            </button>
            <button type="button" className={'gallery-sidebar-action' + (multiSelectMode ? ' active' : '')} onClick={toggleMultiSelect}>
              <span className="gallery-sidebar-action-icon">✓</span>
              <span>{multiSelectMode ? 'Exit Multiselect' : 'Multiselect'}</span>
            </button>
            {multiSelectMode && (
              <div className="gallery-batch-actions">
                <span>{selectedIds.size + selectedFolderIds.size} selected</span>
                <button type="button" className="gallery-send-folder-btn" disabled={!selectedIds.size || selectedFolderIds.size > 0} onClick={() => setSendFolderOpen(true)}>Send to Folder</button>
                <button type="button" className="gallery-batch-delete" disabled={!selectedIds.size && !selectedFolderIds.size} onClick={deleteSelected}>Delete Selected</button>
                <button type="button" className="gallery-batch-cancel" onClick={toggleMultiSelect}>Cancel</button>
              </div>
            )}
          </aside>
        </div>
      )}

      {presetCreatorOpen && (
        <div className="gallery-preset-modal-backdrop" onClick={() => setPresetCreatorOpen(false)}>
          <section className="gallery-preset-modal" onClick={(e) => e.stopPropagation()}>
            <div className="gallery-preset-modal-header">
              <div>
                <h2>{selectedPresetId && presets.some((preset) => preset.id === selectedPresetId && preset.title === presetTitle) ? 'Edit Preset' : 'Create Preset'}</h2>
                <span>{selectedPresetId ? 'Update the selected preset title and prompt.' : 'Save a title and prompt for the gallery preset picker.'}</span>
              </div>
              <button type="button" onClick={() => { setPresetCreatorOpen(false); setSelectedPresetId(null) }} aria-label="Close preset editor">×</button>
            </div>
            <label className="gallery-preset-field">
              <span>Preset Title</span>
              <input value={presetTitle} onChange={(e) => setPresetTitle(e.target.value)} placeholder="Preset title" autoFocus />
            </label>
            <label className="gallery-preset-field">
              <span>Prompt</span>
              <textarea value={presetPrompt} onChange={(e) => setPresetPrompt(e.target.value)} placeholder="Enter the prompt for this preset..." rows={7} />
            </label>
            <div className="gallery-preset-modal-actions">
              <button type="button" onClick={() => { setPresetCreatorOpen(false); setSelectedPresetId(null) }}>Cancel</button>
              <button type="button" className="primary" disabled={!presetTitle.trim() || !presetPrompt.trim()} onClick={selectedPresetId ? saveEditedPreset : createPreset}>{selectedPresetId ? 'Save Changes' : 'Save Preset'}</button>
            </div>
          </section>
        </div>
      )}

      {presetManagerMode && (
        <div className="gallery-preset-modal-backdrop" onClick={() => setPresetManagerMode(null)}>
          <section className="gallery-preset-modal gallery-preset-manager" onClick={(e) => e.stopPropagation()}>
            <div className="gallery-preset-modal-header">
              <div>
                <h2>{presetManagerMode === 'edit' ? 'Edit Preset' : 'Delete Preset'}</h2>
                <span>{presetManagerMode === 'edit' ? 'Choose a preset to edit.' : 'Choose a preset to delete.'}</span>
              </div>
              <button type="button" onClick={() => setPresetManagerMode(null)} aria-label="Close preset manager">×</button>
            </div>
            <div className="gallery-preset-management-list">
              {presets.map((preset) => (
                <button
                  type="button"
                  key={preset.id}
                  className={presetManagerMode === 'edit' ? 'gallery-preset-management-option' : 'gallery-preset-management-option delete'}
                  onClick={() => presetManagerMode === 'edit' ? editPreset(preset) : deletePreset(preset.id)}
                >
                  <span>{preset.title}</span>
                  <span>{presetManagerMode === 'edit' ? 'Edit' : 'Delete'}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      {deleteFolderOpen && multiSelectMode && (
        <div className="gallery-folder-picker-backdrop" onClick={() => setDeleteFolderOpen(false)}>
          <section className="gallery-folder-picker" onClick={(e) => e.stopPropagation()}>
            <div className="gallery-folder-picker-header">
              <h2>Delete Folder{selectedFolderIds.size > 1 ? 's' : ''}</h2>
              <button type="button" onClick={() => setDeleteFolderOpen(false)} aria-label="Close folder deletion dialog">×</button>
            </div>
            <p>What should happen to the images inside the selected folder{selectedFolderIds.size > 1 ? 's' : ''}?</p>
            <button type="button" className="gallery-folder-choice" onClick={() => resolveFolderDeletion(false)}>
              <span>↗</span><strong>Move Images to Main Gallery</strong>
            </button>
            <button type="button" className="gallery-folder-choice gallery-folder-delete-choice" onClick={() => resolveFolderDeletion(true)}>
              <span>⌫</span><strong>Delete Images with Folder</strong>
            </button>
          </section>
        </div>
      )}

      {sendFolderOpen && multiSelectMode && (
        <div className="gallery-folder-picker-backdrop" onClick={() => setSendFolderOpen(false)}>
          <section className="gallery-folder-picker" onClick={(e) => e.stopPropagation()}>
            <div className="gallery-folder-picker-header">
              <h2>Send to Folder</h2>
              <button type="button" onClick={() => setSendFolderOpen(false)} aria-label="Close folder picker">×</button>
            </div>
            <p>Choose where to move {selectedIds.size} selected image{selectedIds.size === 1 ? '' : 's'}.</p>
            <button type="button" className="gallery-folder-choice" onClick={() => sendSelectedToFolder(null)}>
              <span>▰</span><strong>Main Image Gallery</strong>
            </button>
            {folders.map((folder) => (
              <button type="button" className="gallery-folder-choice" key={folder.id} onClick={() => sendSelectedToFolder(folder.id)}>
                <span>▰</span><strong>{folder.name}</strong>
              </button>
            ))}
          </section>
        </div>
      )}

      {selected && (
        <div className="gallery-viewer-backdrop" onClick={() => setSelectedId(null)}>
          <section className="gallery-viewer" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="gallery-viewer-close" onClick={() => setSelectedId(null)} aria-label="Close image">×</button>
            <div className="gallery-viewer-image-wrap">{viewerLoading ? <div className="gallery-viewer-loading">Loading image…</div> : viewerSrc ? <img src={viewerSrc} alt={selected.name} /> : <div className="gallery-viewer-loading">Image unavailable</div>}</div>
            <div className="gallery-viewer-actions">
              <button type="button" disabled={viewerLoading || !viewerSrc} onClick={() => { onSetFigure('one', { ...selected, src: viewerSrc || '' }, selectedPreset?.prompt); showFeedback(selectedPreset ? 'Preset Sent' : 'Sent!') }}>Figure A</button>
              <button type="button" disabled={viewerLoading || !viewerSrc} onClick={() => { onSetFigure('two', { ...selected, src: viewerSrc || '' }, selectedPreset?.prompt); showFeedback(selectedPreset ? 'Preset Sent' : 'Sent!') }}>Figure B</button>
              <button type="button" className="gallery-viewer-delete" onClick={() => deleteItem(selected.id)}>Delete</button>
            </div>
            <div className="gallery-preset-picker">
              <button
                type="button"
                className={'gallery-choose-preset' + (selectedPreset ? ' gallery-preset-selected' : '')}
                onClick={() => setPresetMenuOpen((open) => !open)}
                aria-expanded={presetMenuOpen}
              >
                {selectedPreset ? 'Preset Selected' : 'Choose a Preset'}
              </button>
              {presetMenuOpen && (
                <div className="gallery-preset-dropdown" role="listbox" aria-label="Preset options">
                  {presets.length ? presets.map((preset) => (
                    <button
                      type="button"
                      className={'gallery-preset-option' + (selectedPresetId === preset.id ? ' active' : '')}
                      key={preset.id}
                      onClick={() => { setSelectedPresetId(preset.id); setPresetMenuOpen(false) }}
                    >
                      {preset.title}
                    </button>
                  )) : (
                    <div className="gallery-preset-empty">No presets yet. Create one from Gallery Menu.</div>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
