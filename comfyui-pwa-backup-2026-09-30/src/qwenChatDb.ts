export type QwenChatMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  imageUrl?: string
}

export type QwenChat = {
  id: string
  title: string
  stateUid: number
  messages: QwenChatMessage[]
  createdAt: number
  updatedAt: number
}

const DB_NAME = 'qwen-chat-db-v1'
const STORE_NAME = 'state'
const BACKGROUND_STORE_NAME = 'background'
const AVATAR_STORE_NAME = 'avatar'
const STATE_KEY = 'singleton'
const BACKGROUND_KEY = 'current'
const QWEN_AVATAR_KEY = 'qwen'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 3)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
      if (!db.objectStoreNames.contains(BACKGROUND_STORE_NAME)) {
        db.createObjectStore(BACKGROUND_STORE_NAME)
      }
      if (!db.objectStoreNames.contains(AVATAR_STORE_NAME)) {
        db.createObjectStore(AVATAR_STORE_NAME)
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Could not open Qwen chat storage.'))
  })
}

export async function loadQwenChats(): Promise<QwenChat[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly')
    const request = transaction.objectStore(STORE_NAME).get(STATE_KEY)

    request.onsuccess = () => {
      const value = request.result as { chats?: unknown } | undefined
      const chats = Array.isArray(value?.chats) ? value.chats : []
      resolve(chats as QwenChat[])
      db.close()
    }

    request.onerror = () => {
      reject(request.error || new Error('Could not read Qwen chats.'))
      db.close()
    }
  })
}

export async function saveQwenChats(chats: QwenChat[]): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put({ chats }, STATE_KEY)

    transaction.oncomplete = () => {
      db.close()
      resolve()
    }

    transaction.onerror = () => {
      const error = transaction.error || new Error('Could not save Qwen chats.')
      db.close()
      reject(error)
    }
  })
}

export async function loadQwenChatBackground(): Promise<Blob | null> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(BACKGROUND_STORE_NAME, 'readonly')
    const request = transaction.objectStore(BACKGROUND_STORE_NAME).get(BACKGROUND_KEY)

    request.onsuccess = () => {
      const value = request.result
      resolve(value instanceof Blob ? value : null)
      db.close()
    }

    request.onerror = () => {
      reject(request.error || new Error('Could not read the Qwen chat background.'))
      db.close()
    }
  })
}

export async function saveQwenChatBackground(background: Blob): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(BACKGROUND_STORE_NAME, 'readwrite')
    transaction.objectStore(BACKGROUND_STORE_NAME).put(background, BACKGROUND_KEY)

    transaction.oncomplete = () => {
      db.close()
      resolve()
    }

    transaction.onerror = () => {
      const error = transaction.error || new Error('Could not save the Qwen chat background.')
      db.close()
      reject(error)
    }
  })
}

export async function clearQwenChatBackground(): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(BACKGROUND_STORE_NAME, 'readwrite')
    transaction.objectStore(BACKGROUND_STORE_NAME).delete(BACKGROUND_KEY)

    transaction.oncomplete = () => {
      db.close()
      resolve()
    }

    transaction.onerror = () => {
      const error = transaction.error || new Error('Could not remove the Qwen chat background.')
      db.close()
      reject(error)
    }
  })
}


export async function loadQwenAvatar(): Promise<Blob | null> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(AVATAR_STORE_NAME, 'readonly')
    const request = transaction.objectStore(AVATAR_STORE_NAME).get(QWEN_AVATAR_KEY)

    request.onsuccess = () => {
      const value = request.result
      resolve(value instanceof Blob ? value : null)
      db.close()
    }

    request.onerror = () => {
      reject(request.error || new Error('Could not read the Qwen avatar.'))
      db.close()
    }
  })
}

export async function saveQwenAvatar(avatar: Blob): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(AVATAR_STORE_NAME, 'readwrite')
    transaction.objectStore(AVATAR_STORE_NAME).put(avatar, QWEN_AVATAR_KEY)

    transaction.oncomplete = () => {
      db.close()
      resolve()
    }

    transaction.onerror = () => {
      const error = transaction.error || new Error('Could not save the Qwen avatar.')
      db.close()
      reject(error)
    }
  })
}

export async function clearQwenAvatar(): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(AVATAR_STORE_NAME, 'readwrite')
    transaction.objectStore(AVATAR_STORE_NAME).delete(QWEN_AVATAR_KEY)

    transaction.oncomplete = () => {
      db.close()
      resolve()
    }

    transaction.onerror = () => {
      const error = transaction.error || new Error('Could not remove the Qwen avatar.')
      db.close()
      reject(error)
    }
  })
}
