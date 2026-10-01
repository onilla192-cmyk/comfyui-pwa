import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { connectProgress, getHistory, queuePrompt, uploadImage, viewImageUrl, interruptGeneration, getLauncherLogs, getNodeObjectInfo, getRemoteControlStatus, startComfyFromPhone } from './comfyClient'
import { buildWorkflow } from './workflowTemplate'
import { cacheImage, getCachedImage, deleteCachedImage, cacheFile, getCachedFile, requestPersistentStorage, ensureImageCacheDb, syncHistoryMetadata } from './imageCache'
import './App.css'
import { DatasetPage } from './components/DatasetPage'
import { PromptVaultPage, type PromptVaultItem } from './components/PromptVaultPage'
import { importPromptVaultItems } from './promptVaultDb'
import { ImageGalleryPage, readGalleryPresets, importGalleryPresets, type GalleryPreset } from './components/ImageGalleryPage'

type Status = 'idle' | 'queued' | 'running' | 'done' | 'error' | 'cancelling'
interface ResultImage { id: string; url: string; promptId: string; prompt?: string; negativePrompt?: string; cfg?: number; steps?: number; megapixels?: number; width?: number; height?: number; createdAt?: number }
const HISTORY_PAGE_SIZE = 6
const APP_VERSION = 31
interface CharacterImage { previewUrl: string; comfyName?: string; fileName: string; cacheKey: string }
interface PromptLabel { id: string; name: string; text: string; createdAt: number }
interface MasterPrompt { id: string; name: string; text: string; enabled: boolean }
interface HookPrompt { id: string; name: string; text: string; enabled: boolean }
interface ErrorLogEntry { id: string; timestamp: number; message: string }

const ASPECT_RATIOS = ['1:1 (Square)', '4:3', '3:2', '16:9', '2:3', '3:4', '9:16', '21:9', '9:21']
const SCHEDULERS = ['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform', 'beta']
const DEFAULT_UNET_NAME = 'qwen_image_2.1_bf16.safetensors'
const DEFAULT_CLIP_NAME = 'qwen3vl_8b_bf16.safetensors'
const DEFAULT_VAE_NAME = 'qwen_image_2.1_vae_bf16.safetensors'
const DEFAULT_UPSCALE_METHOD = 'lanczos'
const FALLBACK_UPSCALE_METHODS = ['nearest-exact', 'bilinear', 'area', 'bicubic', 'lanczos']
const PROMPT_BUILDER_LABELS = [
  'BODY EFFECTS', 'CLOTHING', 'NIPPLES', 'BREASTS', 'HEAD ANGLE', 'LIPS', 'HAIR DETAILS', 'HANDS',
  'EYES', 'CAMERA', 'PRESERVATION', 'MOUTH', 'POSTURE', 'BODY DIRECTION', 'IMAGE EDIT', 'WATERMARKS',
]

function imagePath(name: string, subfolder = '') { return subfolder ? `${subfolder}/${name}` : name }

const IMAGE_PROMPTS = {
  one: '<image_1> is identified as Figure A, subject from the source image',
  two: '<image_2> is identified as Figure B, subject from the source image',
}

const DEFAULT_MASTER_PROMPTS: MasterPrompt[] = [
  { id: 'master-figure-a', name: 'Figure A', text: IMAGE_PROMPTS.one, enabled: true },
  { id: 'master-preservation', name: 'Preservation', text: 'Preserve the subject’s identity, facial features, body proportions, and defining visual characteristics.', enabled: true },
]

function addImagePrompt(current: string, line: string) {
  const imageLines = Object.values(IMAGE_PROMPTS).filter((imageLine) => imageLine === line || current.includes(imageLine))
  const uniqueImageLines = [...new Set(imageLines)]
  const remaining = current
    .split('\n')
    .filter((part) => !Object.values(IMAGE_PROMPTS).includes(part.trim()))
    .join('\n')
    .trim()
  const top = uniqueImageLines.join('\n')
  return remaining ? `${top}\n\n${remaining}` : top
}

function removeImagePrompt(current: string, line: string) {
  return current
    .split('\n')
    .filter((part) => part.trim() !== line)
    .join('\n')
    .trim()
}

const STORAGE_KEY = 'comfyui-console-state-v4'

function withHistoryIds(items: ResultImage[]): ResultImage[] {
  return items.map((item, index) => ({ ...item, id: item.id || `${item.promptId || 'history'}-${item.createdAt || Date.now()}-${index}-${Math.random().toString(36).slice(2)}` }))
}

function withLabelIds(items: PromptLabel[]): PromptLabel[] {
  return items.map((item, index) => ({ ...item, id: item.id || `label-${item.createdAt || Date.now()}-${index}-${Math.random().toString(36).slice(2)}`, createdAt: item.createdAt || Date.now() }))
}

function loadSavedState(): any {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') } catch { return {} }
}

export default function App() {
  const saved = loadSavedState()
  const savedResults = withHistoryIds(Array.isArray(saved.results) ? saved.results : [])
  const savedTrash = withHistoryIds(Array.isArray(saved.trash) ? saved.trash : [])
  const savedPromptLabels = withLabelIds(Array.isArray(saved.promptLabels) ? saved.promptLabels : [])
  const savedErrorLogs: ErrorLogEntry[] = Array.isArray(saved.errorLogs) ? saved.errorLogs.filter((item: unknown): item is ErrorLogEntry => !!item && typeof item === 'object' && typeof (item as ErrorLogEntry).message === 'string').slice(-100) : []
  const savedPromptLabelTrash = withLabelIds(Array.isArray(saved.promptLabelTrash) ? saved.promptLabelTrash : [])
  const savedHookPrompts: HookPrompt[] = Array.isArray(saved.hookPrompts)
    ? saved.hookPrompts.filter((item: unknown): item is HookPrompt => !!item && typeof item === 'object' && typeof (item as HookPrompt).id === 'string' && typeof (item as HookPrompt).name === 'string' && typeof (item as HookPrompt).text === 'string').map((item: HookPrompt) => ({ ...item, enabled: item.enabled !== false }))
    : []
  const savedMasterPrompts: MasterPrompt[] = Array.isArray(saved.masterPrompts)
    ? saved.masterPrompts
        .filter((item: unknown): item is MasterPrompt => !!item && typeof item === 'object' && typeof (item as MasterPrompt).id === 'string' && typeof (item as MasterPrompt).name === 'string' && typeof (item as MasterPrompt).text === 'string')
        .map((item: MasterPrompt) => ({ ...item, enabled: item.enabled !== false }))
    : DEFAULT_MASTER_PROMPTS
  const [prompt, setPrompt] = useState(() => {
    const nav = performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined
    const isReload = nav?.type === 'reload' || (nav?.type == null && performance.navigation?.type === 1)
    return isReload ? (saved.prompt ?? '') : ''
  })
  useEffect(() => {
    const handleHistoryStorageUpdated = () => {
      try {
        const current = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
        setResults(withHistoryIds(Array.isArray(current.results) ? current.results : []))
        setTrash(withHistoryIds(Array.isArray(current.trash) ? current.trash : []))
        setHistoryPage(1)
      } catch {}
    }
    window.addEventListener('history-storage-updated', handleHistoryStorageUpdated)
    return () => window.removeEventListener('history-storage-updated', handleHistoryStorageUpdated)
  }, [])

  useEffect(() => {
    const handleHistorySendToMainPrompt = (event: Event) => {
      const customEvent = event as CustomEvent<string>
      if (typeof customEvent.detail === 'string') setPrompt(customEvent.detail)
    }
    window.addEventListener('history-send-to-main-prompt', handleHistorySendToMainPrompt)
    return () => window.removeEventListener('history-send-to-main-prompt', handleHistorySendToMainPrompt)
  }, [])

  const [promptLabelBlock, setPromptLabelBlock] = useState('')
  const [promptBuilderOpen, setPromptBuilderOpen] = useState(() => saved.promptBuilderOpen ?? false)
  const [promptBuilderValues, setPromptBuilderValues] = useState<Record<string, string>>(() => saved.promptBuilderValues && typeof saved.promptBuilderValues === 'object' ? saved.promptBuilderValues : {})
  const [activePromptBuilderLabel, setActivePromptBuilderLabel] = useState<string | null>(null)
  const [disabledPromptBuilderLabels, setDisabledPromptBuilderLabels] = useState<string[]>(() => Array.isArray(saved.disabledPromptBuilderLabels) ? saved.disabledPromptBuilderLabels : [])
  const [promptBuilderPageOpen, setPromptBuilderPageOpen] = useState(false)
  const [promptExpanded, setPromptExpanded] = useState(false)
  const [hookPreviewExpanded, setHookPreviewExpanded] = useState(false)
  const [promptHeaderMenuOpen, setPromptHeaderMenuOpen] = useState(false)
  const [promptBuilderLabels, setPromptBuilderLabels] = useState<string[]>(() => {
    if (Array.isArray(saved.promptBuilderLabels)) {
      return saved.promptBuilderLabels.filter((label: unknown): label is string => typeof label === 'string' && label.trim().length > 0)
    }
    return [...PROMPT_BUILDER_LABELS]
  })
  const [masterPrompts, setMasterPrompts] = useState<MasterPrompt[]>(savedMasterPrompts)
  const [hookPrompts, setHookPrompts] = useState<HookPrompt[]>(savedHookPrompts)
  const [hookPromptsPageOpen, setHookPromptsPageOpen] = useState(false)
  const [hookPromptEditing, setHookPromptEditing] = useState<HookPrompt | null>(null)
  const [masterPromptsPageOpen, setMasterPromptsPageOpen] = useState(false)
  const [masterPromptEditing, setMasterPromptEditing] = useState<MasterPrompt | null>(null)
  const [promptBuilderPreviewOpen, setPromptBuilderPreviewOpen] = useState(false)
  const [draggingPromptBuilderLabel, setDraggingPromptBuilderLabel] = useState<string | null>(null)
  const [promptBuilderDragPosition, setPromptBuilderDragPosition] = useState<{ x: number; y: number } | null>(null)
  const promptBuilderListRef = useRef<HTMLDivElement | null>(null)
  const promptBuilderDragTimer = useRef<number | null>(null)
  const promptBuilderDragRaf = useRef<number | null>(null)
  const promptBuilderHoldTimer = useRef<number | null>(null)
  const promptBuilderDragY = useRef(0)
  const promptBuilderDragX = useRef(0)
  const promptBuilderDragLabelRef = useRef<string | null>(null)
  const promptBuilderDragPointerRef = useRef<number | null>(null)
  const promptBuilderDragActiveRef = useRef(false)
  const promptBuilderLastTargetRef = useRef<string | null>(null)
  const promptBuilderLastInsertIndexRef = useRef<number | null>(null)
  const [activePromptLabelIds, setActivePromptLabelIds] = useState<string[]>(() => {
    const nav = performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined
    const isReload = nav?.type === 'reload' || (nav?.type == null && performance.navigation?.type === 1)
    return isReload && Array.isArray(saved.activePromptLabelIds) ? saved.activePromptLabelIds : []
  })
  const [promptLabels, setPromptLabels] = useState<PromptLabel[]>(savedPromptLabels)
  const [promptLabelTrash, setPromptLabelTrash] = useState<PromptLabel[]>(savedPromptLabelTrash)
  const [negativePrompt, setNegativePrompt] = useState(saved.negativePrompt ?? '')
  const [status, setStatus] = useState<Status>(saved.promptId ? 'running' : 'idle')
  const [progress, setProgress] = useState<{ value: number; max: number } | null>(saved.progress ?? null)
  const [results, setResults] = useState<ResultImage[]>(savedResults)
  const [latestResultId, setLatestResultId] = useState<string | null>(() => saved.promptId ? null : (savedResults[0]?.id ?? null))
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [errorLogs, setErrorLogs] = useState<ErrorLogEntry[]>(savedErrorLogs)
  const [uploading, setUploading] = useState({ one: false, two: false })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [ideasOpen, setIdeasOpen] = useState(false)
  const [resultsOpen, setResultsOpen] = useState(false)
  const [presetsOpen, setPresetsOpen] = useState(false)
  const [galleryPresets, setGalleryPresets] = useState<GalleryPreset[]>([])
  const presetImportInputRef = useRef<HTMLInputElement | null>(null)
  const historyImportInputRef = useRef<HTMLInputElement | null>(null)
  const [completedPromptId, setCompletedPromptId] = useState<string | null>(null)
  const [completedImageVisible, setCompletedImageVisible] = useState(true)
  const completedTapTimer = useRef<number | null>(null)
  const [completedTapState, setCompletedTapState] = useState<'idle' | 'armed' | 'confirmed'>('idle')
  const [promptLabelsSection, setPromptLabelsSection] = useState<'labels' | 'trash'>('labels')
  const [selectedPromptLabelId, setSelectedPromptLabelId] = useState<string | null>(null)
  const [editingPromptLabel, setEditingPromptLabel] = useState<{ id: string | null; name: string; text: string } | null>(null)
  const promptLabelHoldTimer = useRef<number | null>(null)
  const promptLabelTapTimer = useRef<number | null>(null)
  const promptLabelDidHold = useRef(false)
  const [promptLabelTapArmed, setPromptLabelTapArmed] = useState<string | null>(null)
  const [cfg, setCfg] = useState(saved.cfg ?? 2.5)
  const [steps, setSteps] = useState(saved.steps ?? 30)
  const [scheduler, setScheduler] = useState(saved.scheduler ?? 'normal')
  const [aspectRatio, setAspectRatio] = useState(saved.aspectRatio ?? '1:1 (Square)')
  const [megapixels, setMegapixels] = useState(saved.megapixels ?? 0.5)
  const [maxDimension, setMaxDimension] = useState(saved.maxDimension ?? 800)
  const [unetName, setUnetName] = useState(saved.unetName ?? DEFAULT_UNET_NAME)
  const [clipName, setClipName] = useState(saved.clipName ?? DEFAULT_CLIP_NAME)
  const [vaeName, setVaeName] = useState(saved.vaeName ?? DEFAULT_VAE_NAME)
  const [upscaleMethod, setUpscaleMethod] = useState(saved.upscaleMethod ?? DEFAULT_UPSCALE_METHOD)
  const [unetOptions, setUnetOptions] = useState<string[]>([])
  const [clipOptions, setClipOptions] = useState<string[]>([])
  const [vaeOptions, setVaeOptions] = useState<string[]>([])
  const [upscaleOptions, setUpscaleOptions] = useState<string[]>(FALLBACK_UPSCALE_METHODS)
  const [settingsOptionsLoading, setSettingsOptionsLoading] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [footerExpanded, setFooterExpanded] = useState(false)
  const [mainFooterVisible, setMainFooterVisible] = useState(true)
  const [logsOpen, setLogsOpen] = useState(false)
  const [datasetOpen, setDatasetOpen] = useState(false)
  const [promptVaultOpen, setPromptVaultOpen] = useState(false)
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [indexedDbInspectorOpen, setIndexedDbInspectorOpen] = useState(false)
  const [launcherLogs, setLauncherLogs] = useState<string[]>([])
  const [comfyPowerState, setComfyPowerState] = useState<'off' | 'starting' | 'active'>('off')
  const [powerProgress, setPowerProgress] = useState(0)
  const [fadeImageGlow, setFadeImageGlow] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyPage, setHistoryPage] = useState(1)
  const [historySection, setHistorySection] = useState<'history' | 'trash'>('history')
  const [trash, setTrash] = useState<ResultImage[]>(savedTrash)
  const currentGenerationPrompt = useRef<{ prompt: string; negativePrompt: string; cfg: number; steps: number; megapixels: number } | null>(null)
  const cleanupProgress = useRef<null | (() => void)>(null)
  const currentPromptId = useRef<string | null>(saved.promptId ?? null)
  function recordErrorLog(error: unknown) {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error)
    const entry: ErrorLogEntry = { id: `error-${Date.now()}-${Math.random().toString(36).slice(2)}`, timestamp: Date.now(), message }
    setErrorLogs((current) => [...current, entry].slice(-100))
    return message
  }


  async function inspectIndexedDb() {
    if (!('indexedDB' in window)) return []
    const databaseList = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : []
    const names = databaseList.map((item) => item.name).filter((name): name is string => typeof name === 'string')
    const output: Array<{ name: string; version: number; stores: Array<{ name: string; count: number; keyPath: string | string[] | null; autoIncrement: boolean }> }> = []
    for (const name of names) {
      await new Promise<void>((resolve) => {
        const request = indexedDB.open(name)
        request.onsuccess = () => {
          const db = request.result
          const stores = Array.from(db.objectStoreNames).map((storeName) => {
            try {
              const tx = db.transaction(storeName, 'readonly')
              const store = tx.objectStore(storeName)
              const countRequest = store.count()
              const countPromise = new Promise<number>((done) => {
                countRequest.onsuccess = () => done(countRequest.result)
                countRequest.onerror = () => done(-1)
              })
              return countPromise.then((count) => ({
                name: storeName,
                count,
                keyPath: store.keyPath,
                autoIncrement: store.autoIncrement,
              }))
            } catch {
              return Promise.resolve({ name: storeName, count: -1, keyPath: null, autoIncrement: false })
            }
          })
          Promise.all(stores).then((resolved) => {
            output.push({ name, version: db.version, stores: resolved })
            db.close()
            resolve()
          })
        }
        request.onerror = () => resolve()
      })
    }
    return output
  }

  async function inspectIndexedDbKeys(databaseName: string, storeName: string): Promise<Array<{ key: string; rawKey: IDBValidKey }>> {
    if (!('indexedDB' in window)) return []
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error || new Error('Could not open IndexedDB database.'))
    })
    return new Promise((resolve, reject) => {
      const keys: Array<{ key: string; rawKey: IDBValidKey }> = []
      let settled = false
      const finish = (error?: unknown) => {
        if (settled) return
        settled = true
        db.close()
        if (error) reject(error)
        else resolve(keys)
      }
      try {
        const tx = db.transaction(storeName, 'readonly')
        const request = tx.objectStore(storeName).openKeyCursor()
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) {
            finish()
            return
          }
          keys.push({ key: typeof cursor.key === 'string' ? cursor.key : JSON.stringify(cursor.key), rawKey: cursor.key })
          cursor.continue()
        }
        request.onerror = () => finish(request.error || new Error('Could not read IndexedDB records.'))
        tx.onerror = () => finish(tx.error || new Error('Could not read IndexedDB records.'))
        tx.onabort = () => finish(tx.error || new Error('Could not read IndexedDB records.'))
      } catch (error) {
        finish(error)
      }
    })
  }

  async function permanentlyDeleteIndexedDbStore(databaseName: string, storeName: string): Promise<void> {
    if (databaseName === 'comfyui-console-images' && (storeName === 'items' || storeName === 'archived')) {
      try {
        const current = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
        if (storeName === 'items') current.results = []
        if (storeName === 'archived') current.trash = []
        localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
        window.dispatchEvent(new Event('history-storage-updated'))
      } catch {}
    }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error || new Error('Could not open IndexedDB database.'))
    })
    await new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction(storeName, 'readwrite')
        tx.objectStore(storeName).clear()
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => { db.close(); reject(tx.error || new Error('Could not permanently delete the records.')) }
        tx.onabort = () => { db.close(); reject(tx.error || new Error('Delete operation was aborted.')) }
      } catch (error) {
        db.close()
        reject(error)
      }
    })
  }

  async function inspectIndexedDbRecord(databaseName: string, storeName: string, key: IDBValidKey): Promise<unknown> {
    if (!('indexedDB' in window)) return null
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error || new Error('Could not open IndexedDB database.'))
    })
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown, value?: unknown) => {
        if (settled) return
        settled = true
        db.close()
        if (error) reject(error)
        else resolve(value)
      }
      try {
        const tx = db.transaction(storeName, 'readonly')
        const request = tx.objectStore(storeName).get(key)
        request.onsuccess = () => finish(undefined, request.result ?? null)
        request.onerror = () => finish(request.error || new Error('Could not read IndexedDB record.'))
        tx.onerror = () => finish(tx.error || new Error('Could not read IndexedDB record.'))
        tx.onabort = () => finish(tx.error || new Error('Could not read IndexedDB record.'))
      } catch (error) {
        finish(error)
      }
    })
  }

  const isBusy = status === 'queued' || status === 'running' || status === 'cancelling'

  function comboOptions(data: any, nodeType: string, inputName: string): string[] {
    const values = data?.[nodeType]?.input?.required?.[inputName]?.[0]
    return Array.isArray(values) ? values.filter((value: unknown): value is string => typeof value === 'string') : []
  }

  async function refreshSettingsOptions() {
    setSettingsOptionsLoading(true)
    try {
      const [unetInfo, clipInfo, vaeInfo, scaleInfo] = await Promise.all([
        getNodeObjectInfo('UNETLoader'),
        getNodeObjectInfo('CLIPLoader'),
        getNodeObjectInfo('VAELoader'),
        getNodeObjectInfo('ImageScaleToMaxDimension'),
      ])
      const nextUnet = comboOptions(unetInfo, 'UNETLoader', 'unet_name')
      const nextClip = comboOptions(clipInfo, 'CLIPLoader', 'clip_name')
      const nextVae = comboOptions(vaeInfo, 'VAELoader', 'vae_name')
      const nextUpscale = comboOptions(scaleInfo, 'ImageScaleToMaxDimension', 'upscale_method')
      if (nextUnet.length) setUnetOptions(nextUnet)
      if (nextClip.length) setClipOptions(nextClip)
      if (nextVae.length) setVaeOptions(nextVae)
      if (nextUpscale.length) setUpscaleOptions(nextUpscale)
    } catch (error) {
      console.warn('Could not load ComfyUI settings options.', error)
    } finally {
      setSettingsOptionsLoading(false)
    }
  }

  useEffect(() => {
    void refreshSettingsOptions()
  }, [])

  useEffect(() => {
    let cancelled = false
    const checkPower = async () => {
      try {
        const remote = await getRemoteControlStatus()
        if (cancelled) return
        setComfyPowerState(remote.comfyui === 'running' ? 'active' : 'off')
      } catch {
        if (!cancelled) setComfyPowerState('off')
      }
    }
    void checkPower()
    const timer = window.setInterval(() => void checkPower(), 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  async function handlePresetImport(file: File | undefined) {
    if (!file) return
    try {
      const importedCount = await importGalleryPresets(file)
      await refreshGalleryPresets()
      if (!importedCount) {
        window.alert('Those presets are already in your Created Presets.')
        return
      }
      window.alert(`Imported ${importedCount} preset${importedCount === 1 ? '' : 's'}.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not import presets.'
      window.alert(message)
    }
  }

  const refreshGalleryPresets = async () => {
    try {
      const presets = await readGalleryPresets()
      setGalleryPresets(presets)
    } catch {
      setGalleryPresets([])
    }
  }

  useEffect(() => {
    void refreshGalleryPresets()
    const timer = window.setInterval(() => void refreshGalleryPresets(), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const promptBuilderHasValues = promptBuilderLabels.some((label) => promptBuilderValues[label]?.trim())

  function buildPromptBuilderPrompt() {
    const masterBlock = masterPrompts.filter((item) => item.enabled).map((item) => item.text.trim()).filter(Boolean).join('\n\n')
    const normalBlock = promptBuilderLabels.filter((label) => !disabledPromptBuilderLabels.includes(label)).map((label) => {
      const value = promptBuilderValues[label]?.trim()
      return value ? label + ': ' + value : ''
    }).filter(Boolean).join('\n')
    return [masterBlock, normalBlock].filter(Boolean).join('\n\n')
  }

  function createPromptBuilderLabel() {
    if (isBusy) return
    const name = window.prompt('Label name')?.trim()
    if (!name) return
    if (promptBuilderLabels.some((label) => label.toLowerCase() === name.toLowerCase())) {
      window.alert('A prompt builder label with that name already exists.')
      return
    }
    setPromptBuilderLabels((current) => [...current, name])
    setPromptBuilderValues((current) => ({ ...current, [name]: '' }))
  }

  function deletePromptBuilderLabel(label: string) {
    if (isBusy) return
    if (!window.confirm('Delete “' + label + '” from Prompt Builder?')) return
    setPromptBuilderLabels((current) => current.filter((item) => item !== label))
    setPromptBuilderValues((current) => {
      const next = { ...current }
      delete next[label]
      return next
    })
    if (activePromptBuilderLabel === label) setActivePromptBuilderLabel(null)
  }

  function createHookPrompt() {
    setHookPromptEditing({ id: '', name: '', text: '', enabled: true })
  }

  function saveHookPrompt() {
    if (!hookPromptEditing) return
    const name = hookPromptEditing.name.trim()
    const text = hookPromptEditing.text.trim()
    if (!name || !text) return
    if (hookPromptEditing.id) {
      setHookPrompts((current) => current.map((item) => item.id === hookPromptEditing.id ? { ...item, name, text } : item))
    } else {
      setHookPrompts((current) => [...current, { id: 'hook-' + Date.now() + '-' + Math.random().toString(36).slice(2), name, text, enabled: true }])
    }
    setHookPromptEditing(null)
  }

  function toggleHookPrompt(id: string) {
    setHookPrompts((current) => current.map((item) => item.id === id ? { ...item, enabled: !item.enabled } : item))
  }

  function deleteHookPrompt(id: string) {
    if (!window.confirm('Delete this Hook Prompt?')) return
    setHookPrompts((current) => current.filter((item) => item.id !== id))
  }

  function moveHookPrompt(id: string, direction: -1 | 1) {
    setHookPrompts((current) => {
      const index = current.findIndex((item) => item.id === id)
      const next = index + direction
      if (index < 0 || next < 0 || next >= current.length) return current
      const copy = [...current]
      const [item] = copy.splice(index, 1)
      copy.splice(next, 0, item)
      return copy
    })
  }

  async function moveItemsToPromptVault(items: PromptVaultItem[]) {
    if (!items.length) return
    await importPromptVaultItems(items)
    window.dispatchEvent(new Event('prompt-vault-updated'))
  }

  function createMasterPrompt() {
    if (isBusy) return
    setMasterPromptEditing({ id: '', name: '', text: '', enabled: true })
  }

  function saveMasterPrompt() {
    if (!masterPromptEditing) return
    const name = masterPromptEditing.name.trim()
    const text = masterPromptEditing.text.trim()
    if (!name || !text) return
    const duplicate = masterPrompts.some((item) => item.id !== masterPromptEditing.id && item.name.toLowerCase() === name.toLowerCase())
    if (duplicate) {
      window.alert('A master prompt with that name already exists.')
      return
    }
    if (masterPromptEditing.id) {
      setMasterPrompts((current) => current.map((item) => item.id === masterPromptEditing.id ? { ...item, name, text } : item))
    } else {
      setMasterPrompts((current) => [...current, { id: 'master-' + Date.now() + '-' + Math.random().toString(36).slice(2), name, text, enabled: true }])
    }
    setMasterPromptEditing(null)
  }

  function deleteMasterPrompt(id: string) {
    if (!window.confirm('Delete this master prompt?')) return
    setMasterPrompts((current) => current.filter((item) => item.id !== id))
    if (masterPromptEditing?.id === id) setMasterPromptEditing(null)
  }

  function toggleMasterPrompt(id: string) {
    setMasterPrompts((current) => current.map((item) => item.id === id ? { ...item, enabled: !item.enabled } : item))
  }

  function moveMasterPrompt(id: string, direction: -1 | 1) {
    setMasterPrompts((current) => {
      const index = current.findIndex((item) => item.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  function movePromptBuilderLabel(label: string, clientY: number) {
    const list = promptBuilderListRef.current
    if (!list) return

    const rect = list.getBoundingClientRect()
    const edge = 88
    const distanceFromTop = clientY - rect.top
    const distanceFromBottom = rect.bottom - clientY

    if (distanceFromTop < edge) {
      const speed = Math.min(18, Math.max(3, Math.round((edge - distanceFromTop) / 4)))
      list.scrollTop -= speed
    } else if (distanceFromBottom < edge) {
      const speed = Math.min(18, Math.max(3, Math.round((edge - distanceFromBottom) / 4)))
      list.scrollTop += speed
    }

    const items = Array.from(list.querySelectorAll<HTMLElement>("[data-prompt-builder-label]"))
      .filter((item) => item.dataset.promptBuilderLabel !== label)

    // Use item midpoints for both directions so the dragged label crosses
    // the same threshold going down as it does going up.
    let insertIndex = 0
    for (const item of items) {
      const itemRect = item.getBoundingClientRect()
      const midpoint = itemRect.top + itemRect.height / 2
      if (clientY >= midpoint) {
        insertIndex += 1
      } else {
        break
      }
    }

    if (insertIndex === promptBuilderLastInsertIndexRef.current) return
    promptBuilderLastInsertIndexRef.current = insertIndex
    promptBuilderLastTargetRef.current = items[insertIndex]?.dataset.promptBuilderLabel ?? null

    setPromptBuilderLabels((current) => {
      const next = current.filter((item) => item !== label)
      const clampedIndex = Math.min(insertIndex, next.length)
      next.splice(clampedIndex, 0, label)
      return next
    })
  }
  function stopPromptBuilderDrag() {
    if (promptBuilderDragTimer.current !== null) {
      window.clearInterval(promptBuilderDragTimer.current)
      promptBuilderDragTimer.current = null
    }
    if (promptBuilderHoldTimer.current !== null) {
      window.clearTimeout(promptBuilderHoldTimer.current)
      promptBuilderHoldTimer.current = null
    }
    if (promptBuilderDragRaf.current !== null) {
      window.cancelAnimationFrame(promptBuilderDragRaf.current)
      promptBuilderDragRaf.current = null
    }
    promptBuilderDragActiveRef.current = false
    promptBuilderDragLabelRef.current = null
    promptBuilderDragPointerRef.current = null
    promptBuilderLastTargetRef.current = null
    promptBuilderLastInsertIndexRef.current = null
    setDraggingPromptBuilderLabel(null)
    setPromptBuilderDragPosition(null)
  }

  function startPromptBuilderDrag(label: string, event: React.PointerEvent<HTMLDivElement>) {
    promptBuilderDragActiveRef.current = true
    promptBuilderDragLabelRef.current = label
    promptBuilderDragPointerRef.current = event.pointerId
    promptBuilderDragY.current = event.clientY
    promptBuilderDragX.current = event.clientX
    promptBuilderLastTargetRef.current = null
    promptBuilderLastInsertIndexRef.current = null
    setDraggingPromptBuilderLabel(label)
    setPromptBuilderDragPosition({ x: event.clientX, y: event.clientY })
    movePromptBuilderLabel(label, event.clientY)

    promptBuilderDragTimer.current = window.setInterval(() => {
      const activeLabel = promptBuilderDragLabelRef.current
      if (!activeLabel || !promptBuilderDragActiveRef.current) return
      movePromptBuilderLabel(activeLabel, promptBuilderDragY.current)
    }, 30)
  }

  if (currentPromptId.current && !currentGenerationPrompt.current) {
    currentGenerationPrompt.current = { prompt: saved.prompt ?? '', negativePrompt: saved.negativePrompt ?? '', cfg: saved.cfg ?? 2.5, steps: saved.steps ?? 30, megapixels: saved.megapixels ?? 0.5 }
  }

  const [imageOne, setImageOne] = useState<CharacterImage | null>(() => null)
  const [imageTwo, setImageTwo] = useState<CharacterImage | null>(() => null)
  const [selectedImagesRestored, setSelectedImagesRestored] = useState(false)
  const [showImageTwo, setShowImageTwo] = useState(() => saved.showImageTwo ?? !!saved.imageTwo)

  useEffect(() => {
    let cancelled = false
    const restoreSelectedImages = async () => {
      const savedImages = [
        { savedImage: saved.imageOne, setImage: setImageOne },
        { savedImage: saved.imageTwo, setImage: setImageTwo },
      ]
      for (const { savedImage, setImage } of savedImages) {
        if (cancelled || !savedImage?.cacheKey) continue
        const blob = await getCachedFile(savedImage.cacheKey)
        if (cancelled || !blob) continue
        setImage({
          previewUrl: URL.createObjectURL(blob),
          comfyName: savedImage.comfyName,
          fileName: savedImage.fileName || 'Selected image',
          cacheKey: savedImage.cacheKey,
        })
      }
    }
    void restoreSelectedImages().finally(() => {
      if (!cancelled) setSelectedImagesRestored(true)
    })
    void requestPersistentStorage()
    void ensureImageCacheDb()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!selectedImagesRestored) return
    const metadata = (items: ResultImage[]) => items.map((item) => ({
      id: item.id,
      type: 'history' as const,
      prompt: item.prompt || '',
      promptId: item.promptId || '',
      negativePrompt: item.negativePrompt,
      cfg: item.cfg,
      steps: item.steps,
      megapixels: item.megapixels,
      width: item.width,
      height: item.height,
      createdAt: item.createdAt,
    }))
    void syncHistoryMetadata(metadata(results), metadata(trash))
  }, [selectedImagesRestored, results, trash])

  useEffect(() => {
    if (!selectedImagesRestored) return
    const save = () => localStorage.setItem(STORAGE_KEY, JSON.stringify({
      prompt, promptLabelBlock, activePromptLabelIds, promptLabels, promptLabelTrash, promptBuilderOpen, promptBuilderValues, promptBuilderLabels, disabledPromptBuilderLabels, masterPrompts, hookPrompts, negativePrompt, results, trash,
      imageOne: imageOne ? { ...imageOne, previewUrl: undefined } : null,
      imageTwo: imageTwo ? { ...imageTwo, previewUrl: undefined } : null,
      showImageTwo,
      cfg, steps, scheduler, aspectRatio, megapixels, maxDimension, unetName, clipName, vaeName, upscaleMethod,
      promptId: currentPromptId.current, progress, errorLogs: errorLogs.slice(-100),
    }))
    save()
  }, [selectedImagesRestored, prompt, promptLabelBlock, activePromptLabelIds, promptLabels, promptLabelTrash, promptBuilderOpen, promptBuilderValues, promptBuilderLabels, negativePrompt, results, trash, imageOne, imageTwo, showImageTwo, cfg, steps, scheduler, aspectRatio, megapixels, maxDimension, progress, status, hookPrompts, errorLogs])

  useEffect(() => {
    if (currentPromptId.current) void waitForResult(currentPromptId.current)
  }, [])

  useEffect(() => {
    let cancelled = false
    const restoreImages = async () => {
      const items = [...savedResults, ...savedTrash]

      // Generated images are stored locally in IndexedDB. Restore from that
      // local copy first so history never depends on ComfyUI being online.
      for (const item of items) {
        if (cancelled) return
        const cached = await getCachedImage(item.id)
        if (cancelled) return
        if (cached) {
          const apply = (list: ResultImage[]) => list.map((entry) => entry.id === item.id ? { ...entry, url: cached } : entry)
          setResults((prev) => apply(prev))
          setTrash((prev) => apply(prev))
        }
      }

      // Older history entries may predate local image caching. Leave those
      // remote URLs alone; new generations are always cached before display.
    }
    void restoreImages()
    return () => { cancelled = true }
  }, [])


  useEffect(() => {
    if (!logsOpen) return
    let cancelled = false
    const loadLogs = async () => {
      try {
        const logs = await getLauncherLogs()
        if (!cancelled) setLauncherLogs(logs)
      } catch {}
    }
    void loadLogs()
    const timer = window.setInterval(loadLogs, 1500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [logsOpen])


  useEffect(() => {
    const locked = logsOpen || settingsOpen || historyOpen || ideasOpen || !!selectedPromptLabelId || !!editingPromptLabel
    const html = document.documentElement
    const body = document.body
    if (!locked) {
      html.style.overflow = ''
      body.style.overflow = ''
      body.style.position = ''
      body.style.top = ''
      body.style.width = ''
      return
    }

    const scrollY = window.scrollY
    html.style.overflow = 'hidden'
    body.style.overflow = 'hidden'
    body.style.position = 'fixed'
    body.style.top = `-${scrollY}px`
    body.style.width = '100%'

    return () => {
      html.style.overflow = ''
      body.style.overflow = ''
      body.style.position = ''
      body.style.top = ''
      body.style.width = ''
      window.scrollTo(0, scrollY)
    }
  }, [settingsOpen, historyOpen, ideasOpen, selectedPromptLabelId, editingPromptLabel])


  function clearImage(which: 'one' | 'two') {
    if (which === 'one') {
      if (imageOne?.previewUrl.startsWith('blob:')) URL.revokeObjectURL(imageOne.previewUrl)
      setImageOne(null)
      setPrompt((current: string) => removeImagePrompt(current, IMAGE_PROMPTS.one))
    } else {
      if (imageTwo?.previewUrl.startsWith('blob:')) URL.revokeObjectURL(imageTwo.previewUrl)
      setImageTwo(null)
      setPrompt((current: string) => removeImagePrompt(current, IMAGE_PROMPTS.two))
    }
  }

  async function setGalleryImage(which: 'one' | 'two', item: { src: string; name: string }, presetPrompt?: string) {
    try {
      const response = await fetch(item.src)
      if (!response.ok) throw new Error(`Could not read gallery image (${response.status})`)
      const blob = await response.blob()
      const file = new File([blob], item.name || 'Gallery image', { type: blob.type || 'image/png' })
      await handleImageChange(which, file)
      if (presetPrompt?.trim()) {
        setPrompt(addImagePrompt(presetPrompt.trim(), IMAGE_PROMPTS[which]))
      }
    } catch (err) {
      setErrorMsg(recordErrorLog(err))
    }
  }

  async function handleImageChange(which: 'one' | 'two', file?: File) {
    if (!file) return
    setErrorMsg(null)
    setUploading((p) => ({ ...p, [which]: true }))
    const previewUrl = URL.createObjectURL(file)
    try {
      const cacheKey = `input-${which}`
      await cacheFile(cacheKey, file)
      const value = { previewUrl, cacheKey, fileName: file.name }
      if (which === 'one') {
        setImageOne(value)
      } else {
        setImageTwo(value)
      }
    } catch (err) {
      URL.revokeObjectURL(previewUrl)
      setErrorMsg(recordErrorLog(err))
    } finally {
      setUploading((p) => ({ ...p, [which]: false }))
    }
  }

  async function fetchResult(promptId: string) {
    try {
      const history = await getHistory(promptId)
      const entry = history[promptId]
      if (!entry?.outputs) return false
      const images: ResultImage[] = []
      for (const nodeId of Object.keys(entry.outputs)) {
        const nodeOutput = entry.outputs[nodeId]
        if (nodeOutput?.images) for (const img of nodeOutput.images) {
          const imageId = `${promptId}-${img.filename}-${img.subfolder ?? ''}-${Date.now()}-${Math.random().toString(36).slice(2)}`
          const remoteUrl = viewImageUrl(img.filename, img.subfolder, img.type)
          let displayUrl = remoteUrl
          try {
            displayUrl = await cacheImage(imageId, remoteUrl)
          } catch {}
          images.push({
            id: imageId,
            url: displayUrl,
            promptId,
            prompt: currentGenerationPrompt.current?.prompt ?? '',
            negativePrompt: currentGenerationPrompt.current?.negativePrompt ?? '',
            cfg: currentGenerationPrompt.current?.cfg ?? cfg,
            steps: currentGenerationPrompt.current?.steps ?? steps,
            megapixels: currentGenerationPrompt.current?.megapixels ?? megapixels,
            createdAt: Date.now(),
          })
        }
      }
      if (images.length) {
        setResults((prev) => [...images, ...prev])
        setLatestResultId(images[0].id)
        setHistoryPage(1)
        setStatus('done'); setProgress({ value: 1, max: 1 }); currentPromptId.current = null
        cleanupProgress.current?.(); cleanupProgress.current = null
        return true
      }
      return false
    } catch (err) {
      setStatus('error'); setErrorMsg(recordErrorLog(err))
      cleanupProgress.current?.(); cleanupProgress.current = null
      return true
    }
  }

  async function waitForResult(promptId: string) {
    setStatus('running')
    cleanupProgress.current = connectProgress(promptId, (value, max) => setProgress({ value, max }))
    // ComfyUI is running on the user's own laptop, so generation time is not
    // bounded by the phone/browser. Keep polling until ComfyUI reports the
    // completed output instead of imposing an arbitrary 3-minute timeout.
    while (currentPromptId.current === promptId) {
      if (await fetchResult(promptId)) return
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  async function useGeneratedAsFigure(item: ResultImage, which: 'one' | 'two') {
    if (isBusy) return
    setErrorMsg(null)
    setUploading((p) => ({ ...p, [which]: true }))
    try {
      const response = await fetch(item.url, { cache: 'no-store' })
      if (!response.ok) throw new Error(`Could not read generated image (${response.status})`)
      const blob = await response.blob()
      const mime = blob.type || 'image/png'
      const extension = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png'
      const file = new File([blob], `generated_${Date.now()}_${which}.${extension}`, { type: mime })
      const cacheKey = `input-${which}`
      await cacheFile(cacheKey, file)
      const value: CharacterImage = {
        previewUrl: URL.createObjectURL(blob),
        cacheKey,
        fileName: `Generated image (${which === 'one' ? 'Figure A' : 'Figure B'})`,
      }
      if (which === 'one') {
        setImageOne(value)
      } else {
        setImageTwo(value)
      }
      setResultsOpen(false)
      return true
    } catch (err) {
      setErrorMsg(recordErrorLog(err))
      return false
    } finally {
      setUploading((p) => ({ ...p, [which]: false }))
    }
  }


  async function handleGenerate() {
    const mainGenerationPrompt = promptBuilderOpen ? buildPromptBuilderPrompt() : prompt.trim()
    const hookBlock = hookPrompts.filter((item) => item.enabled).map((item) => item.text.trim()).filter(Boolean).join('\n\n')
    const generationPrompt = hookBlock ? hookBlock + (mainGenerationPrompt ? '\n\n' + mainGenerationPrompt : '') : mainGenerationPrompt
    if (!generationPrompt || uploading.one || uploading.two) return
    setLatestResultId(null)
    setErrorMsg(null); setStatus('queued'); setProgress({ value: 0, max: 1 })
    try {
      let imageOneName = imageOne?.comfyName
      let imageTwoName = imageTwo?.comfyName
      if (imageOne?.cacheKey) {
        const blob = await getCachedFile(imageOne.cacheKey)
        if (!blob) throw new Error('Figure A image is no longer available. Please choose it again.')
        const file = new File([blob], imageOne.fileName, { type: blob.type || 'image/png' })
        const uploaded = await uploadImage(file)
        imageOneName = imagePath(uploaded.name, uploaded.subfolder)
      }
      if (imageTwo?.cacheKey) {
        const blob = await getCachedFile(imageTwo.cacheKey)
        if (!blob) throw new Error('Figure B image is no longer available. Please choose it again.')
        const file = new File([blob], imageTwo.fileName, { type: blob.type || 'image/png' })
        const uploaded = await uploadImage(file)
        imageTwoName = imagePath(uploaded.name, uploaded.subfolder)
      }
      currentGenerationPrompt.current = { prompt: generationPrompt, negativePrompt, cfg, steps, megapixels }
      const workflow = buildWorkflow({
        prompt: generationPrompt, negativePrompt: negativePrompt || undefined,
        image1: imageOneName, image2: imageTwoName,
        seed: Math.floor(Math.random() * 1_000_000_000), cfg, steps, scheduler,
        aspectRatio, megapixels, maxDimension,
        unetName, clipName, vaeName, upscaleMethod,
      })
      const { prompt_id } = await queuePrompt(workflow)
      currentPromptId.current = prompt_id
      setProgress({ value: 0, max: 1 })
      void waitForResult(prompt_id)
    } catch (err) {
      setStatus('error'); setErrorMsg(recordErrorLog(err))
    }
  }
  async function handleCancel() {
    if (!currentPromptId.current || cancelling) return
    setCancelling(true)
    setFadeImageGlow(true)
    setStatus('cancelling')
    try {
      await interruptGeneration()
      await new Promise((resolve) => setTimeout(resolve, 500))
      currentPromptId.current = null
      setProgress(null)
      setStatus('idle')
      window.setTimeout(() => setFadeImageGlow(false), 900)
    } catch (err) {
      setCancelling(false)
      setStatus('error')
      setErrorMsg(recordErrorLog(err))
      return
    }
    setCancelling(false)
  }

  const isUploading = uploading.one || uploading.two
  const percent = progress && progress.max > 0 ? Math.min(100, Math.round((progress.value / progress.max) * 100)) : 0

  useEffect(() => () => cleanupProgress.current?.(), [])
  useEffect(() => () => {
    if (completedTapTimer.current !== null) window.clearTimeout(completedTapTimer.current)
  }, [])
  useEffect(() => () => {
    if (imageOne?.previewUrl.startsWith('blob:')) URL.revokeObjectURL(imageOne.previewUrl)
    if (imageTwo?.previewUrl.startsWith('blob:')) URL.revokeObjectURL(imageTwo.previewUrl)
  }, [imageOne?.previewUrl, imageTwo?.previewUrl])

  useEffect(() => () => {
    if (promptLabelHoldTimer.current !== null) window.clearTimeout(promptLabelHoldTimer.current)
    if (promptLabelTapTimer.current !== null) window.clearTimeout(promptLabelTapTimer.current)
  }, [])

  function createPromptLabelId() {
    return `label-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }

  function openPromptLabelEditor(label?: PromptLabel) {
    if (label) setEditingPromptLabel({ id: label.id, name: label.name, text: label.text })
    else setEditingPromptLabel({ id: null, name: '', text: '' })
  }

  function savePromptLabel() {
    if (!editingPromptLabel) return
    const name = editingPromptLabel.name.trim() || 'Untitled Label'
    const text = editingPromptLabel.text.trim()
    if (!text) return
    if (editingPromptLabel.id) {
      const updated = { id: editingPromptLabel.id, name, text }
      setPromptLabels((prev) => prev.map((item) => item.id === editingPromptLabel.id ? { ...item, ...updated } : item))
      if (activePromptLabelIds.includes(editingPromptLabel.id)) {
        const nextBlock = promptLabels
          .map((item) => item.id === editingPromptLabel.id ? { ...item, ...updated } : item)
          .filter((item) => activePromptLabelIds.includes(item.id))
          .map((item) => item.text.trim())
          .filter(Boolean)
          .join('\n\n')
        const oldBlock = promptLabelBlock || getLabelBlock(activePromptLabelIds)
        let body = prompt
        if (oldBlock && body.startsWith(oldBlock)) body = body.slice(oldBlock.length).replace(/^\n\n/, '')
        setPrompt(nextBlock ? `${nextBlock}${body.trim() ? `\n\n${body.trim()}` : ''}` : body.trim())
        setPromptLabelBlock(nextBlock)
      }
    } else {
      setPromptLabels((prev) => [...prev, { id: createPromptLabelId(), name, text, createdAt: Date.now() }])
    }
    setEditingPromptLabel(null)
  }

  function deletePromptLabel(id: string) {
    const item = promptLabels.find((x) => x.id === id)
    if (!item) return
    const wasActive = activePromptLabelIds.includes(id)
    const nextIds = activePromptLabelIds.filter((x) => x !== id)
    setPromptLabels((prev) => prev.filter((x) => x.id !== id))
    setPromptLabelTrash((prev) => [item, ...prev])
    setActivePromptLabelIds(nextIds)
    if (wasActive) {
      const nextBlock = promptLabels.filter((label) => nextIds.includes(label.id)).map((label) => label.text).filter(Boolean).join('\n\n')
      let body = prompt
      if (promptLabelBlock && body.startsWith(promptLabelBlock)) body = body.slice(promptLabelBlock.length).replace(/^\n\n/, '')
      setPrompt(nextBlock ? `${nextBlock}${body.trim() ? `\n\n${body.trim()}` : ''}` : body)
      setPromptLabelBlock(nextBlock)
    }
  }

  function restorePromptLabel(id: string) {
    const item = promptLabelTrash.find((x) => x.id === id)
    if (!item) return
    setPromptLabelTrash((prev) => prev.filter((x) => x.id !== id))
    setPromptLabels((prev) => [...prev, item])
  }

  function permanentlyDeletePromptLabel(id: string) {
    setPromptLabelTrash((prev) => prev.filter((x) => x.id !== id))
  }

  function getLabelBlock(ids: string[]) {
    return promptLabels
      .filter((label) => ids.includes(label.id))
      .map((label) => label.text.trim())
      .filter(Boolean)
      .join('\n\n')
  }

  function rebuildPromptFromLabels(nextIds: string[]) {
    const orderedIds = promptLabels.filter((label) => nextIds.includes(label.id)).map((label) => label.id)
    const oldBlock = promptLabelBlock || getLabelBlock(activePromptLabelIds)
    const nextBlock = getLabelBlock(orderedIds)
    let body = prompt
    if (oldBlock && body.startsWith(oldBlock)) {
      body = body.slice(oldBlock.length).replace(/^\n\n/, '')
    } else {
      // Fallback: remove each currently active label from the top if the saved block was stale.
      const oldTexts = promptLabels
        .filter((label) => activePromptLabelIds.includes(label.id))
        .map((label) => label.text.trim())
        .filter(Boolean)
      for (const text of oldTexts) {
        if (body.startsWith(text)) body = body.slice(text.length).replace(/^\n\n/, '')
      }
    }
    const nextPrompt = nextBlock ? `${nextBlock}${body.trim() ? `\n\n${body.trim()}` : ''}` : body.trim()
    setPrompt(nextPrompt)
    setPromptLabelBlock(nextBlock)
    setActivePromptLabelIds(orderedIds)
  }

  function sendPromptLabelToPrompt(id: string) {
    const label = promptLabels.find((x) => x.id === id)
    if (!label) return
    if (activePromptLabelIds.includes(id)) return
    rebuildPromptFromLabels([...activePromptLabelIds, id])
  }

  function removePromptLabelFromPrompt(id: string) {
    if (!activePromptLabelIds.includes(id)) return
    rebuildPromptFromLabels(activePromptLabelIds.filter((labelId) => labelId !== id))
  }

  function handlePromptLabelPointerDown(id: string) {
    promptLabelDidHold.current = false
    if (promptLabelHoldTimer.current !== null) window.clearTimeout(promptLabelHoldTimer.current)
    promptLabelHoldTimer.current = window.setTimeout(() => {
      promptLabelDidHold.current = true
      if (promptLabelTapTimer.current !== null) { window.clearTimeout(promptLabelTapTimer.current); promptLabelTapTimer.current = null }
      setPromptLabelTapArmed(null)
      if (navigator.vibrate) navigator.vibrate(25)
      const label = promptLabels.find((x) => x.id === id)
      if (label) openPromptLabelEditor(label)
    }, 650)
  }

  function handlePromptLabelPointerUp() {
    if (promptLabelHoldTimer.current !== null) { window.clearTimeout(promptLabelHoldTimer.current); promptLabelHoldTimer.current = null }
  }

  function handlePromptLabelTap(id: string) {
    if (promptLabelDidHold.current) return
    if (promptLabelTapArmed === id) {
      if (promptLabelTapTimer.current !== null) { window.clearTimeout(promptLabelTapTimer.current); promptLabelTapTimer.current = null }
      setPromptLabelTapArmed(null)
      setSelectedPromptLabelId(id)
      return
    }
    setPromptLabelTapArmed(id)
    if (promptLabelTapTimer.current !== null) window.clearTimeout(promptLabelTapTimer.current)
    promptLabelTapTimer.current = window.setTimeout(() => {
      promptLabelTapTimer.current = null
      setPromptLabelTapArmed(null)
    }, 700)
  }

  async function restoreHistoryFromDataset(items: Array<{ prompt: string; images: Array<{ data: string; mimeType?: string; filename?: string }> }>) {
    const restored: ResultImage[] = []
    for (let index = 0; index < items.length; index++) {
      const source = items[index]
      for (let imageIndex = 0; imageIndex < source.images.length; imageIndex++) {
        const image = source.images[imageIndex]
        try {
          const response = await fetch(image.data)
          if (!response.ok) throw new Error('Could not read imported history image.')
          const blob = await response.blob()
          const id = `imported-history-${Date.now()}-${index}-${imageIndex}-${Math.random().toString(36).slice(2)}`
          await cacheFile(id, blob)
          restored.push({
            id,
            url: URL.createObjectURL(blob),
            promptId: `imported-${Date.now()}-${index}`,
            prompt: source.prompt || '',
            negativePrompt: '',
            createdAt: Date.now() - (index * 1000 + imageIndex),
          })
        } catch (error) {
          console.warn('Skipping imported history image', error)
        }
      }
    }
    if (!restored.length) throw new Error('No valid images were found in this JSON.')
    setResults((current) => [...restored, ...current])
    setLatestResultId(restored[0].id)
    setHistoryPage(1)
    setStatus('done')
  }

  function updateHistoryPrompt(id: string, nextPrompt: string) {
    setResults((prev) => prev.map((item) => item.id === id ? { ...item, prompt: nextPrompt } : item))
    setTrash((prev) => prev.map((item) => item.id === id ? { ...item, prompt: nextPrompt } : item))
  }

  function handleCompletedImageTap() {
    if (completedTapTimer.current !== null) {
      window.clearTimeout(completedTapTimer.current)
      completedTapTimer.current = null
      setCompletedTapState('confirmed')
      if (navigator.vibrate) navigator.vibrate(35)
      window.setTimeout(() => setCompletedPromptId(latestResultId), 120)
      window.setTimeout(() => setCompletedTapState('idle'), 260)
      return
    }

    setCompletedTapState('armed')
    if (navigator.vibrate) navigator.vibrate(12)
    completedTapTimer.current = window.setTimeout(() => {
      completedTapTimer.current = null
      setCompletedTapState('idle')
    }, 700)
  }

  function openHistory() {
    setHistorySection('history')
    setHistoryPage(1)
    setHistoryOpen(true)
  }

  async function importHistoryItem(file: File | undefined) {
    if (!file) return
    try {
      const text = await file.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error('The selected file is not valid JSON.')
      }
      if (!parsed || typeof parsed !== 'object') throw new Error('This file is not a ComfyUI PWA History export.')
      const payload = parsed as { format?: unknown; image?: { data?: unknown }; prompt?: unknown; metadata?: { createdAt?: unknown } }
      if (payload.format !== 'comfyui-pwa-history-image') throw new Error('This JSON is not a ComfyUI PWA History export.')
      if (!payload.image || typeof payload.image.data !== 'string' || !payload.image.data.startsWith('data:image/')) {
        throw new Error('The export does not contain a valid image.')
      }

      const response = await fetch(payload.image.data)
      if (!response.ok) throw new Error('Could not read the image from the export.')
      const blob = await response.blob()
      const id = 'imported-history-' + Date.now() + '-' + Math.random().toString(36).slice(2)
      await cacheFile(id, blob)

      const imported: ResultImage = {
        id,
        url: URL.createObjectURL(blob),
        promptId: 'imported-history',
        prompt: typeof payload.prompt === 'string' ? payload.prompt : '',
        negativePrompt: '',
        createdAt: typeof payload.metadata?.createdAt === 'number' ? payload.metadata.createdAt : Date.now(),
      }

      setResults((current) => [imported, ...current])
      setLatestResultId(imported.id)
      setHistorySection('history')
      setHistoryPage(1)
      setHistoryOpen(true)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Could not import this history export.')
    }
  }

  function moveToTrash(id: string) {
    const item = results.find((x) => x.id === id)
    if (!item) return
    setResults((prev) => prev.filter((x) => x.id !== id))
    setTrash((prev) => [item, ...prev])
    setHistoryPage((page) => {
      const remaining = results.length - 1
      const pageCount = Math.max(1, Math.ceil(remaining / HISTORY_PAGE_SIZE))
      return Math.min(page, pageCount)
    })
  }

  function restoreFromTrash(id: string) {
    const item = trash.find((x) => x.id === id)
    if (!item) return
    setTrash((prev) => prev.filter((x) => x.id !== id))
    setResults((prev) => [item, ...prev])
    setHistoryPage(1)
  }

  function permanentlyDelete(id: string) {
    const item = trash.find((x) => x.id === id)
    if (item?.url.startsWith('blob:')) URL.revokeObjectURL(item.url)
    void deleteCachedImage(id)
    setTrash((prev) => prev.filter((x) => x.id !== id))
  }

  function deleteAllTrash() {
    if (!trash.length) return
    const confirmed = window.confirm('Delete all ' + trash.length + ' item' + (trash.length === 1 ? '' : 's') + ' in the Recycle Bin? This cannot be undone.')
    if (!confirmed) return
    for (const item of trash) {
      if (item.url.startsWith('blob:')) URL.revokeObjectURL(item.url)
      void deleteCachedImage(item.id)
    }
    setTrash([])
    setHistoryPage(1)
  }


  const historyPageCount = Math.max(1, Math.ceil(results.length / HISTORY_PAGE_SIZE))
  const trashPageCount = Math.max(1, Math.ceil(trash.length / HISTORY_PAGE_SIZE))
  const activePageCount = historySection === 'history' ? historyPageCount : trashPageCount
  const safeHistoryPage = Math.min(historyPage, activePageCount)
  const activeItems = historySection === 'history'
    ? results.slice((safeHistoryPage - 1) * HISTORY_PAGE_SIZE, safeHistoryPage * HISTORY_PAGE_SIZE)
    : trash.slice((safeHistoryPage - 1) * HISTORY_PAGE_SIZE, safeHistoryPage * HISTORY_PAGE_SIZE)

  return <div className="app">
    <header className="app-empty-header">
      <button type="button" className="main-header-menu-button" aria-label="Open menu" title="Menu">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
    </header>
    {logsOpen && <div className="logs-backdrop" onClick={() => setLogsOpen(false)}>
      <section className="logs-panel" onClick={(e) => e.stopPropagation()}>
        <div className="logs-header">
          <div><h2>Error &amp; Launcher Logs</h2><span>Generation errors and ComfyUI start/stop events</span></div>
          <button className="close-btn" type="button" onClick={() => setLogsOpen(false)} aria-label="Close logs">×</button>
        </div>
        <div className="logs-body">
          <div className="logs-section-title">Generation Errors</div>
          {errorLogs.length ? [...errorLogs].reverse().map((entry) => (
            <div className="error-log-card" key={entry.id}>
              <time>{new Date(entry.timestamp).toLocaleString()}</time>
              <pre>{entry.message}</pre>
            </div>
          )) : <div className="logs-empty">No generation errors recorded.</div>}
          <div className="logs-section-title launcher-title">Launcher Logs</div>
          {launcherLogs.length
            ? launcherLogs.map((line, index) => <div className="log-line" key={`${index}-${line}`}>{line}</div>)
            : <div className="logs-empty">No launcher logs yet.</div>}
        </div>
      </section>
    </div>}

    {settingsOpen && <div className="settings-backdrop" onClick={() => setSettingsOpen(false)}>
      <aside className="settings-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header"><h2>Settings</h2><button className="close-btn" onClick={() => setSettingsOpen(false)}>×</button></div>
        <section className="settings-section">
          <h3>Generation</h3>
          <SettingNumber label="CFG" value={cfg} min={0.1} max={20} step={0.1} onChange={setCfg} />
          <SettingNumber label="Steps" value={steps} min={1} max={100} step={1} onChange={setSteps} />
          <label className="setting"><span>Scheduler</span><select value={scheduler} onChange={(e) => setScheduler(e.target.value)}>{SCHEDULERS.map((x) => <option key={x}>{x}</option>)}</select></label>
        </section>
        <section className="settings-section">
          <h3>Resolution</h3>
          <label className="setting"><span>Aspect ratio</span><select value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}>{ASPECT_RATIOS.map((x) => <option key={x}>{x}</option>)}</select></label>
          <SettingNumber label="Megapixels" value={megapixels} min={0.25} max={4} step={0.25} onChange={setMegapixels} />
          <SettingNumber label="Max dimension (Scale to Max Dimension)" value={maxDimension} min={256} max={2048} step={32} onChange={setMaxDimension} suffix="px" />
        </section>
        <section className="settings-section">
          <div className="settings-section-heading">
            <h3>Models &amp; Upscaling</h3>
            <button type="button" className="settings-refresh-btn" onClick={() => void refreshSettingsOptions()} disabled={settingsOptionsLoading}>
              {settingsOptionsLoading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          <label className="setting">
            <span>Diffusion model</span>
            <select value={unetName} onChange={(e) => setUnetName(e.target.value)}>
              {[...new Set([unetName, ...unetOptions])].filter(Boolean).map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
          <label className="setting">
            <span>CLIP model</span>
            <select value={clipName} onChange={(e) => setClipName(e.target.value)}>
              {[...new Set([clipName, ...clipOptions])].filter(Boolean).map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
          <label className="setting">
            <span>VAE model</span>
            <select value={vaeName} onChange={(e) => setVaeName(e.target.value)}>
              {[...new Set([vaeName, ...vaeOptions])].filter(Boolean).map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
          <label className="setting">
            <span>Upscale method</span>
            <select value={upscaleMethod} onChange={(e) => setUpscaleMethod(e.target.value)}>
              {[...new Set([upscaleMethod, ...upscaleOptions])].filter(Boolean).map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
        </section>
        <p className="settings-note">These model and upscale settings are sent into the Qwen workflow when you press Generate. Model choices are read directly from the connected ComfyUI instance.</p>
      </aside>
    </div>}

    {ideasOpen && <div className="ideas-page">
      <div className="prompt-labels-page">
        <div className="prompt-labels-header">
          <div><h2>Prompt Labels</h2><span>{promptLabelsSection === 'labels' ? `${promptLabels.length} label${promptLabels.length === 1 ? '' : 's'}` : `${promptLabelTrash.length} deleted label${promptLabelTrash.length === 1 ? '' : 's'}`}</span></div>
          <button className="close-btn" type="button" onClick={() => setIdeasOpen(false)} aria-label="Exit Prompt Labels">×</button>
        </div>
        <div className="prompt-labels-tabs">
          <button type="button" className={promptLabelsSection === 'labels' ? 'active' : ''} onClick={() => setPromptLabelsSection('labels')}>Labels</button>
          <button type="button" className={promptLabelsSection === 'trash' ? 'active' : ''} onClick={() => setPromptLabelsSection('trash')}>Recycle Bin{promptLabelTrash.length ? ` (${promptLabelTrash.length})` : ''}</button>
        </div>
        {promptLabelsSection === 'labels' ? <>
          <button className="prompt-label-add" type="button" onClick={() => openPromptLabelEditor()}>+ Add Prompt Label</button>
          <div className="prompt-label-list">
            {promptLabels.map((label, index) => <PromptLabelButton
              key={label.id}
              label={label}
              index={index}
              armed={promptLabelTapArmed === label.id}
              onPointerDown={() => handlePromptLabelPointerDown(label.id)}
              onPointerUp={handlePromptLabelPointerUp}
              onTap={() => handlePromptLabelTap(label.id)}
            />)}
            {!promptLabels.length && <div className="prompt-label-empty">No prompt labels yet.<br />Tap “+ Add Prompt Label” to create one.</div>}
          </div>
        </> : <div className="prompt-label-list prompt-label-trash-list">
          {promptLabelTrash.map((label) => <div className="prompt-label-trash-item" key={label.id}>
            <div><strong>{label.name}</strong><span>{label.text}</span></div>
            <div className="prompt-label-trash-actions">
              <button type="button" onClick={() => restorePromptLabel(label.id)}>Restore</button>
              <button type="button" className="danger" onClick={() => permanentlyDeletePromptLabel(label.id)}>Delete</button>
            </div>
          </div>)}
          {!promptLabelTrash.length && <div className="prompt-label-empty">Recycle Bin is empty.</div>}
        </div>}
      </div>
    </div>}

    {promptVaultOpen && (
      <PromptVaultPage onClose={() => setPromptVaultOpen(false)} />
    )}

    {datasetOpen && (
      <DatasetPage
        onClose={() => setDatasetOpen(false)}
        onMoveToVault={moveItemsToPromptVault}
        sourceItems={results.map((item) => ({ id: item.id, prompt: item.prompt, url: item.url, createdAt: item.createdAt }))}
        onRestoreHistory={restoreHistoryFromDataset}
      />
    )}

    {galleryOpen ? (
      <ImageGalleryPage onClose={() => setGalleryOpen(false)} onSetFigure={(which, item, presetPrompt) => { void setGalleryImage(which, item, presetPrompt) }} />
    ) : (
      <main className="app-main">
      {isBusy && progress && (
        <div className="progress-wrap" aria-label="Generation progress">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${percent}%` }} />
            {progress.value <= 1 ? (
              <span className="progress-preparing">Preparing...</span>
            ) : (
              <span className="progress-current" style={{ left: `${Math.min(100, Math.max(0, percent))}%` }}>{progress.value}</span>
            )}
            <span className="progress-total">{progress.max}</span>
          </div>
        </div>
      )}

      <section className={`image-pickers${showImageTwo ? '' : ' single'}`}>
        <ImagePicker glow={isBusy || fadeImageGlow} slot="image_1" label="Figure A" image={imageOne} busy={uploading.one} disabled={isBusy} onChange={(file) => void handleImageChange('one', file)} onClear={() => clearImage('one')} />
        {showImageTwo && <ImagePicker glow={isBusy || fadeImageGlow} slot="image_2" label="Figure B" image={imageTwo} busy={uploading.two} disabled={isBusy} onChange={(file) => void handleImageChange('two', file)} onClear={() => clearImage('two')} />}
      </section>

      <section className="generation-embed">
        <div className="field">
          <div className="prompt-field-header">
            <label htmlFor="prompt">Prompt</label>
            <div className="prompt-header-actions">
              <button
                type="button"
                className={`prompt-footer-toggle ${mainFooterVisible ? 'visible' : 'hidden'}`}
                onClick={() => { setMainFooterVisible((current) => !current); setFooterExpanded(false) }}
                aria-pressed={mainFooterVisible}
                aria-label={mainFooterVisible ? 'Hide main footer' : 'Show main footer'}
                title={mainFooterVisible ? 'Hide main footer' : 'Show main footer'}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  {mainFooterVisible ? <path d="M5 9h14M5 15h14" /> : <path d="M5 12h14" />}
                </svg>
              </button>
              {promptHeaderMenuOpen && (
                <>
                  <button
                    type="button"
                    className="prompt-header-menu-backdrop"
                    aria-label="Close prompt options"
                    onClick={() => setPromptHeaderMenuOpen(false)}
                  />
                  <div className="prompt-header-menu" role="menu">
                    <button
                      type="button"
                      className={`prompt-header-menu-item${showImageTwo ? ' active' : ''}`}
                      onClick={() => {
                        if (showImageTwo) {
                          clearImage('two')
                          setShowImageTwo(false)
                        } else {
                          setShowImageTwo(true)
                        }
                        setPromptHeaderMenuOpen(false)
                      }}
                      disabled={isBusy}
                      role="menuitem"
                    >
                      <span className="prompt-menu-item-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24">
                          <rect x="3" y="4" width="18" height="16" rx="2" />
                          <circle cx="8" cy="9" r="1.4" />
                          <path d="m5 17 4.5-4.5 3 3 2.5-2.5L19 17" />
                          <path d="M19 3v5M16.5 5.5h5" />
                        </svg>
                      </span>
                      <span>{showImageTwo ? 'Remove Figure B' : 'Add Figure B'}</span>
                    </button>
                    <button
                      type="button"
                      className={`prompt-header-menu-item${promptBuilderOpen ? ' active' : ''}`}
                      onClick={() => {
                        setPromptBuilderOpen((open: boolean) => !open)
                        setPromptHeaderMenuOpen(false)
                      }}
                      disabled={isBusy}
                      role="menuitem"
                    >
                      <span className="prompt-menu-item-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24">
                          <path d="M5 19 16.5 7.5" />
                          <path d="m14 5 2-2 5 5-2 2" />
                          <path d="M5 19h5" />
                        </svg>
                      </span>
                      <span>{promptBuilderOpen ? 'Disable Prompt Builder' : 'Prompt Builder'}</span>
                    </button>
                    <button
                      type="button"
                      className={`prompt-header-menu-item${promptVaultOpen ? ' active' : ''}`}
                      onClick={() => {
                        setPromptVaultOpen(true)
                        setPromptHeaderMenuOpen(false)
                        setFooterExpanded(false)
                      }}
                      role="menuitem"
                    >
                      <span className="prompt-menu-item-icon vault" aria-hidden="true">
                        <svg viewBox="0 0 24 24">
                          <path d="M4 8h16v12H4z" />
                          <path d="M7 8V5h10v3" />
                          <path d="M9 12h6" />
                          <path d="M9 16h6" />
                        </svg>
                      </span>
                      <span>Prompt Vault</span>
                    </button>
                    <button
                      type="button"
                      className="prompt-header-menu-item"
                      onClick={() => {
                        setIdeasOpen(true)
                        setPromptHeaderMenuOpen(false)
                      }}
                      role="menuitem"
                    >
                      <span className="prompt-menu-item-icon idea" aria-hidden="true">
                        <svg viewBox="0 0 24 24">
                          <path d="M9 18h6" />
                          <path d="M10 21h4" />
                          <path d="M8.7 15.2C7.6 14.3 7 13 7 11.5A5 5 0 0 1 17 11.5c0 1.5-.6 2.8-1.7 3.7-.8.7-1.3 1.5-1.3 2.8h-4c0-1.3-.5-2.1-1.3-2.8Z" />
                          <path d="M12 2v2M4.9 4.9l1.4 1.4M2 12h2M19.1 4.9l-1.4 1.4M22 12h-2" />
                        </svg>
                      </span>
                      <span>Prompt Labels</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
          {promptBuilderOpen ? (
            <div className="prompt-builder">
              <button
                type="button"
                className={`prompt-builder-open-btn${promptBuilderHasValues ? ' has-active-labels' : ''}`}
                onClick={() => setPromptBuilderPageOpen(true)}
                disabled={isBusy}
              >
                Prompt Builder
              </button>
            </div>
          ) : (
            <>
              <textarea id="prompt" value={prompt} onFocus={() => { setPromptExpanded(true); setHookPreviewExpanded(false) }} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe what you want to generate..." rows={4} />
            </>
          )}</div>
        <div className="field"><label htmlFor="negative">Negative prompt (optional)</label><textarea id="negative" value={negativePrompt} onChange={(e) => setNegativePrompt(e.target.value)} placeholder="What to avoid..." rows={2} /></div>

        <div className="generation-actions">
          {isBusy ? (
            <button className="cancel-btn" onClick={() => void handleCancel()} disabled={cancelling}>
              {cancelling ? 'Cancelling...' : 'Stop Generation'}
            </button>
          ) : (
            <button className="generate-btn" onClick={handleGenerate} disabled={isUploading || !(hookPrompts.some((item) => item.enabled && item.text.trim()) || (promptBuilderOpen ? buildPromptBuilderPrompt().trim() : prompt.trim()))}>
              {isUploading ? 'Uploading images...' : 'Generate'}
            </button>
          )}
          <button className="preset-btn" type="button" onClick={() => { void refreshGalleryPresets(); setPresetsOpen(true) }} aria-label="Open created presets" title="Created presets">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="4" y="4" width="16" height="16" rx="2"/>
              <path d="M7.5 15.5l3-3 2.5 2.5 2-2 1.5 1.5"/>
              <circle cx="9" cy="9" r="1.2"/>
            </svg>
          </button>
          <button className="results-btn" type="button" onClick={() => setResultsOpen(true)} aria-label="Open completed generations" title="Completed generations">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="4" y="4" width="16" height="16" rx="2"/>
              <path d="M7.5 15.5l3-3 2.5 2.5 2-2 1.5 1.5"/>
              <circle cx="9" cy="9" r="1.2"/>
            </svg>
          </button>
        </div>
      </section>

      {promptExpanded && (
        <div className="prompt-editor-page" role="dialog" aria-modal="true" aria-label="Prompt editor">
          <div className="prompt-editor-page-header">
            <div>
              <span className="prompt-expanded-title">Prompt</span>
              <span className="prompt-expanded-subtitle">Full-screen editor</span>
            </div>
            <button type="button" className="prompt-expanded-close" onClick={() => setPromptExpanded(false)} aria-label="Close expanded prompt">×</button>
          </div>
          {hookPrompts.length > 0 && (
            <button
              type="button"
              className={`prompt-hook-preview${hookPreviewExpanded ? ' expanded' : ' collapsed'}`}
              aria-expanded={hookPreviewExpanded}
              aria-label={hookPreviewExpanded ? 'Collapse Hook Prompts' : 'Expand Hook Prompts'}
              onClick={() => setHookPreviewExpanded((open) => !open)}
            >
              <span className="prompt-hook-preview-title">Hook Prompts · {hookPrompts.length}</span>
              {hookPreviewExpanded && (
                <span className="prompt-hook-preview-content">
                  {hookPrompts.filter((item) => item.enabled).map((item) => <span className="prompt-hook-preview-item" key={item.id}>{item.text}</span>)}
                  <span className="prompt-hook-return" />
                </span>
              )}
              {!hookPreviewExpanded && <span className="prompt-hook-preview-chevron">⌄</span>}
            </button>
          )}
          <textarea
            id="prompt-expanded-editor"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe what you want to generate..."
            autoFocus
          />
        </div>
      )}

      {promptBuilderPageOpen && (
        <section className="prompt-builder-page" aria-label="Prompt Builder">
          <div className="prompt-builder-page-header">
            <div>
              <h2>Prompt Builder</h2>
              <span>{promptBuilderLabels.length} normal label{promptBuilderLabels.length === 1 ? '' : 's'} · {masterPrompts.length} master prompt{masterPrompts.length === 1 ? '' : 's'}</span>
            </div>
            <button className="close-btn" type="button" onClick={() => { setPromptBuilderPageOpen(false); setActivePromptBuilderLabel(null) }} aria-label="Close Prompt Builder">×</button>
          </div>
          <div className="prompt-builder-page-tools">
            <button type="button" className="prompt-builder-tool-btn master" onClick={() => setMasterPromptsPageOpen(true)} disabled={isBusy}>Master Prompts</button>
            <button type="button" className="prompt-builder-tool-btn" onClick={createPromptBuilderLabel} disabled={isBusy}>+ Add Label</button>
            <button type="button" className="prompt-builder-tool-btn preview" onClick={() => setPromptBuilderPreviewOpen(true)}>Preview Final Prompt</button>
          </div>
          <div ref={promptBuilderListRef} className={'prompt-builder-page-list' + (activePromptBuilderLabel ? ' focus-mode' : '')}>
            {promptBuilderLabels.map((label) => {
              if (activePromptBuilderLabel && activePromptBuilderLabel !== label) return null
              const value = promptBuilderValues[label] ?? ''
              const hasValue = value.trim().length > 0
              const inputId = 'prompt-builder-page-' + label.replace(/[^A-Z0-9]+/gi, '-').toLowerCase()
              return (
                <div className={'prompt-builder-item' + (hasValue ? ' has-value' : '') + (draggingPromptBuilderLabel === label ? ' dragging' : '')} key={label} data-prompt-builder-label={label}>
                  {!activePromptBuilderLabel && (
                    <div
                      className="prompt-builder-drag-handle"
                      role="button"
                      tabIndex={isBusy ? -1 : 0}
                      aria-label={'Reorder ' + label}
                      onPointerDown={(event) => {
                        if (isBusy) return
                        event.preventDefault()
                        event.currentTarget.setPointerCapture(event.pointerId)
                        promptBuilderDragY.current = event.clientY
                        promptBuilderDragX.current = event.clientX
                        promptBuilderDragPointerRef.current = event.pointerId
                        if (promptBuilderHoldTimer.current !== null) window.clearTimeout(promptBuilderHoldTimer.current)
                        promptBuilderHoldTimer.current = window.setTimeout(() => { startPromptBuilderDrag(label, event) }, 160)
                      }}
                      onPointerMove={(event) => {
                        if (promptBuilderDragPointerRef.current !== event.pointerId) return
                        const moved = Math.hypot(event.clientX - promptBuilderDragX.current, event.clientY - promptBuilderDragY.current)
                        if (!promptBuilderDragActiveRef.current) {
                          if (moved > 10) {
                            if (promptBuilderHoldTimer.current !== null) window.clearTimeout(promptBuilderHoldTimer.current)
                            promptBuilderHoldTimer.current = null
                            return
                          }
                          return
                        }
                        event.preventDefault()
                        promptBuilderDragY.current = event.clientY
                        promptBuilderDragX.current = event.clientX
                        if (promptBuilderDragRaf.current === null) {
                          promptBuilderDragRaf.current = window.requestAnimationFrame(() => {
                            promptBuilderDragRaf.current = null
                            setPromptBuilderDragPosition({ x: promptBuilderDragX.current, y: promptBuilderDragY.current })
                          })
                        }
                        movePromptBuilderLabel(label, event.clientY)
                      }}
                      onPointerUp={(event) => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
                        stopPromptBuilderDrag()
                      }}
                      onPointerCancel={stopPromptBuilderDrag}
                      onLostPointerCapture={stopPromptBuilderDrag}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                          event.preventDefault()
                          setPromptBuilderLabels((current) => {
                            const next = [...current]
                            const index = next.indexOf(label)
                            const target = event.key === 'ArrowUp' ? index - 1 : index + 1
                            if (index < 0 || target < 0 || target >= next.length) return current
                            ;[next[index], next[target]] = [next[target], next[index]]
                            return next
                          })
                        }
                      }}
                    >⋮⋮</div>
                  )}
                  <div className="prompt-builder-control">
                    <button
                      type="button"
                      className={'prompt-builder-label' + (hasValue ? ' has-value' : '') + (disabledPromptBuilderLabels.includes(label) ? ' disabled' : '') + (activePromptBuilderLabel === label ? ' focused' : '')}
                      onClick={(event) => {
                        if (isBusy) return
                        if (event.currentTarget.dataset.holdTriggered === '1') {
                          event.currentTarget.dataset.holdTriggered = '0'
                          return
                        }
                        setDisabledPromptBuilderLabels((current) => current.includes(label) ? current.filter((item) => item !== label) : [...current, label])
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        if (isBusy) return
                        setActivePromptBuilderLabel(label)
                      }}
                      onPointerDown={(event) => {
                        if (isBusy) return
                        event.currentTarget.dataset.holdTriggered = '0'
                        const target = event.currentTarget
                        const timer = window.setTimeout(() => {
                          target.dataset.holdTriggered = '1'
                          setActivePromptBuilderLabel(label)
                        }, 450)
                        const cleanup = () => {
                          window.clearTimeout(timer)
                          target.removeEventListener('pointerup', cleanup)
                          target.removeEventListener('pointercancel', cleanup)
                        }
                        target.addEventListener('pointerup', cleanup)
                        target.addEventListener('pointercancel', cleanup)
                      }}
                      disabled={isBusy}
                    >
                      {hasValue ? label + ': ' + value : label}
                    </button>
                    {!activePromptBuilderLabel && <button type="button" className="prompt-builder-delete-btn" onClick={() => deletePromptBuilderLabel(label)} disabled={isBusy} aria-label={'Delete ' + label}>×</button>}
                    {activePromptBuilderLabel === label && (
                      <textarea
                        id={inputId}
                        className="prompt-builder-input prompt-builder-input-focused"
                        value={value}
                        onChange={(e) => setPromptBuilderValues((current) => ({ ...current, [label]: e.target.value }))}
                        onBlur={() => setActivePromptBuilderLabel(null)}
                        placeholder={'Enter ' + label.toLowerCase() + '...'}
                        disabled={isBusy}
                        autoFocus
                        rows={8}
                      />
                    )}
                  </div>
                </div>
              )
            })}
            {!promptBuilderLabels.length && <div className="prompt-builder-empty">No normal labels yet. Add one above.</div>}
          </div>
          {draggingPromptBuilderLabel && promptBuilderDragPosition && (
            <div className="prompt-builder-drag-ghost" style={{ left: promptBuilderDragPosition.x + 12, top: promptBuilderDragPosition.y + 12 }} aria-hidden="true">
              {(() => {
                const value = promptBuilderValues[draggingPromptBuilderLabel] ?? ''
                return value.trim() ? draggingPromptBuilderLabel + ': ' + value : draggingPromptBuilderLabel
              })()}
            </div>
          )}
        </section>
      )}

      {hookPromptsPageOpen && (
        <section className="hook-prompts-page" aria-label="Hook Prompts">
          <div className="hook-prompts-page-header hook-prompts-minimal-header">
            <button className="close-btn" type="button" onClick={() => { setHookPromptsPageOpen(false); setHookPromptEditing(null) }} aria-label="Close Hook Prompts">×</button>
          </div>
          <div className="hook-prompts-page-tools">
            <button type="button" className="prompt-builder-tool-btn master" onClick={createHookPrompt} disabled={isBusy}>+ Add Hook Prompt</button>
          </div>
          <div className="hook-prompts-page-list">
            {hookPrompts.map((item, index) => (
              <article className={`hook-prompt-row${item.enabled ? '' : ' disabled'}`} key={item.id}>
                <button type="button" className="hook-prompt-button" onClick={() => setHookPromptEditing(item)} disabled={isBusy}>
                  <span className="hook-prompt-index">{String(index + 1).padStart(2, '0')}</span>
                  <span className="hook-prompt-card-copy">
                    <strong>{item.name}</strong>
                    <span>{item.text}</span>
                  </span>
                  <span className="hook-prompt-status">{item.enabled ? 'Included' : 'Disabled'}</span>
                </button>
                <div className="hook-prompt-controls">
                  <button type="button" className={`hook-prompt-toggle${item.enabled ? ' enabled' : ' disabled'}`} onClick={() => toggleHookPrompt(item.id)} disabled={isBusy} aria-label={item.enabled ? 'Disable ' + item.name : 'Enable ' + item.name}>
                    {item.enabled ? 'ON' : 'OFF'}
                  </button>
                  <div className="hook-prompt-order">
                    <button type="button" onClick={() => moveHookPrompt(item.id, -1)} disabled={isBusy || index === 0} aria-label="Move hook prompt up">↑</button>
                    <button type="button" onClick={() => moveHookPrompt(item.id, 1)} disabled={isBusy || index === hookPrompts.length - 1} aria-label="Move hook prompt down">↓</button>
                  </div>
                  <button type="button" className="hook-prompt-delete" onClick={() => deleteHookPrompt(item.id)} disabled={isBusy} aria-label={'Delete ' + item.name}>Delete</button>
                </div>
              </article>
            ))}
            {!hookPrompts.length && <div className="prompt-builder-empty">No Hook Prompts yet. Add one above.</div>}
          </div>
          {hookPromptEditing && (
            <div className="hook-prompt-editor-backdrop" onClick={() => setHookPromptEditing(null)}>
              <section className="hook-prompt-editor" onClick={(event) => event.stopPropagation()}>
                <div className="hook-prompt-editor-header">
                  <div><h2>{hookPromptEditing.id ? 'Edit Hook Prompt' : 'New Hook Prompt'}</h2><span>Enabled Hook Prompts are placed first. Disabled hooks are kept for later.</span></div>
                  <button className="close-btn" type="button" onClick={() => setHookPromptEditing(null)} aria-label="Close Hook Prompt editor">×</button>
                </div>
                <label>Name<input value={hookPromptEditing.name} onChange={(e) => setHookPromptEditing((current) => current ? { ...current, name: e.target.value } : current)} placeholder="Example: Preservation" autoFocus /></label>
                <label>Prompt text<textarea value={hookPromptEditing.text} onChange={(e) => setHookPromptEditing((current) => current ? { ...current, text: e.target.value } : current)} placeholder="Enter the hook prompt text..." rows={10} /></label>
                <div className="hook-prompt-editor-actions">
                  <button type="button" onClick={() => setHookPromptEditing(null)}>Cancel</button>
                  <button type="button" className="primary" onClick={saveHookPrompt} disabled={!hookPromptEditing.name.trim() || !hookPromptEditing.text.trim()}>Save</button>
                </div>
              </section>
            </div>
          )}
        </section>
      )}

      {masterPromptsPageOpen && (
        <section className="prompt-builder-page" aria-label="Master Prompts">
          <div className="prompt-builder-page-header">
            <div>
              <h2>Master Prompts</h2>
              <span>Always included at the top of the final prompt</span>
            </div>
            <button className="close-btn" type="button" onClick={() => setMasterPromptsPageOpen(false)} aria-label="Close Master Prompts">×</button>
          </div>
          <div className="master-prompts-page-list">
            <button type="button" className="prompt-builder-tool-btn master" onClick={createMasterPrompt} disabled={isBusy}>+ Add Master Prompt</button>
            {masterPrompts.map((item, index) => (
              <div className={'master-prompt-row' + (item.enabled ? '' : ' disabled')} key={item.id}>
                <button type="button" className="master-prompt-button" onClick={() => setMasterPromptEditing(item)} disabled={isBusy}>
                  <strong>{item.name}</strong>
                  <span>{item.text}</span>
                </button>
                <button type="button" className={'master-prompt-toggle' + (item.enabled ? ' enabled' : '')} onClick={() => toggleMasterPrompt(item.id)} disabled={isBusy} aria-label={(item.enabled ? 'Deactivate ' : 'Activate ') + item.name}>{item.enabled ? 'ON' : 'OFF'}</button>
                <div className="master-prompt-order">
                  <button type="button" onClick={() => moveMasterPrompt(item.id, -1)} disabled={isBusy || index === 0} aria-label={'Move ' + item.name + ' up'}>↑</button>
                  <button type="button" onClick={() => moveMasterPrompt(item.id, 1)} disabled={isBusy || index === masterPrompts.length - 1} aria-label={'Move ' + item.name + ' down'}>↓</button>
                </div>
                <button type="button" className="master-prompt-delete" onClick={() => deleteMasterPrompt(item.id)} disabled={isBusy} aria-label={'Delete ' + item.name}>×</button>
              </div>
            ))}
            {!masterPrompts.length && <div className="prompt-builder-empty">No master prompts yet. Add one above.</div>}
          </div>
          {masterPromptEditing && (
            <div className="master-prompt-editor-backdrop" onClick={() => setMasterPromptEditing(null)}>
              <section className="master-prompt-editor" onClick={(event) => event.stopPropagation()}>
                <div className="master-prompt-editor-header">
                  <div><h2>{masterPromptEditing.id ? 'Edit Master Prompt' : 'New Master Prompt'}</h2><span>Master prompts are always placed first.</span></div>
                  <button className="close-btn" type="button" onClick={() => setMasterPromptEditing(null)} aria-label="Close master prompt editor">×</button>
                </div>
                <label>Button name<input value={masterPromptEditing.name} onChange={(e) => setMasterPromptEditing((current) => current ? { ...current, name: e.target.value } : current)} placeholder="Example: Lighting" autoFocus /></label>
                <label>Prompt text<textarea value={masterPromptEditing.text} onChange={(e) => setMasterPromptEditing((current) => current ? { ...current, text: e.target.value } : current)} placeholder="Enter the prompt text..." rows={8} /></label>
                <div className="master-prompt-editor-actions">
                  <button type="button" onClick={() => setMasterPromptEditing(null)}>Cancel</button>
                  <button type="button" className="primary" onClick={saveMasterPrompt} disabled={!masterPromptEditing.name.trim() || !masterPromptEditing.text.trim()}>Save</button>
                </div>
              </section>
            </div>
          )}
        </section>
      )}

      {promptBuilderPreviewOpen && (
        <div className="prompt-builder-preview-backdrop" onClick={() => setPromptBuilderPreviewOpen(false)}>
          <section className="prompt-builder-preview" onClick={(event) => event.stopPropagation()}>
            <div className="prompt-builder-preview-header">
              <div><h2>Final Prompt</h2><span>Master prompts first, then normal labels in list order</span></div>
              <button className="close-btn" type="button" onClick={() => setPromptBuilderPreviewOpen(false)} aria-label="Close prompt preview">×</button>
            </div>
            <div className="prompt-builder-preview-body"><pre>{buildPromptBuilderPrompt() || 'No prompt content yet.'}</pre></div>
          </section>
        </div>
      )}

      {status === 'cancelling' && <p className="cancel-text">Cancelling generation…</p>}
      {errorMsg && <p className="error-text">{errorMsg}</p>}
      {presetsOpen && (
        <div className="preset-popup-backdrop" onClick={() => setPresetsOpen(false)}>
          <section className="preset-popup" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Created presets">
            <div className="preset-popup-header">
              <div>
                <h2>Created Presets</h2>
                <span>{galleryPresets.length} preset{galleryPresets.length === 1 ? '' : 's'}</span>
              </div>
              <div className="preset-popup-header-actions">
                <button type="button" className="preset-import-btn" onClick={() => presetImportInputRef.current?.click()} aria-label="Import created presets">Import JSON</button>
                <input
                  ref={presetImportInputRef}
                  type="file"
                  accept="application/json,.json,text/json"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    void handlePresetImport(file)
                    event.currentTarget.value = ''
                  }}
                />
                <button type="button" className="close-btn" onClick={() => setPresetsOpen(false)} aria-label="Close presets">×</button>
              </div>
            </div>
            <div className="preset-popup-list">
              {galleryPresets.length ? galleryPresets.map((preset) => (
                <button
                  type="button"
                  className="preset-popup-item"
                  key={preset.id}
                  onClick={() => {
                    setPrompt(preset.prompt)
                    setPromptBuilderOpen(false)
                    setPresetsOpen(false)
                  }}
                >
                  <strong>{preset.title}</strong>
                  <span>{preset.prompt}</span>
                </button>
              )) : (
                <div className="preset-popup-empty">No created presets. Create one from Gallery Menu.</div>
              )}
            </div>
          </section>
        </div>
      )}

      {resultsOpen && (
        <section className="results-page" aria-label="Completed generations">
          <div className="results-page-header">
            <div>
              <h2>Completed Generations</h2>
              <span>{results.length} completed image{results.length === 1 ? '' : 's'}</span>
            </div>
            <div className="results-page-header-actions">
              <button
                className={`results-image-toggle${completedImageVisible ? ' active' : ''}`}
                type="button"
                onClick={() => setCompletedImageVisible((visible) => !visible)}
                aria-label="Toggle generated image"
                title="Toggle generated image"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  {completedImageVisible ? (
                    <>
                      <rect x="3" y="5" width="18" height="14" rx="2"/>
                      <circle cx="8.5" cy="10" r="1.3"/>
                      <path d="M4.5 17l5-5 3.5 3.5 2.5-2.5 4 4"/>
                    </>
                  ) : (
                    <>
                      <rect x="3" y="5" width="18" height="14" rx="2"/>
                      <circle cx="8.5" cy="10" r="1.3"/>
                      <path d="M4.5 17l5-5 3.5 3.5 2.5-2.5 4 4"/>
                      <path d="M4 4l16 16"/>
                    </>
                  )}
                </svg>
              </button>
              <button className="close-btn" type="button" onClick={() => setResultsOpen(false)} aria-label="Return to generation UI">×</button>
            </div>
          </div>
          <div className="results-page-body">
            {latestResultId && results.length > 0 && (() => {
  const latestResult = results.find((item) => item.id === latestResultId)
  return latestResult ? (
    <section className="latest-result">
      <div className={`completed-image-tap-area completed-image-tap-${completedTapState}${completedImageVisible ? '' : ' completed-image-tap-hidden'}`}>
        {completedImageVisible ? (
          <img
            src={latestResult.url}
            alt="Generated result"
            loading="lazy"
            draggable={false}
            onClick={handleCompletedImageTap}
            onContextMenu={(event) => event.preventDefault()}
            onLoad={(event) => {
              const width = event.currentTarget.naturalWidth
              const height = event.currentTarget.naturalHeight
              if (width && height && (latestResult.width !== width || latestResult.height !== height)) {
                setResults((prev) => prev.map((item) => item.id === latestResult.id ? { ...item, width, height } : item))
              }
            }}
          />
        ) : (
          <svg className="completed-image-placeholder" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="5" width="18" height="14" rx="2"/>
            <circle cx="8.5" cy="10" r="1.3"/>
            <path d="M4.5 17l5-5 3.5 3.5 2.5-2.5 4 4"/>
          </svg>
        )}
      </div>
      <div className="latest-result-info">
        <span>Dimension <b>{latestResult.width && latestResult.height ? `${latestResult.width} × ${latestResult.height}px` : 'Loading…'}</b></span>
        <span>CFG <b>{latestResult.cfg ?? '—'}</b></span>
        <span>Steps <b>{latestResult.steps ?? '—'}</b></span>
        <span>Megapixels <b>{latestResult.megapixels ?? '—'}</b></span>
      </div>
      <div className="use-generated-wrap">
        <span className="use-generated-label">Use generated image as</span>
        <div className="use-generated-actions">
          <button type="button" onClick={() => void useGeneratedAsFigure(latestResult, 'one')} disabled={isBusy || isUploading}>Figure A</button>
          <button type="button" onClick={() => void useGeneratedAsFigure(latestResult, 'two')} disabled={isBusy || isUploading}>Figure B</button>
        </div>
      </div>
    </section>
  ) : null
})()}
            {!latestResultId || !results.length ? <div className="results-empty">No completed generations yet.</div> : null}
          </div>
        </section>
      )}

      {completedPromptId && (() => {
        const completed = results.find((item) => item.id === completedPromptId)
        if (!completed) return null
        return (
          <div className="completed-prompt-backdrop" onClick={() => setCompletedPromptId(null)}>
            <section className="completed-prompt-embed" onClick={(event) => event.stopPropagation()}>
              <div className="completed-prompt-header">
                <div><h2>Generation Prompt</h2><span>Prompt saved with this image</span></div>
                <button className="close-btn" type="button" onClick={() => setCompletedPromptId(null)} aria-label="Close generation prompt">×</button>
              </div>
              <div className="completed-prompt-body">
                <div className="completed-prompt-text">{completed.prompt || 'Prompt not saved for this generation.'}</div>
                <div className="completed-prompt-actions">
                  <button type="button" onClick={() => {
                    if (completed.prompt) setPrompt((current: string) => addImagePrompt(current, completed.prompt!))
                    setCompletedPromptId(null)
                  }} disabled={!completed.prompt}>Send to main prompt</button>
                  <button type="button" className="danger" onClick={() => {
                    if (completed.prompt) setPrompt((current: string) => removeImagePrompt(current, completed.prompt!))
                    setCompletedPromptId(null)
                  }} disabled={!completed.prompt}>Remove from main prompt</button>
                </div>
              </div>
            </section>
          </div>
        )
      })()}

      {selectedPromptLabelId && (() => {
        const label = promptLabels.find((x) => x.id === selectedPromptLabelId)
        if (!label) return null
        return <div className="prompt-label-viewer-backdrop" onClick={() => setSelectedPromptLabelId(null)}>
          <section className="prompt-label-viewer" onClick={(e) => e.stopPropagation()}>
            <div className="prompt-label-viewer-header"><div><h2>{label.name}</h2><span>Prompt Label</span></div><button className="close-btn" type="button" onClick={() => setSelectedPromptLabelId(null)}>×</button></div>
            <div className="prompt-label-viewer-body"><div className="prompt-label-text">{label.text}</div><div className="prompt-label-viewer-actions"><button className="prompt-label-send" type="button" onClick={() => { sendPromptLabelToPrompt(label.id); setSelectedPromptLabelId(null); setIdeasOpen(false) }}>Send to Prompt</button><button className="prompt-label-remove" type="button" onClick={() => { removePromptLabelFromPrompt(label.id); setSelectedPromptLabelId(null); setIdeasOpen(false) }}>Remove</button></div></div>
          </section>
        </div>
      })()}

      {editingPromptLabel && <div className="prompt-label-editor-backdrop" onClick={() => setEditingPromptLabel(null)}>
        <section className="prompt-label-editor" onClick={(e) => e.stopPropagation()}>
          <div className="prompt-label-editor-header"><h2>{editingPromptLabel.id ? 'Edit Prompt Label' : 'New Prompt Label'}</h2><button className="close-btn" type="button" onClick={() => setEditingPromptLabel(null)}>×</button></div>
          <label>Button name<input value={editingPromptLabel.name} onChange={(e) => setEditingPromptLabel((prev) => prev ? { ...prev, name: e.target.value } : prev)} placeholder="Example: Cinematic" autoFocus /></label>
          <label>Prompt text<textarea value={editingPromptLabel.text} onChange={(e) => setEditingPromptLabel((prev) => prev ? { ...prev, text: e.target.value } : prev)} placeholder="Enter the prompt text for this label..." rows={8} /></label>
          <div className="prompt-label-editor-actions">
            {editingPromptLabel.id && <button type="button" className="prompt-label-delete-editor" onClick={() => { deletePromptLabel(editingPromptLabel.id!); setEditingPromptLabel(null) }}>Delete</button>}
            <button type="button" onClick={() => setEditingPromptLabel(null)}>Cancel</button>
            <button type="button" className="primary" onClick={savePromptLabel} disabled={!editingPromptLabel.text.trim()}>Save</button>
          </div>
        </section>
      </div>}

      {indexedDbInspectorOpen && <IndexedDbInspector onClose={() => { setIndexedDbInspectorOpen(false); setMainFooterVisible(true) }} inspect={inspectIndexedDb} inspectKeys={inspectIndexedDbKeys} inspectRecord={inspectIndexedDbRecord} permanentlyDelete={permanentlyDeleteIndexedDbStore} />}

      {historyOpen && <div className="history-backdrop" onClick={() => setHistoryOpen(false)}>
        <section className="history-panel" onClick={(e) => e.stopPropagation()}>
          <div className="history-header">
            <div className="history-header-title">
              <h2>{historySection === 'history' ? 'History' : 'Recycle Bin'}</h2>
              <span>{historySection === 'history' ? `${results.length} generation${results.length === 1 ? '' : 's'}` : `${trash.length} deleted generation${trash.length === 1 ? '' : 's'}`}</span>
            </div>
            <div className="history-header-controls">
              <button type="button" className={`history-mode-icon${historySection === 'history' ? ' active' : ''}`} onClick={() => { setHistorySection('history'); setHistoryPage(1) }} aria-label="History" title="History">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4.5A2.5 2.5 0 0 1 8.5 2H20v17.5A2.5 2.5 0 0 0 17.5 17H6z"/><path d="M6 4.5v15A2.5 2.5 0 0 0 8.5 22H20"/><path d="M10 6h7M10 10h7"/></svg>
              </button>
              <button type="button" className={`history-mode-icon${historySection === 'trash' ? ' active trash' : ''}`} onClick={() => { setHistorySection('trash'); setHistoryPage(1) }} aria-label={`Recycle Bin${trash.length ? ` (${trash.length})` : ''}`} title={`Recycle Bin${trash.length ? ` (${trash.length})` : ''}`}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>
                {trash.length > 0 && <span>{trash.length}</span>}
              </button>
              {historySection === 'history' && (
                <>
                  <input ref={historyImportInputRef} type="file" accept=".json,application/json" hidden onChange={(e) => { void importHistoryItem(e.target.files?.[0]); e.currentTarget.value = '' }} />
                  <button type="button" className="history-import-btn" onClick={() => historyImportInputRef.current?.click()} aria-label="Import History JSON" title="Import History JSON">Import</button>
                </>
              )}
              {historySection === 'trash' && trash.length > 0 && <button type="button" className="history-delete-all-btn" onClick={deleteAllTrash}>Delete All</button>}
              <span className="history-page-indicator">{historySection === 'history' ? `Page ${safeHistoryPage} of ${historyPageCount}` : `Page ${safeHistoryPage} of ${trashPageCount}`}</span>
              <button className="history-close-btn" type="button" onClick={() => setHistoryOpen(false)} aria-label="Close history">×</button>
            </div>
          </div>
          {activeItems.length ? <div className="history-list history-grid">
            {activeItems.map((img, i) => <HistoryItem
              key={img.id}
              img={img}
              index={(safeHistoryPage - 1) * HISTORY_PAGE_SIZE + i}
              section={historySection}
              onRestore={() => restoreFromTrash(img.id)}
              onPermanentDelete={() => permanentlyDelete(img.id)}
              onTrash={() => moveToTrash(img.id)}
              onPromptChange={(prompt) => updateHistoryPrompt(img.id, prompt)}
            />)}
          </div> : <div className="history-empty">{historySection === 'history' ? 'No generations in history.' : 'Recycle Bin is empty.'}</div>}
          {activePageCount > 1 && <div className="history-pagination">
            <button type="button" onClick={() => setHistoryPage((p) => Math.max(1, p - 1))} disabled={safeHistoryPage <= 1}>Previous</button>
            <span>{safeHistoryPage} / {activePageCount}</span>
            <button type="button" onClick={() => setHistoryPage((p) => Math.min(activePageCount, p + 1))} disabled={safeHistoryPage >= activePageCount}>Next</button>
          </div>}
        </section>
      </div>}

      </main>
    )}
    <footer className={`app-footer${footerExpanded ? ' footer-expanded' : ''}${!mainFooterVisible || logsOpen || resultsOpen || ideasOpen || settingsOpen || promptBuilderPageOpen || masterPromptsPageOpen || promptExpanded || datasetOpen || promptVaultOpen || galleryOpen ? ' app-footer-hidden' : ''}`} aria-label="ComfyUI navigation">
      <div className="footer-dock">
        <button
          className={`footer-menu-toggle ${footerExpanded ? 'expanded' : 'collapsed'}`}
          type="button"
          onClick={() => setFooterExpanded((current: boolean) => !current)}
          aria-expanded={footerExpanded}
          aria-label={footerExpanded ? 'Collapse footer menu' : 'Expand footer menu'}
          title={footerExpanded ? 'Collapse footer menu' : 'Expand footer menu'}
        >
          <span className="footer-menu-chevron" aria-hidden="true" />
        </button>
        <div className="footer-actions">
        <button
          className={'footer-power-btn ' + comfyPowerState}
          type="button"
          onClick={async () => {
            if (comfyPowerState !== 'off') return
            setComfyPowerState('starting')
            setPowerProgress(8)
            const timer = window.setInterval(() => setPowerProgress((value) => Math.min(90, value + 7)), 1000)
            try {
              await startComfyFromPhone()
              window.clearInterval(timer)
              setPowerProgress(100)
              setComfyPowerState('active')
            } catch (error) {
              window.clearInterval(timer)
              setPowerProgress(0)
              setComfyPowerState('off')
              recordErrorLog(error)
            }
          }}
          disabled={comfyPowerState !== 'off'}
          aria-label={comfyPowerState === 'active' ? 'ComfyUI active' : comfyPowerState === 'starting' ? 'ComfyUI starting' : 'Start ComfyUI'}
          title={comfyPowerState === 'active' ? 'ComfyUI active' : comfyPowerState === 'starting' ? 'ComfyUI starting ' + powerProgress + '%' : 'Start ComfyUI'}
          style={{ '--power-progress': powerProgress + '%' } as React.CSSProperties}
        >
          <span className="power-progress-ring" aria-hidden="true" />
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2v10" />
            <path d="M6.5 5.8a8 8 0 1 0 11 0" />
          </svg>
          {comfyPowerState === 'starting' && <span className="power-progress-text">{powerProgress}%</span>}
        </button>

        <button
          className={`icon-btn footer-hook-icon${hookPromptsPageOpen ? ' active' : ''}`}
          type="button"
          onClick={() => { setHookPromptsPageOpen(true); setFooterExpanded(false) }}
          aria-label="Open Hook Prompts"
          title="Hook Prompts"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14l-1.5 4.5a5 5 0 0 1-11 0L5 8Z"/><path d="M8 8 9.5 5h5L16 8M7 17l-1 3h12l-1-3"/><path d="M12 11v4"/></svg>
        </button>
        <button
          className={`icon-btn footer-menu-icon${promptHeaderMenuOpen ? ' active' : ''}`}
          type="button"
          onClick={() => { setPromptHeaderMenuOpen((open) => !open); setFooterExpanded(false) }}
          aria-label="Open prompt menu"
          aria-expanded={promptHeaderMenuOpen}
          title="Prompt menu"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
        </button>
        <button className="icon-btn history-icon" type="button" onClick={openHistory} aria-label="Open history" title="History">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4.5A2.5 2.5 0 0 1 8.5 2H20v17.5A2.5 2.5 0 0 0 17.5 17H6z"/><path d="M6 4.5v15A2.5 2.5 0 0 0 8.5 22H20"/><path d="M10 6h7M10 10h7"/></svg>
        </button>
        <button className="icon-btn dataset-icon" type="button" onClick={() => { setDatasetOpen(true); setFooterExpanded(false) }} aria-label="Open datasets" title="Datasets">
          <svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5"/><path d="M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7"/></svg>
        </button>
        <button className="icon-btn logs-icon" type="button" onClick={() => setLogsOpen(true)} aria-label="Open launcher logs" title="Launcher logs">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>
        </button>
        <button className="icon-btn settings-icon" type="button" onClick={() => setSettingsOpen(true)} aria-label="Open settings" title="Settings">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.25a3.75 3.75 0 1 0 0 7.5 3.75 3.75 0 0 0 0-7.5Z"/><path d="m19.4 15 .1.06a1.8 1.8 0 0 1-2.47 2.47l-.06-.1a1.8 1.8 0 0 0-3.1 1.04l-.01.12a1.8 1.8 0 0 1-3.6 0l-.01-.12a1.8 1.8 0 0 0-3.1-1.04l-.06.1a1.8 1.8 0 0 1-2.47-2.47l.1-.06a1.8 1.8 0 0 0-1.04-3.1l-.12-.01a1.8 1.8 0 0 1 0-3.6l.12-.01a1.8 1.8 0 0 0 1.04-3.1l-.1-.06A1.8 1.8 0 0 1 7.09 2.65l.06.1a1.8 1.8 0 0 0 3.1-1.04l.01-.12a1.8 1.8 0 0 1 3.6 0l.01.12a1.8 1.8 0 0 0 3.1 1.04l.06-.1a1.8 1.8 0 0 1 2.47 2.47l-.1.06a1.8 1.8 0 0 0 1.04 3.1l.12.01a1.8 1.8 0 0 1 0 3.6l-.12.01A1.8 1.8 0 0 0 19.4 15Z"/></svg>
        </button>
        <button className="icon-btn gallery-icon" type="button" onClick={() => { setGalleryOpen(true); setFooterExpanded(false) }} aria-label="Open image gallery" title="Image Gallery">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="9" cy="9" r="1.5"/><path d="m5 17 4-4 3 3 2-2 5 4"/></svg>
        </button>

        </div>
        <button
          className="icon-btn indexeddb-inspector-btn"
          type="button"
          onClick={() => { setIndexedDbInspectorOpen(true); setFooterExpanded(false); setMainFooterVisible(false) }}
          aria-label="Open IndexedDB Inspector"
          title="IndexedDB Inspector"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4z"/><path d="M8 9h8M8 12h8M8 15h5"/></svg>
        </button>
        <div className="app-version">ComfyUI PWA {APP_VERSION}</div>
      </div>
    </footer>
  </div>
}

function HistoryItem({ img, index, section, onRestore, onPermanentDelete, onTrash, onPromptChange }: {
  img: ResultImage
  index: number
  section: 'history' | 'trash'
  onRestore: () => void
  onPermanentDelete: () => void
  onTrash: () => void
  onPromptChange: (prompt: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [prompt, setPrompt] = useState(img.prompt || '')
  const [promptOpen, setPromptOpen] = useState(false)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    setPrompt(img.prompt || '')
  }, [img.prompt])

  async function exportHistoryItem() {
    if (exporting) return
    setExporting(true)
    try {
      const response = await fetch(img.url)
      if (!response.ok) throw new Error('Could not load the history image.')
      const blob = await response.blob()

      const imageData = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          if (typeof reader.result === 'string') resolve(reader.result)
          else reject(new Error('Could not convert the image.'))
        }
        reader.onerror = () => reject(reader.error || new Error('Could not read the image.'))
        reader.readAsDataURL(blob)
      })

      const extension = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg'
      const safeName = (img.id || 'history-image').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'history-image'
      const payload = {
        format: 'comfyui-pwa-history-image',
        version: 1,
        exportedAt: new Date().toISOString(),
        image: {
          filename: safeName + '.' + extension,
          mimeType: blob.type || 'image/jpeg',
          data: imageData,
        },
        prompt: prompt || '',
        metadata: {
          id: img.id,
          createdAt: img.createdAt || null,
          promptId: img.promptId || null,
        },
      }

      const file = new File(
        [JSON.stringify(payload, null, 2)],
        safeName + '.json',
        { type: 'application/json' }
      )

      if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
        await navigator.share({
          title: safeName,
          text: 'ComfyUI PWA image and prompt',
          files: [file],
        })
      } else {
        const url = URL.createObjectURL(file)
        const link = document.createElement('a')
        link.href = url
        link.download = file.name
        document.body.appendChild(link)
        link.click()
        link.remove()
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      window.alert(error instanceof Error ? error.message : 'Could not export this history item.')
    } finally {
      setExporting(false)
    }
  }

  const handleCardTap = () => {
    setExpanded((current) => !current)
    if (navigator.vibrate) navigator.vibrate(12)
  }

  return <article
    className={`history-item${expanded ? ' history-item-expanded' : ''}`}
    onClick={handleCardTap}
    onContextMenu={(e) => e.preventDefault()}
    aria-label={`${section === 'history' ? `Generation ${index + 1}` : 'Deleted generation'}${expanded ? '. Expanded.' : '. Tap to expand.'}`}
  >
    <img src={img.url} alt={`Generated result ${index + 1}`} loading="lazy" draggable={false} />
    <div className="history-details">
      <div className="history-meta">{section === 'history' ? `Generation ${index + 1}` : 'Deleted generation'}</div>
      {!expanded && <div className="history-prompt"><p>{img.prompt || 'Prompt not saved for this generation.'}</p></div>}
      {expanded && <div className="history-expanded-content" onClick={(e) => e.stopPropagation()}>
        <label htmlFor={`history-prompt-${img.id}`}>Prompt</label>
        <textarea
          id={`history-prompt-${img.id}`}
          value={prompt}
          onChange={(e) => {
            const next = e.target.value
            setPrompt(next)
            onPromptChange(next)
          }}
          placeholder="No prompt was saved for this generation."
          rows={7}
          onClick={(e) => {
            e.stopPropagation()
            setPromptOpen(true)
          }}
          readOnly
        />
        <div className="history-expanded-actions">
          {section === 'history' && (
            <button className="history-export-btn" type="button" onClick={(e) => { e.stopPropagation(); void exportHistoryItem() }} disabled={exporting}>
              {exporting ? 'Preparing…' : 'Export JSON'}
            </button>
          )}
          {section === 'history'
            ? <button className="history-delete-btn" type="button" onClick={(e) => { e.stopPropagation(); onTrash() }}>Trash</button>
            : <>
                <button className="history-restore-btn" type="button" onClick={(e) => { e.stopPropagation(); onRestore() }}>Restore</button>
                <button className="history-delete-btn permanent" type="button" onClick={(e) => { e.stopPropagation(); onPermanentDelete() }}>Delete Permanently</button>
              </>}
        </div>
      </div>}
    </div>
    {promptOpen && createPortal(
      <div className="history-prompt-page-backdrop" onClick={() => setPromptOpen(false)}>
        <section className="history-prompt-page" onClick={(e) => e.stopPropagation()}>
          <header className="history-prompt-page-header">
            <div>
              <h2>Edit Prompt</h2>
              <span>{section === 'history' ? `Generation ${index + 1}` : 'Deleted generation'}</span>
            </div>
            <button type="button" className="close-btn" onClick={() => setPromptOpen(false)} aria-label="Close prompt editor">×</button>
          </header>
          <div className="history-prompt-page-body">
            <textarea
              autoFocus
              value={prompt}
              onChange={(e) => {
                const next = e.target.value
                setPrompt(next)
                onPromptChange(next)
              }}
              placeholder="No prompt was saved for this generation."
              aria-label="Edit generation prompt"
            />
            <div className="history-prompt-page-actions">
              <button
                type="button"
                className="history-send-main-prompt"
                disabled={!prompt.trim()}
                onClick={() => {
                  const confirmed = window.confirm('Send this entire prompt to the Main Prompt box? This will only replace the Main Prompt text and will not generate or send anything.')
                  if (!confirmed) return
                  setPrompt(prompt)
                  // Intentionally only updates the main prompt field.
                  window.dispatchEvent(new CustomEvent('history-send-to-main-prompt', { detail: prompt }))
                  setPromptOpen(false)
                }}
              >
                Send to Main Prompt
              </button>
            </div>
          </div>
        </section>
      </div>,
      document.body
    )}
  </article>
}
function PromptLabelButton({ label, index, armed, onPointerDown, onPointerUp, onTap }: { label: PromptLabel; index: number; armed: boolean; onPointerDown: () => void; onPointerUp: () => void; onTap: () => void }) {
  return <button type="button" className={`prompt-label-button${armed ? ' prompt-label-button-armed' : ''}`} onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onPointerLeave={onPointerUp} onClick={onTap} onContextMenu={(e) => e.preventDefault()}>
    <span className="prompt-label-order">{index + 1}</span><span className="prompt-label-name">{label.name}</span>
  </button>
}

function SettingNumber({ label, value, min, max, step, onChange, suffix }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; suffix?: string }) {
  const [text, setText] = useState(String(value))
  useEffect(() => { if (Number(text) !== value) setText(String(value)) }, [value])
  return <label className="setting"><span>{label}{suffix ? ` (${suffix})` : ''}</span><input type="number" value={text} min={min} max={max} step={step}
    onChange={(e) => { const next = e.target.value; setText(next); if (next !== '') { const n = Number(next); if (Number.isFinite(n)) onChange(n) } }}
    onBlur={() => { if (text === '') setText(String(value)) }} /></label>
}

function ImagePicker({ label, image, busy, disabled, glow, onChange, onClear }: { slot: string; label: string; image: CharacterImage | null; busy: boolean; disabled: boolean; glow: boolean; onChange: (file?: File) => void; onClear: () => void }) {
  return (
    <div className={`image-picker ${glow ? 'rgb-glow-active' : ''} ${busy ? 'rgb-glow-running' : ''}`}>
      <div className="image-picker-title"><span>{label}</span></div>
      <div className="image-picker-box-wrap">
        <label className="image-picker-box">
          {image ? <>
            <span className="image-picker-depth" aria-hidden="true" style={{ backgroundImage: `url("${image.previewUrl}")` }} />
            <img src={image.previewUrl} alt={`${label} preview`} />
          </> : <span className="image-upload-plus" aria-hidden="true">+</span>}
          <input type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled || busy} onChange={(e) => { onChange(e.target.files?.[0]); e.currentTarget.value = '' }} />
        </label>
        {image && <button className="image-clear-btn" type="button" onClick={onClear} disabled={disabled || busy} aria-label={`Clear ${label}`}>×</button>}
      </div>
      {image && <div className="image-picker-name">{image.fileName}</div>}
    </div>
  )
}

function IndexedDbInspector({
  onClose,
  inspect,
  inspectKeys,
  inspectRecord,
  permanentlyDelete,
}: {
  onClose: () => void
  inspect: () => Promise<Array<{ name: string; version: number; stores: Array<{ name: string; count: number; keyPath: string | string[] | null; autoIncrement: boolean }> }>>
  inspectKeys: (databaseName: string, storeName: string) => Promise<Array<{ key: string; rawKey: IDBValidKey }>>
  inspectRecord: (databaseName: string, storeName: string, key: IDBValidKey) => Promise<unknown>
  permanentlyDelete: (databaseName: string, storeName: string) => Promise<void>
}) {
  const [loading, setLoading] = useState(true)
  const [databases, setDatabases] = useState<Array<{ name: string; version: number; stores: Array<{ name: string; count: number; keyPath: string | string[] | null; autoIncrement: boolean }> }>>([])
  const [error, setError] = useState('')
  const [selectedStore, setSelectedStore] = useState<{ databaseName: string; storeName: string; count: number } | null>(null)
  const [storeKeys, setStoreKeys] = useState<Array<{ key: string; rawKey: IDBValidKey }>>([])
  const [recordsLoading, setRecordsLoading] = useState(false)
  const [recordsError, setRecordsError] = useState('')
  const [selectedRecord, setSelectedRecord] = useState<{ key: string; value: unknown } | null>(null)
  const [recordLoading, setRecordLoading] = useState(false)
  const [deletingStore, setDeletingStore] = useState(false)
  const [recordPreviewUrl, setRecordPreviewUrl] = useState<string | null>(null)

  useEffect(() => {
    return () => {
      if (recordPreviewUrl) URL.revokeObjectURL(recordPreviewUrl)
    }
  }, [recordPreviewUrl])

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      setDatabases(await inspect())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not inspect IndexedDB.')
    } finally {
      setLoading(false)
    }
  }

  async function permanentlyDeleteStore() {
    if (!selectedStore || deletingStore) return
    const label = `${selectedStore.databaseName} / ${selectedStore.storeName}`
    const confirmed = window.confirm(
      `PERMANENTLY DELETE ALL ${selectedStore.count} RECORDS?\n\nThis will remove every record in ${label} from IndexedDB. This cannot be undone.\n\nPress OK only if you are absolutely sure.`
    )
    if (!confirmed) return

    setDeletingStore(true)
    setRecordsError('')
    try {
      await permanentlyDelete(selectedStore.databaseName, selectedStore.storeName)
      if (recordPreviewUrl) {
        URL.revokeObjectURL(recordPreviewUrl)
        setRecordPreviewUrl(null)
      }
      setSelectedRecord(null)
      setStoreKeys([])
      setSelectedStore((current) => current ? { ...current, count: 0 } : null)
      await load()
    } catch (error) {
      setRecordsError(error instanceof Error ? error.message : `Could not permanently delete ${label}.`)
    } finally {
      setDeletingStore(false)
    }
  }

  async function openStore(databaseName: string, storeName: string, count: number) {
    setSelectedStore({ databaseName, storeName, count })
    setSelectedRecord(null)
    setRecordsLoading(true)
    setRecordsError('')
    try {
      setStoreKeys(await inspectKeys(databaseName, storeName))
    } catch (e) {
      setStoreKeys([])
      setRecordsError(e instanceof Error ? e.message : 'Could not read IndexedDB records.')
    } finally {
      setRecordsLoading(false)
    }
  }

  async function openRecord(key: { key: string; rawKey: IDBValidKey }) {
    if (!selectedStore) return
    if (recordPreviewUrl) {
      URL.revokeObjectURL(recordPreviewUrl)
      setRecordPreviewUrl(null)
    }
    setSelectedRecord({ key: key.key, value: null })
    setRecordLoading(true)
    try {
      const value = await inspectRecord(selectedStore.databaseName, selectedStore.storeName, key.rawKey)
      if (value instanceof Blob) {
        setRecordPreviewUrl(URL.createObjectURL(value))
      } else if (value instanceof ArrayBuffer) {
        setRecordPreviewUrl(URL.createObjectURL(new Blob([value])))
      }
      setSelectedRecord({ key: key.key, value })
    } catch (e) {
      setSelectedRecord({ key: key.key, value: { error: e instanceof Error ? e.message : 'Could not read record.' } })
    } finally {
      setRecordLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const isImageRecord = selectedStore?.storeName.toLowerCase().includes('imagedata') || selectedStore?.storeName.toLowerCase().includes('image')

  return <div className="indexeddb-inspector-backdrop" onClick={onClose}>
    <section className="indexeddb-inspector" onClick={(e) => e.stopPropagation()}>
      <header className="indexeddb-inspector-header">
        <div>
          <h2>IndexedDB Inspector</h2>
          <span>Browser storage view</span>
        </div>
        <div className="indexeddb-inspector-actions">
          <button type="button" onClick={() => void load()} disabled={loading}>{loading ? 'Reading…' : 'Refresh'}</button>
          <button type="button" onClick={onClose} aria-label="Close">×</button>
        </div>
      </header>

      <div className="indexeddb-inspector-body">
        {selectedStore ? (
          <>
            <div className="indexeddb-records-header">
              <button type="button" className="indexeddb-back-btn" onClick={() => {
                if (recordPreviewUrl) { URL.revokeObjectURL(recordPreviewUrl); setRecordPreviewUrl(null) }
                setSelectedStore(null); setStoreKeys([]); setSelectedRecord(null)
              }}>← Databases</button>
              <div>
                <strong>{selectedStore.databaseName}</strong>
                <span>{selectedStore.storeName} · {selectedStore.count} record{selectedStore.count === 1 ? '' : 's'}</span>
              </div>
            </div>

            {selectedRecord ? (
              <div className="indexeddb-record-detail">
                <button type="button" className="indexeddb-back-btn" onClick={() => {
                  if (recordPreviewUrl) { URL.revokeObjectURL(recordPreviewUrl); setRecordPreviewUrl(null) }
                  setSelectedRecord(null)
                }}>← Records</button>
                <div className="indexeddb-record-title">{selectedRecord.key}</div>
                {recordLoading ? <div className="indexeddb-inspector-empty">Reading record…</div> : (() => {
                  const value = selectedRecord.value as { src?: unknown; data?: unknown; mimeType?: unknown } | null
                  const src = typeof value?.src === 'string'
                    ? value.src
                    : typeof value?.data === 'string' && value.data.startsWith('data:image/')
                      ? value.data
                      : recordPreviewUrl
                  const blob = value instanceof Blob ? value : null
                  return src ? (
                    <div className="indexeddb-image-preview">
                      <img src={src} alt={selectedRecord.key} />
                      <div className="indexeddb-image-meta">
                        <span>Image data</span>
                        <small>{blob ? `${blob.type || 'image'} · ${Math.round(blob.size / 1024)} KB · Blob stored in IndexedDB` : 'Image source stored in IndexedDB'}</small>
                      </div>
                    </div>
                  ) : (
                    <pre className="indexeddb-record-json">{JSON.stringify(selectedRecord.value, null, 2)}</pre>
                  )
                })()}
              </div>
            ) : (
              <>
                <div className="indexeddb-store-danger">
              <button
                type="button"
                className="indexeddb-delete-all-btn"
                onClick={() => void permanentlyDeleteStore()}
                disabled={deletingStore || selectedStore.count === 0}
              >
                {deletingStore ? 'Permanently Deleting…' : 'Permanently Delete All'}
              </button>
              <span>This permanently removes every record in this category.</span>
            </div>

            <div className="indexeddb-records-note">{isImageRecord ? 'Tap an image record to view the image stored inside IndexedDB.' : 'Tap a record to inspect its contents.'}</div>
                {recordsLoading ? <div className="indexeddb-inspector-empty">Reading records…</div> : recordsError ? <div className="indexeddb-inspector-error">{recordsError}</div> : storeKeys.length ? (
                  <div className="indexeddb-record-list">
                    {storeKeys.map((record) => (
                      <button type="button" className="indexeddb-record-row" key={record.key} onClick={() => void openRecord(record)}>
                        {isImageRecord ? <span className="indexeddb-record-thumb"><span>IMG</span></span> : <span className="indexeddb-record-generic">DB</span>}
                        <span className="indexeddb-record-key">{record.key}</span>
                        <span className="indexeddb-record-chevron">›</span>
                      </button>
                    ))}
                  </div>
                ) : <div className="indexeddb-inspector-empty">This object store is empty.</div>}
              </>
            )}
          </>
        ) : (
          loading ? <div className="indexeddb-inspector-empty">Reading IndexedDB…</div> : error ? <div className="indexeddb-inspector-error">{error}</div> : databases.length ? databases.map((db) => <article className="indexeddb-db" key={db.name}>
            <div className="indexeddb-db-title"><strong>{db.name}</strong><span>Version {db.version}</span></div>
            {db.stores.length ? <div className="indexeddb-store-list">{db.stores.map((store) => (
              <button type="button" className="indexeddb-store indexeddb-store-button" key={store.name} onClick={() => void openStore(db.name, store.name, store.count)}>
                <span>{store.name}</span><b>{store.count < 0 ? '—' : store.count}</b><i>›</i>
              </button>
            ))}</div> : <div className="indexeddb-no-stores">No object stores.</div>}
          </article>) : <div className="indexeddb-inspector-empty">No IndexedDB databases were found.</div>
        )}
      </div>
    </section>
  </div>
}
