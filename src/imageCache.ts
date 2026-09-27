const DB_NAME = 'comfyui-console-images'
const STORE_NAME = 'images'
const DB_VERSION = 1

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
