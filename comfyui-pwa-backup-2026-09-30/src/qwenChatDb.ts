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
const STATE_KEY = 'singleton'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
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
