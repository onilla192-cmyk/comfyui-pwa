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

const DB_NAME = 'comfyui-pwa-prompt-vault'
const DB_VERSION = 1
const ITEMS_STORE = 'items'
const ARCHIVED_STORE = 'archived'
const IMAGES_STORE = 'images'
const KEY = 'comfyui-console-prompt-vault-v1'
const ARCHIVE_KEY = 'comfyui-console-prompt-vault-archive-v1'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(ITEMS_STORE)) db.createObjectStore(ITEMS_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(ARCHIVED_STORE)) db.createObjectStore(ARCHIVED_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(IMAGES_STORE)) db.createObjectStore(IMAGES_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Could not open Prompt Vault storage.'))
  })
}

function readLegacyList(key: string): PromptVaultItem[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function putRecord(storeName: string, value: unknown, key?: IDBValidKey): Promise<void> {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    if (key === undefined) tx.objectStore(storeName).put(value)
    else tx.objectStore(storeName).put(value, key)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not save Prompt Vault data.')) }
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Prompt Vault save was aborted.')) }
  }))
}

function getRecord<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(key)
    request.onsuccess = () => { db.close(); resolve(request.result as T | undefined) }
    request.onerror = () => { db.close(); reject(request.error || new Error('Could not read Prompt Vault data.')) }
  }))
}

async function putImage(key: string, blob: Blob): Promise<void> {
  await putRecord(IMAGES_STORE, blob, key)
  const saved = await getRecord<Blob>(IMAGES_STORE, key)
  if (!saved) throw new Error('Prompt Vault image verification failed.')
}

async function deleteImage(key: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IMAGES_STORE, 'readwrite')
    tx.objectStore(IMAGES_STORE).delete(key)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}

async function migrateLegacyStorage(): Promise<void> {
  const legacyItems = readLegacyList(KEY)
  const legacyArchived = readLegacyList(ARCHIVE_KEY)
  if (!legacyItems.length && !legacyArchived.length) return

  const all = [...legacyItems, ...legacyArchived]
  const copiedKeys = new Set<string>()
  let complete = true

  for (const item of all) {
    for (const ref of item.imageRefs || []) {
      if (copiedKeys.has(ref.cacheKey)) continue
      try {
        const { getCachedFile } = await import('./imageCache')
        const blob = await getCachedFile(ref.cacheKey)
        if (!blob) {
          complete = false
          continue
        }
        await putImage(ref.cacheKey, blob)
        copiedKeys.add(ref.cacheKey)
      } catch {
        complete = false
      }
    }
  }

  if (!complete) return

  for (const item of legacyItems) await putRecord(ITEMS_STORE, item)
  for (const item of legacyArchived) await putRecord(ARCHIVED_STORE, item)

  // Remove legacy localStorage only after every item/image has been copied
  // and each copied image has been read back successfully.
  localStorage.removeItem(KEY)
  localStorage.removeItem(ARCHIVE_KEY)

  // Remove only the Prompt Vault's old image records. These keys use the
  // dedicated prompt-vault- prefix and were previously stored in the shared
  // console image cache.
  if (copiedKeys.size) {
    const { deleteCachedFiles } = await import('./imageCache')
    await deleteCachedFiles([...copiedKeys])
  }
}

export async function readPromptVault(): Promise<{ items: PromptVaultItem[]; archived: PromptVaultItem[] }> {
  await migrateLegacyStorage()
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction([ITEMS_STORE, ARCHIVED_STORE], 'readonly')
    const itemsRequest = tx.objectStore(ITEMS_STORE).getAll()
    const archivedRequest = tx.objectStore(ARCHIVED_STORE).getAll()
    let items: PromptVaultItem[] = []
    let archived: PromptVaultItem[] = []
    itemsRequest.onsuccess = () => { items = itemsRequest.result as PromptVaultItem[] }
    archivedRequest.onsuccess = () => { archived = archivedRequest.result as PromptVaultItem[] }
    tx.oncomplete = () => {
      db.close()
      // If a legacy migration was incomplete, keep the legacy records as a
      // read-only fallback until every legacy image can be copied safely.
      const legacyItems = readLegacyList(KEY)
      const legacyArchived = readLegacyList(ARCHIVE_KEY)
      const merge = (stored: PromptVaultItem[], legacy: PromptVaultItem[]) => {
        const seen = new Set(stored.map((item) => item.id))
        return [...stored, ...legacy.filter((item) => !seen.has(item.id))]
      }
      resolve({ items: merge(items, legacyItems), archived: merge(archived, legacyArchived) })
    }
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not read Prompt Vault.')) }
  })
}

export async function savePromptVaultItems(items: PromptVaultItem[], archived: PromptVaultItem[]): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([ITEMS_STORE, ARCHIVED_STORE], 'readwrite')
    const itemStore = tx.objectStore(ITEMS_STORE)
    const archivedStore = tx.objectStore(ARCHIVED_STORE)
    const desiredItems = new Set(items.map((item) => item.id))
    const desiredArchived = new Set(archived.map((item) => item.id))
    const itemCursor = itemStore.openCursor()
    itemCursor.onsuccess = () => {
      const cursor = itemCursor.result
      if (!cursor) return
      if (!desiredItems.has(String(cursor.key))) cursor.delete()
      cursor.continue()
    }
    const archivedCursor = archivedStore.openCursor()
    archivedCursor.onsuccess = () => {
      const cursor = archivedCursor.result
      if (!cursor) return
      if (!desiredArchived.has(String(cursor.key))) cursor.delete()
      cursor.continue()
    }
    for (const item of items) itemStore.put(item)
    for (const item of archived) archivedStore.put(item)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not save Prompt Vault.')) }
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Prompt Vault save was aborted.')) }
  })
}

export async function getPromptVaultImage(cacheKey: string): Promise<Blob | null> {
  try { return (await getRecord<Blob>(IMAGES_STORE, cacheKey)) ?? null } catch { return null }
}

export async function importPromptVaultItems(items: PromptVaultItem[]): Promise<void> {
  await migrateLegacyStorage()
  const copied = new Set<string>()
  for (const item of items) {
    for (const ref of item.imageRefs || []) {
      if (copied.has(ref.cacheKey)) continue
      const { getCachedFile } = await import('./imageCache')
      const blob = await getCachedFile(ref.cacheKey)
      if (!blob) throw new Error(`Prompt Vault image is missing: ${ref.cacheKey}`)
      await putImage(ref.cacheKey, blob)
      copied.add(ref.cacheKey)
    }
  }

  const existing = await readPromptVault()
  const existingIds = new Set([...existing.items, ...existing.archived].map((item) => item.id))
  const newItems = items.filter((item) => !existingIds.has(item.id))
  if (newItems.length) await savePromptVaultItems([...existing.items, ...newItems], existing.archived)

  if (copied.size) {
    const { deleteCachedFiles } = await import('./imageCache')
    await deleteCachedFiles([...copied])
  }
}

export async function deletePromptVaultImages(cacheKeys: string[]): Promise<void> {
  for (const key of cacheKeys) await deleteImage(key)
}

export { DB_NAME as PROMPT_VAULT_DB_NAME, ITEMS_STORE as PROMPT_VAULT_ITEMS_STORE, ARCHIVED_STORE as PROMPT_VAULT_ARCHIVED_STORE, IMAGES_STORE as PROMPT_VAULT_IMAGES_STORE }
