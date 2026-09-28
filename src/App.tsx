import { useEffect, useRef, useState } from 'react'
import { connectProgress, getHistory, queuePrompt, uploadImage, viewImageUrl, interruptGeneration, getLauncherStatus, getLauncherLogs, getRemoteControlStatus, startComfyUI, waitForComfyReady, freeComfyMemory, getComfySystemStats, startComfyFromPhone } from './comfyClient'
import { buildWorkflow } from './workflowTemplate'
import { cacheImage, getCachedImage, deleteCachedImage, cacheFile, getCachedFile } from './imageCache'
import './App.css'
import { DatasetPage } from './components/DatasetPage'

type Status = 'idle' | 'queued' | 'running' | 'done' | 'error' | 'cancelling'
interface ResultImage { id: string; url: string; promptId: string; prompt?: string; negativePrompt?: string; cfg?: number; steps?: number; megapixels?: number; width?: number; height?: number; createdAt?: number }
const HISTORY_PAGE_SIZE = 6
interface CharacterImage { previewUrl: string; comfyName?: string; fileName: string; cacheKey: string }
interface PromptLabel { id: string; name: string; text: string; createdAt: number }
interface MasterPrompt { id: string; name: string; text: string; enabled: boolean }

const ASPECT_RATIOS = ['1:1 (Square)', '4:3', '3:2', '16:9', '2:3', '3:4', '9:16', '21:9', '9:21']
const SCHEDULERS = ['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform', 'beta']
const SLEEP_TIMEOUT_SECONDS = 60
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
  const savedPromptLabelTrash = withLabelIds(Array.isArray(saved.promptLabelTrash) ? saved.promptLabelTrash : [])
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
  const [promptLabelBlock, setPromptLabelBlock] = useState('')
  const [promptBuilderOpen, setPromptBuilderOpen] = useState(() => saved.promptBuilderOpen ?? false)
  const [promptBuilderValues, setPromptBuilderValues] = useState<Record<string, string>>(() => saved.promptBuilderValues && typeof saved.promptBuilderValues === 'object' ? saved.promptBuilderValues : {})
  const [activePromptBuilderLabel, setActivePromptBuilderLabel] = useState<string | null>(null)
  const [disabledPromptBuilderLabels, setDisabledPromptBuilderLabels] = useState<string[]>(() => Array.isArray(saved.disabledPromptBuilderLabels) ? saved.disabledPromptBuilderLabels : [])
  const [promptBuilderPageOpen, setPromptBuilderPageOpen] = useState(false)
  const [promptExpanded, setPromptExpanded] = useState(false)
  const [promptHeaderMenuOpen, setPromptHeaderMenuOpen] = useState(false)
  const [promptBuilderLabels, setPromptBuilderLabels] = useState<string[]>(() => {
    if (Array.isArray(saved.promptBuilderLabels)) {
      return saved.promptBuilderLabels.filter((label: unknown): label is string => typeof label === 'string' && label.trim().length > 0)
    }
    return [...PROMPT_BUILDER_LABELS]
  })
  const [masterPrompts, setMasterPrompts] = useState<MasterPrompt[]>(savedMasterPrompts)
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
  const [uploading, setUploading] = useState({ one: false, two: false })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [ideasOpen, setIdeasOpen] = useState(false)
  const [resultsOpen, setResultsOpen] = useState(false)
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
  const [maxDimension, setMaxDimension] = useState(saved.maxDimension ?? 720)
  const [cancelling, setCancelling] = useState(false)
  // Start on the off screen until the phone-control endpoint confirms ComfyUI is running.
  // This makes a refresh immediately reflect a stopped laptop without waiting for a timer.
  const [comfySleeping, setComfySleeping] = useState(true)
  const [startingComfy, setStartingComfy] = useState(false)
  const [startProgress, setStartProgress] = useState(0)
  const [remoteStarting, setRemoteStarting] = useState(false)
  const [comfyPowerState, setComfyPowerState] = useState<'off' | 'idle' | 'active'>('off')
  const standbyReleased = useRef(false)
  const [sleepSeconds, setSleepSeconds] = useState(saved.sleepSeconds ?? SLEEP_TIMEOUT_SECONDS)
  const [sleepLocked, setSleepLocked] = useState(saved.sleepLocked ?? false)
  const [footerExpanded, setFooterExpanded] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [datasetOpen, setDatasetOpen] = useState(false)
  const [launcherLogs, setLauncherLogs] = useState<string[]>([])
  const [standbyLogs, setStandbyLogs] = useState<string[]>([])
  const [fadeImageGlow, setFadeImageGlow] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyView, setHistoryView] = useState<'grid' | 'list'>('grid')
  const [historyPage, setHistoryPage] = useState(1)
  const [historySection, setHistorySection] = useState<'history' | 'trash'>('history')
  const [trash, setTrash] = useState<ResultImage[]>(savedTrash)
  const currentGenerationPrompt = useRef<{ prompt: string; negativePrompt: string; cfg: number; steps: number; megapixels: number } | null>(null)
  const cleanupProgress = useRef<null | (() => void)>(null)
  const currentPromptId = useRef<string | null>(saved.promptId ?? null)
  const isBusy = status === 'queued' || status === 'running' || status === 'cancelling'
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
    void restoreSelectedImages()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const save = () => localStorage.setItem(STORAGE_KEY, JSON.stringify({
      prompt, promptLabelBlock, activePromptLabelIds, promptLabels, promptLabelTrash, promptBuilderOpen, promptBuilderValues, promptBuilderLabels, disabledPromptBuilderLabels, masterPrompts, negativePrompt, results, trash,
      imageOne: imageOne ? { ...imageOne, previewUrl: undefined } : null,
      imageTwo: imageTwo ? { ...imageTwo, previewUrl: undefined } : null,
      showImageTwo,
      cfg, steps, scheduler, aspectRatio, megapixels, maxDimension, sleepSeconds, sleepLocked,
      promptId: currentPromptId.current, progress,
    }))
    save()
  }, [prompt, promptLabelBlock, activePromptLabelIds, promptLabels, promptLabelTrash, promptBuilderOpen, promptBuilderValues, promptBuilderLabels, negativePrompt, results, trash, imageOne, imageTwo, showImageTwo, cfg, steps, scheduler, aspectRatio, megapixels, maxDimension, progress, status, sleepSeconds, sleepLocked])

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
    let cancelled = false
    const check = async () => {
      try {
        const remote = await getRemoteControlStatus()
        if (cancelled) return

        // The launcher/command prompt is the source of truth for the power state.
        // ComfyUI can remain reachable while its models are unloaded for standby.
        if (remote.launcher !== 'running') {
          setComfySleeping(true)
          setComfyPowerState('off')
          standbyReleased.current = false
        } else if (remoteStarting || startingComfy) {
          setComfyPowerState('idle')
        } else if (comfySleeping || remote.comfyui !== 'running') {
          setComfyPowerState('idle')
        } else {
          setComfyPowerState('active')
        }

      } catch {
        if (cancelled) return

        // Keep the current UI during transient network/Tailscale errors.
        // The main app stays visible and the Start ComfyUI button remains available.
      }
    }

    void check()
    const timer = window.setInterval(check, 3000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [isBusy, startingComfy])

  useEffect(() => {
    if (sleepLocked || isBusy || comfySleeping || startingComfy || sleepSeconds > 0 || standbyReleased.current) return
    // Standby: keep the ComfyUI server alive, but unload models and release
    // cached GPU memory so other software can use the VRAM.
    standbyReleased.current = true
    const stamp = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const addStandbyLog = (message: string) => setStandbyLogs((current) => [...current.slice(-49), `[${stamp()}] ${message}`])
    addStandbyLog('Standby: unloading ComfyUI models and releasing GPU memory...')
    void getComfySystemStats()
      .then((before) => {
        const device = before?.devices?.[0]
        if (device?.vram_used != null) addStandbyLog(`GPU memory before: ${Math.round(Number(device.vram_used) / 1048576)} MB`)
      })
      .catch(() => {})
      .finally(() => {
        void freeComfyMemory()
          .then(async () => {
            addStandbyLog('Standby: ComfyUI memory release request completed.')
            await new Promise((resolve) => setTimeout(resolve, 750))
            try {
              const after = await getComfySystemStats()
              const device = after?.devices?.[0]
              if (device?.vram_used != null) addStandbyLog(`GPU memory after: ${Math.round(Number(device.vram_used) / 1048576)} MB`)
            } catch {}
          })
          .catch((err) => addStandbyLog(`Standby: WARNING — memory release failed: ${err instanceof Error ? err.message : 'unknown error'}`))
          .finally(() => {
            // Remain in standby until the user starts another generation.
            // The server stays alive; only its models/VRAM are unloaded.
            setComfySleeping(true)
            setComfyPowerState('idle')
            setSleepSeconds(0)
          })
      })
  }, [isBusy, comfySleeping, startingComfy, sleepSeconds, sleepLocked])

  useEffect(() => {
    if (sleepLocked || isBusy || comfySleeping || startingComfy) return
    const timer = window.setInterval(() => {
      setSleepSeconds((current: number) => Math.max(0, current - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [isBusy, comfySleeping, startingComfy, sleepLocked])

  useEffect(() => {
    if (!logsOpen) return
    let cancelled = false
    const loadLogs = async () => {
      try {
        const logs = await getLauncherLogs()
        if (!cancelled) setLauncherLogs([...logs, ...standbyLogs])
      } catch {}
    }
    void loadLogs()
    const timer = window.setInterval(loadLogs, 1500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [logsOpen, standbyLogs])


  useEffect(() => {
    const locked = settingsOpen || historyOpen || ideasOpen || !!selectedPromptLabelId || !!editingPromptLabel
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
        setPrompt((current: string) => addImagePrompt(current, IMAGE_PROMPTS.one))
      } else {
        setImageTwo(value)
        setPrompt((current: string) => addImagePrompt(current, IMAGE_PROMPTS.two))
      }
    } catch (err) {
      URL.revokeObjectURL(previewUrl)
      setErrorMsg(err instanceof Error ? err.message : 'Could not upload image')
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
      setStatus('error'); setErrorMsg(err instanceof Error ? err.message : 'Failed to fetch result')
      cleanupProgress.current?.(); cleanupProgress.current = null
      return true
    }
  }

  async function waitForResult(promptId: string) {
    setStatus('running')
    cleanupProgress.current = connectProgress(promptId, (value, max) => setProgress({ value, max }))
    for (let i = 0; i < 180; i++) {
      if (await fetchResult(promptId)) return
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    cleanupProgress.current?.(); cleanupProgress.current = null
    setStatus('error'); setErrorMsg('Generation timed out. Check ComfyUI.')
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
        setPrompt((current: string) => addImagePrompt(current, IMAGE_PROMPTS.one))
      } else {
        setImageTwo(value)
        setPrompt((current: string) => addImagePrompt(current, IMAGE_PROMPTS.two))
      }
      setResultsOpen(false)
      return true
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not use generated image')
      return false
    } finally {
      setUploading((p) => ({ ...p, [which]: false }))
    }
  }


  async function handleGenerate() {
    const generationPrompt = promptBuilderOpen ? buildPromptBuilderPrompt() : prompt.trim()
    if (!generationPrompt || uploading.one || uploading.two || startingComfy) return
    setLatestResultId(null)
    standbyReleased.current = false
    setSleepSeconds(SLEEP_TIMEOUT_SECONDS)
    setErrorMsg(null); setStatus('queued'); setProgress({ value: 0, max: 1 })
    let startupTimer: number | null = null
    try {
      const launcher = await getLauncherStatus()
      // A running server with unloaded models is standby, not stopped.
      // Wake the app-side standby state without restarting ComfyUI.
      if (comfySleeping && launcher.comfyui !== 'stopped') {
        setComfySleeping(false)
      }
      if (launcher.comfyui === 'stopped') {
        setStartingComfy(true)
        setComfySleeping(false)
        setStartProgress(5)
        startupTimer = window.setInterval(() => {
          setStartProgress((current) => Math.min(90, current + 5))
        }, 1000)
        await startComfyUI()
        await waitForComfyReady()
        if (startupTimer !== null) window.clearInterval(startupTimer)
        setStartProgress(100)
        await new Promise((resolve) => setTimeout(resolve, 250))
        setStartingComfy(false)
      }
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
      })
      const { prompt_id } = await queuePrompt(workflow)
      currentPromptId.current = prompt_id
      setProgress({ value: 0, max: 1 })
      void waitForResult(prompt_id)
    } catch (err) {
      if (startupTimer !== null) window.clearInterval(startupTimer)
      setStartingComfy(false)
      setStatus('error'); setErrorMsg(err instanceof Error ? err.message : 'Could not reach ComfyUI.')
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
      setErrorMsg(err instanceof Error ? err.message : 'Could not stop generation.')
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

  async function handleRemoteStart() {
    if (remoteStarting || startingComfy || comfyPowerState !== 'off') return
    setRemoteStarting(true)
    setErrorMsg(null)
    setStartProgress(5)
    setComfyPowerState('idle')
    const timer = window.setInterval(() => {
      setStartProgress((current) => Math.min(90, current + 5))
    }, 1000)
    try {
      await startComfyFromPhone()
      window.clearInterval(timer)
      setStartProgress(100)
      standbyReleased.current = false
      setComfySleeping(false)
      setComfyPowerState('active')
      setSleepSeconds(SLEEP_TIMEOUT_SECONDS)
      setStatus('idle')
      await new Promise((resolve) => setTimeout(resolve, 250))
      // Return to the PWA we started from, not the raw ComfyUI interface.
      // Keep the current origin so this works on the production Vercel app.
      // Stay on the current PWA screen after startup.
    } catch (err) {
      window.clearInterval(timer)
      setErrorMsg(err instanceof Error ? err.message : 'Could not start ComfyUI from the phone.')
    } finally {
      setRemoteStarting(false)
    }
  }

  const historyPageCount = Math.max(1, Math.ceil(results.length / HISTORY_PAGE_SIZE))
  const trashPageCount = Math.max(1, Math.ceil(trash.length / HISTORY_PAGE_SIZE))
  const activePageCount = historySection === 'history' ? historyPageCount : trashPageCount
  const safeHistoryPage = Math.min(historyPage, activePageCount)
  const activeItems = historySection === 'history'
    ? results.slice((safeHistoryPage - 1) * HISTORY_PAGE_SIZE, safeHistoryPage * HISTORY_PAGE_SIZE)
    : trash.slice((safeHistoryPage - 1) * HISTORY_PAGE_SIZE, safeHistoryPage * HISTORY_PAGE_SIZE)

  return <div className="app">
    {logsOpen && <div className="logs-backdrop" onClick={() => setLogsOpen(false)}>
      <section className="logs-panel" onClick={(e) => e.stopPropagation()}>
        <div className="logs-header">
          <div><h2>Launcher Logs</h2><span>Live ComfyUI start/stop events</span></div>
          <button className="close-btn" type="button" onClick={() => setLogsOpen(false)} aria-label="Close logs">×</button>
        </div>
        <div className="logs-body">
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
        <p className="settings-note">Max dimension controls the longest side of the generated image and the Scale Image to Max Dimension nodes. Aspect ratio determines the other side.</p>
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

    {datasetOpen && (
      <DatasetPage
        onClose={() => setDatasetOpen(false)}
        sourceItems={results.map((item) => ({ id: item.id, prompt: item.prompt, url: item.url, createdAt: item.createdAt }))}
      />
    )}

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
                className={`prompt-menu-btn${promptHeaderMenuOpen ? ' active' : ''}`}
                onClick={() => setPromptHeaderMenuOpen((open) => !open)}
                aria-label="Open prompt options"
                aria-expanded={promptHeaderMenuOpen}
                title="Prompt options"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 7h16M4 12h16M4 17h16" />
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
              <textarea id="prompt" value={prompt} onFocus={() => setPromptExpanded(true)} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe what you want to generate..." rows={4} />
            </>
          )}</div>
        <div className="field"><label htmlFor="negative">Negative prompt (optional)</label><textarea id="negative" value={negativePrompt} onChange={(e) => setNegativePrompt(e.target.value)} placeholder="What to avoid..." rows={2} /></div>

        <div className="generation-actions">
          {isBusy ? (
            <button className="cancel-btn" onClick={() => void handleCancel()} disabled={cancelling}>
              {cancelling ? 'Cancelling...' : 'Stop Generation'}
            </button>
          ) : (
            <button className="generate-btn" onClick={handleGenerate} disabled={isUploading || !(promptBuilderOpen ? buildPromptBuilderPrompt().trim() : prompt.trim())}>
              {isUploading ? 'Uploading images...' : 'Generate'}
            </button>
          )}
          <button className="results-btn" type="button" onClick={() => setResultsOpen(true)} aria-label="Open completed generations" title="Completed generations">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="4" y="4" width="16" height="16" rx="2"/>
              <path d="M7.5 15.5l3-3 2.5 2.5 2-2 1.5 1.5"/>
              <circle cx="9" cy="9" r="1.2"/>
            </svg>
          </button>
        </div>
      <div className="footer-status" aria-label="ComfyUI status">
          <div className="sleep-timer footer-status-bubble" aria-live="polite">
            {startingComfy ? <><span>Starting ComfyUI</span><div className="sleep-start-bar"><div style={{ width: startProgress + '%' }} /></div></> : comfySleeping ? <span>{sleepLocked ? 'ComfyUI On' : 'Standby'}</span> : sleepSeconds === 0 ? <span>{sleepLocked ? 'ComfyUI On' : 'Standby'}</span> : isBusy ? <><span>Sleep timer paused</span><strong>{Math.floor(sleepSeconds / 60)}:{String(sleepSeconds % 60).padStart(2, '0')}</strong></> : <><span>Sleep in</span><strong>{Math.floor(sleepSeconds / 60)}:{String(sleepSeconds % 60).padStart(2, '0')}</strong></>}
          </div>
          <div className={`vram-status footer-status-bubble ${isBusy || startingComfy ? 'active' : comfySleeping ? 'free' : 'active'}`} aria-live="polite">
            <span>{isBusy || startingComfy ? 'VRAM active' : comfySleeping ? 'VRAM free' : 'VRAM active'}</span>
          </div>
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

      {historyOpen && <div className="history-backdrop" onClick={() => setHistoryOpen(false)}>
        <section className="history-panel" onClick={(e) => e.stopPropagation()}>
          <div className="history-header">
            <div><h2>{historySection === 'history' ? 'History' : 'Recycle Bin'}</h2><span>{historySection === 'history' ? `${results.length} generation${results.length === 1 ? '' : 's'}` : `${trash.length} deleted generation${trash.length === 1 ? '' : 's'}`}</span></div>
            <button className="close-btn" type="button" onClick={() => setHistoryOpen(false)} aria-label="Close history">×</button>
          </div>
          <div className="history-section-tabs">
            <button type="button" className={historySection === 'history' ? 'active' : ''} onClick={() => { setHistorySection('history'); setHistoryPage(1) }}>History</button>
            <button type="button" className={historySection === 'trash' ? 'active' : ''} onClick={() => { setHistorySection('trash'); setHistoryPage(1) }}>Recycle Bin{trash.length ? ` (${trash.length})` : ''}</button>
          </div>
          <div className="history-toolbar">
            <span>{historySection === 'history' ? `Page ${safeHistoryPage} of ${historyPageCount}` : `Page ${safeHistoryPage} of ${trashPageCount}`}</span>
            <div className="history-view-toggle">
              <button type="button" className={historyView === 'grid' ? 'active' : ''} onClick={() => setHistoryView('grid')}>Grid</button>
              <button type="button" className={historyView === 'list' ? 'active' : ''} onClick={() => setHistoryView('list')}>List</button>
            </div>
          </div>
          {activeItems.length ? <div className={`history-list history-${historyView}`}>
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
    <footer className={`app-footer${footerExpanded ? ' footer-expanded' : ''}${resultsOpen || ideasOpen || settingsOpen || promptBuilderPageOpen || masterPromptsPageOpen || promptExpanded || datasetOpen ? ' app-footer-hidden' : ''}`} aria-label="ComfyUI navigation">
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
          className={`icon-btn sleep-lock-btn ${sleepLocked ? 'locked' : 'unlocked'}`}
          type="button"
          onClick={() => setSleepLocked((current: boolean) => !current)}
          aria-pressed={sleepLocked}
          aria-label={sleepLocked ? 'Unlock auto sleep' : 'Lock auto sleep'}
          title={sleepLocked ? 'Unlock auto sleep' : 'Lock auto sleep'}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {sleepLocked
              ? <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>
              : <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 7.2-2.4" /></>}
          </svg>
        </button>
        <button
          className={`start-comfy-btn footer-power-btn ${startingComfy || remoteStarting ? 'starting' : comfyPowerState}`}
          type="button"
          onClick={() => void handleRemoteStart()}
          disabled={remoteStarting || startingComfy || comfyPowerState !== 'off'}
          aria-label={remoteStarting || startingComfy ? 'ComfyUI is starting' : comfyPowerState === 'active' ? 'ComfyUI active' : comfyPowerState === 'idle' ? 'ComfyUI standby' : 'Start ComfyUI'}
          title={remoteStarting || startingComfy ? `ComfyUI loading ${startProgress}%` : comfyPowerState === 'active' ? 'ComfyUI active' : comfyPowerState === 'idle' ? 'ComfyUI standby' : 'Start ComfyUI'}
          style={{ '--power-progress': `${startProgress}%` } as React.CSSProperties}
        >
          <span className="power-progress-ring" aria-hidden="true" />
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2v10" />
            <path d="M6.5 5.8a8 8 0 1 0 11 0" />
          </svg>
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
        </div>
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

  useEffect(() => {
    setPrompt(img.prompt || '')
  }, [img.prompt])

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
          onClick={(e) => e.stopPropagation()}
        />
        <div className="history-expanded-actions">
          {section === 'history'
            ? <button className="history-delete-btn" type="button" onClick={(e) => { e.stopPropagation(); onTrash() }}>Trash</button>
            : <>
                <button className="history-restore-btn" type="button" onClick={(e) => { e.stopPropagation(); onRestore() }}>Restore</button>
                <button className="history-delete-btn permanent" type="button" onClick={(e) => { e.stopPropagation(); onPermanentDelete() }}>Delete Permanently</button>
              </>}
        </div>
      </div>}
    </div>
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
          {image ? <img src={image.previewUrl} alt={`${label} preview`} /> : <span className="image-upload-plus" aria-hidden="true">+</span>}
          <input type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled || busy} onChange={(e) => { onChange(e.target.files?.[0]); e.currentTarget.value = '' }} />
        </label>
        {image && <button className="image-clear-btn" type="button" onClick={onClear} disabled={disabled || busy} aria-label={`Clear ${label}`}>×</button>}
      </div>
      {image && <div className="image-picker-name">{image.fileName}</div>}
    </div>
  )
}

