import { clearCachedFiles, exportCachedFiles, importCachedFiles, type BackupImage } from './imageCache'

const BACKUP_FORMAT = 'comfyui-pwa-full-backup'
const BACKUP_VERSION = 1

export interface FullPwaBackup {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_VERSION
  exportedAt: string
  localStorage: Record<string, string>
  images: BackupImage[]
}

export async function createFullPwaBackup(): Promise<FullPwaBackup> {
  const localStorageData: Record<string, string> = {}
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key) localStorageData[key!] = localStorage.getItem(key) ?? ''
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    localStorage: localStorageData,
    images: await exportCachedFiles(),
  }
}

export function validateFullPwaBackup(value: unknown): FullPwaBackup {
  if (!value || typeof value !== 'object') throw new Error('The selected file is not a valid JSON backup.')
  const backup = value as Partial<FullPwaBackup>
  if (backup.format !== BACKUP_FORMAT) throw new Error('This JSON is not a ComfyUI PWA full backup.')
  if (backup.version !== BACKUP_VERSION) throw new Error('This backup was created by an incompatible backup version.')
  if (!backup.localStorage || typeof backup.localStorage !== 'object' || Array.isArray(backup.localStorage)) {
    throw new Error('The backup is missing its application data.')
  }
  if (!Array.isArray(backup.images)) throw new Error('The backup is missing its image data.')
  for (const image of backup.images) {
    if (!image || typeof image.key !== 'string' || typeof image.type !== 'string' || typeof image.data !== 'string' || !image.data.startsWith('data:')) {
      throw new Error('The backup contains an invalid cached image.')
    }
  }
  return backup as FullPwaBackup
}

export async function restoreFullPwaBackup(backup: FullPwaBackup): Promise<void> {
  // Validate and decode every image before changing the current app state.
  // This prevents a malformed backup from wiping the user's existing data.
  const decodedImages: BackupImage[] = []
  for (const image of backup.images) {
    const response = await fetch(image.data)
    if (!response.ok) throw new Error('Could not decode one of the backed-up images.')
    const blob = await response.blob()
    const reader = new FileReader()
    const data = await new Promise<string>((resolve, reject) => {
      reader.onloadend = () => resolve(reader.result as string)
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
    decodedImages.push({ ...image, data })
  }

  // Only after validation succeeds do we replace the current state.
  localStorage.clear()
  for (const [key, value] of Object.entries(backup.localStorage)) {
    localStorage.setItem(key, value)
  }

  await clearCachedFiles()
  await importCachedFiles(decodedImages)
}
