const DB_NAME = 'comfyui-console-images'
const STORE_NAME = 'images'
const DB_VERSION = 1

export interface BackupImage {
  key: string
  type: string
  data: string
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function putBlob(key: string, blob: Blob): Promise<void> {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(blob, key)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  }))
}

function getBlob(key: string): Promise<Blob | undefined> {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key)
    request.onsuccess = () => { db.close(); resolve(request.result as Blob | undefined) }
    request.onerror = () => { db.close(); reject(request.error) }
  }))
}

export async function cacheFile(key: string, file: Blob): Promise<string> {
  await putBlob(key, file)
  return URL.createObjectURL(file)
}

export async function getCachedFile(key: string): Promise<Blob | null> {
  try {
    return (await getBlob(key)) ?? null
  } catch {
    return null
  }
}

export async function cacheImage(key: string, sourceUrl: string): Promise<string> {
  const response = await fetch(sourceUrl, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Could not cache generated image (${response.status})`)
  const blob = await response.blob()
  await putBlob(key, blob)
  return URL.createObjectURL(blob)
}

export async function getCachedImage(key: string): Promise<string | null> {
  try {
    const blob = await getBlob(key)
    return blob ? URL.createObjectURL(blob) : null
  } catch {
    return null
  }
}

export async function deleteCachedImage(key: string): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch {}
}
const blobToDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onloadend = () => resolve(reader.result as string)
  reader.onerror = () => reject(reader.error)
  reader.readAsDataURL(blob)
})

const dataUrlToBlob = async (data: string): Promise<Blob> => {
  if (!data.startsWith('data:')) throw new Error('Backup contains an invalid image entry.')
  const response = await fetch(data)
  if (!response.ok) throw new Error('Backup contains an unreadable image entry.')
  return response.blob()
}

export async function exportCachedFiles(): Promise<BackupImage[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).openCursor()
    const entries: Array<{ key: string; value: Blob }> = []
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        void Promise.all(entries.map(async ({ key, value }) => ({
          key,
          type: value.type || 'application/octet-stream',
          data: await blobToDataUrl(value),
        }))).then((result) => { db.close(); resolve(result) }).catch((error) => { db.close(); reject(error) })
        return
      }
      entries.push({ key: String(cursor.key), value: cursor.value as Blob })
      cursor.continue()
    }
    request.onerror = () => { db.close(); reject(request.error) }
  })
}

export async function clearCachedFiles(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).clear()
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}

export async function importCachedFiles(entries: BackupImage[]): Promise<void> {
  for (const entry of entries) {
    if (!entry || typeof entry.key !== 'string' || typeof entry.data !== 'string') throw new Error('Backup contains an invalid cached image.')
    const blob = await dataUrlToBlob(entry.data)
    await putBlob(entry.key, blob)
  }
}

export async function deleteCachedFiles(keys: string[]): Promise<void> {
  if (!keys.length) return
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      for (const key of keys) store.delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch {}
}
