import { useEffect, useRef, useState } from 'react'
import { connectProgress, getHistory, queuePrompt, uploadImage, viewImageUrl, interruptGeneration, getLauncherStatus, getLauncherLogs, getRemoteControlStatus, startComfyUI, waitForComfyReady, freeComfyMemory, getComfySystemStats, startComfyFromPhone } from './comfyClient'
import { buildWorkflow } from './workflowTemplate'
import { cacheImage, getCachedImage, deleteCachedImage, cacheFile, getCachedFile } from './imageCache'
import './App.css'

type Status = 'idle' | 'queued' | 'running' | 'done' | 'error' | 'cancelling'
interface ResultImage { id: string; url: string; promptId: string; prompt?: string; negativePrompt?: string; cfg?: number; steps?: number; megapixels?: number; width?: number; height?: number; createdAt?: number }
const HISTORY_PAGE_SIZE = 5
interface CharacterImage { previewUrl: string; comfyName?: string; fileName: string; cacheKey: string }
interface PromptLabel { id: string; name: string; text: string; createdAt: number }

const ASPECT_RATIOS = ['1:1 (Square)', '4:3', '3:2', '16:9', '2:3', '3:4', '9:16', '21:9', '9:21']
const SCHEDULERS = ['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform', 'beta']
const SLEEP_TIMEOUT_SECONDS = 60

function imagePath(name: string, subfolder = '') { return subfolder ? `${subfolder}/${name}` : name }

const IMAGE_PROMPTS = {
  one: '<image_1> is identified as Figure A, subject from the source image',
  two: '<image_2> is identified as Figure B, subject from the source image',
}

function addImagePrompt(current: string, line: string) {
  if (current.includes(line)) return current
  return current.trim() ? `${current.trim()}\n${line}` : line
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
  const [prompt, setPrompt] = useState(() => {
    const nav = performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined
    const isReload = nav?.type === 'reload' || (nav?.type == null && performance.navigation?.type === 1)
    return isReload ? (saved.prompt ?? '') : ''
  })
  const [promptLabelBlock, setPromptLabelBlock] = useState('')
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
  const [exploreMode, setExploreMode] = useState(false)
  const [startingComfy, setStartingComfy] = useState(false)
  const [startProgress, setStartProgress] = useState(0)
  const [remoteStarting, setRemoteStarting] = useState(false)
  const [sleepSeconds, setSleepSeconds] = useState(saved.sleepSeconds ?? SLEEP_TIMEOUT_SECONDS)
  const [logsOpen, setLogsOpen] = useState(false)
  const [launcherLogs, setLauncherLogs] = useState<string[]>([])
  const [standbyLogs, setStandbyLogs] = useState<string[]>([])
  const [fadeImageGlow, setFadeImageGlow] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyView, setHistoryView] = useState<'grid' | 'list'>('grid')
  const [historyPage, setHistoryPage] = useState(1)
  const [historySection, setHistorySection] = useState<'history' | 'trash'>('history')
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null)
  const [trash, setTrash] = useState<ResultImage[]>(savedTrash)
  const currentGenerationPrompt = useRef<{ prompt: string; negativePrompt: string; cfg: number; steps: number; megapixels: number } | null>(null)
  const cleanupProgress = useRef<null | (() => void)>(null)
  const currentPromptId = useRef<string | null>(saved.promptId ?? null)
  const isBusy = status === 'queued' || status === 'running' || status === 'cancelling'
  if (currentPromptId.current && !currentGenerationPrompt.current) {
    currentGenerationPrompt.current = { prompt: saved.prompt ?? '', negativePrompt: saved.negativePrompt ?? '', cfg: saved.cfg ?? 2.5, steps: saved.steps ?? 30, megapixels: saved.megapixels ?? 0.5 }
  }

  const [imageOne, setImageOne] = useState<CharacterImage | null>(() => null)
  const [imageTwo, setImageTwo] = useState<CharacterImage | null>(() => null)

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
      prompt, promptLabelBlock, activePromptLabelIds, promptLabels, promptLabelTrash, negativePrompt, results, trash,
      imageOne: imageOne ? { ...imageOne, previewUrl: undefined } : null,
      imageTwo: imageTwo ? { ...imageTwo, previewUrl: undefined } : null,
      cfg, steps, scheduler, aspectRatio, megapixels, maxDimension, sleepSeconds,
      promptId: currentPromptId.current, progress,
    }))
    save()
  }, [prompt, promptLabelBlock, activePromptLabelIds, promptLabels, promptLabelTrash, negativePrompt, results, trash, imageOne, imageTwo, cfg, steps, scheduler, aspectRatio, megapixels, maxDimension, progress, status, sleepSeconds])

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
        if (remote.comfyui === 'running') {
          if (!isBusy && !startingComfy) setComfySleeping(false)
        } else {
          setComfySleeping(true)
        }
      } catch {
        if (!cancelled) setComfySleeping(true)
      }
    }

    // Check immediately on every page load/refresh, then keep the state current.
    void check()
    const timer = window.setInterval(check, 3000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [isBusy, startingComfy])

  useEffect(() => {
    if (isBusy || comfySleeping || startingComfy || sleepSeconds > 0) return
    // Standby: keep the ComfyUI server alive, but unload models and release
    // cached GPU memory so other software can use the VRAM.
    setComfySleeping(true)
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
            setSleepSeconds(0)
          })
      })
  }, [isBusy, comfySleeping, startingComfy, sleepSeconds])

  useEffect(() => {
    if (isBusy || comfySleeping || startingComfy) return
    const timer = window.setInterval(() => {
      setSleepSeconds((current: number) => Math.max(0, current - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [isBusy, comfySleeping, startingComfy])

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
      return true
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not use generated image')
      return false
    } finally {
      setUploading((p) => ({ ...p, [which]: false }))
    }
  }


  async function handleGenerate() {
    if (!prompt.trim() || uploading.one || uploading.two || startingComfy) return
    setLatestResultId(null)
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
      const workflow = buildWorkflow({
        prompt, negativePrompt: negativePrompt || undefined,
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

  function handleHistoryHold(id: string) {
    if (historySection === 'history') {
      if (window.confirm('Delete this generation? It will be moved to the Recycle Bin.')) moveToTrash(id)
    } else {
      if (window.confirm('Permanently delete this generation? This cannot be undone.')) permanentlyDelete(id)
    }
  }

  function updateHistoryPrompt(id: string, nextPrompt: string) {
    setResults((prev) => prev.map((item) => item.id === id ? { ...item, prompt: nextPrompt } : item))
    setTrash((prev) => prev.map((item) => item.id === id ? { ...item, prompt: nextPrompt } : item))
  }

  function copyHistoryPrompt(value: string) {
    void navigator.clipboard?.writeText(value)
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
    if (remoteStarting || startingComfy) return
    setRemoteStarting(true)
    setErrorMsg(null)
    setStartProgress(5)
    const timer = window.setInterval(() => {
      setStartProgress((current) => Math.min(90, current + 5))
    }, 1000)
    try {
      await startComfyFromPhone()
      window.clearInterval(timer)
      setStartProgress(100)
      setComfySleeping(false)
      setExploreMode(false)
      setSleepSeconds(SLEEP_TIMEOUT_SECONDS)
      setStatus('idle')
      await new Promise((resolve) => setTimeout(resolve, 250))
      // Return to the PWA we started from, not the raw ComfyUI interface.
      // Keep the current origin so this works on the production Vercel app.
      window.location.assign(window.location.origin)
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

  if (comfySleeping && !exploreMode) {
    return (
      <div className="sleep-screen">
        <div className="sleep-card">
          <div className="sleep-icon">⏸</div>
          <h1>ComfyUI is off</h1>
          <p>ComfyUI and its launcher are not running. Start them from your phone when you're ready.</p>
          {errorMsg && <p className="sleep-error">{errorMsg}</p>}
          <button type="button" className="resume-btn" onClick={() => void handleRemoteStart()} disabled={remoteStarting}>
            {remoteStarting ? `Starting ComfyUI… ${startProgress}%` : 'Start ComfyUI'}
          </button>
          <button type="button" className="resume-btn" onClick={() => setExploreMode(true)} disabled={remoteStarting}>
            Explore
          </button>
        </div>
      </div>
    )
  }

  return <div className="app">
    <header className="app-header">
      <div className="app-header-title"><h1>ComfyUI Console</h1><span className="status-dot" data-active={isBusy} /></div>
      <div className="header-subfooters">
        <div className="sleep-timer" aria-live="polite">
          {startingComfy ? <><span>Starting ComfyUI</span><div className="sleep-start-bar"><div style={{ width: startProgress + '%' }} /></div></> : comfySleeping ? <span>Standby</span> : sleepSeconds === 0 ? <span>Standby</span> : isBusy ? <><span>Sleep timer paused</span><strong>{Math.floor(sleepSeconds / 60)}:{String(sleepSeconds % 60).padStart(2, '0')}</strong></> : <><span>Sleep in</span><strong>{Math.floor(sleepSeconds / 60)}:{String(sleepSeconds % 60).padStart(2, '0')}</strong></>}
        </div>
        <div className={`vram-status ${isBusy || startingComfy ? 'active' : comfySleeping ? 'free' : 'active'}`} aria-live="polite">
          <span>{isBusy || startingComfy ? 'VRAM active' : comfySleeping ? 'VRAM free' : 'VRAM active'}</span>
        </div>
      </div>
      <div className="header-actions">
        <button className="icon-btn history-icon" type="button" onClick={openHistory} aria-label="Open history" title="History">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4.5A2.5 2.5 0 0 1 8.5 2H20v17.5A2.5 2.5 0 0 0 17.5 17H6z"/><path d="M6 4.5v15A2.5 2.5 0 0 0 8.5 22H20"/><path d="M10 6h7M10 10h7"/></svg>
        </button>
        <button className="icon-btn logs-icon" type="button" onClick={() => setLogsOpen(true)} aria-label="Open launcher logs" title="Launcher logs">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>
        </button>
        <button className="icon-btn settings-icon" type="button" onClick={() => setSettingsOpen(true)} aria-label="Open settings" title="Settings">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.25a3.75 3.75 0 1 0 0 7.5 3.75 3.75 0 0 0 0-7.5Z"/><path d="m19.4 15 .1.06a1.8 1.8 0 0 1-2.47 2.47l-.06-.1a1.8 1.8 0 0 0-3.1 1.04l-.01.12a1.8 1.8 0 0 1-3.6 0l-.01-.12a1.8 1.8 0 0 0-3.1-1.04l-.06.1a1.8 1.8 0 0 1-2.47-2.47l.1-.06a1.8 1.8 0 0 0-1.04-3.1l-.12-.01a1.8 1.8 0 0 1 0-3.6l.12-.01a1.8 1.8 0 0 0 1.04-3.1l-.1-.06A1.8 1.8 0 0 1 7.09 2.65l.06.1a1.8 1.8 0 0 0 3.1-1.04l.01-.12a1.8 1.8 0 0 1 3.6 0l.01.12a1.8 1.8 0 0 0 3.1 1.04l.06-.1a1.8 1.8 0 0 1 2.47 2.47l-.1.06a1.8 1.8 0 0 0 1.04 3.1l.12.01a1.8 1.8 0 0 1 0 3.6l-.12.01A1.8 1.8 0 0 0 19.4 15Z"/></svg>
        </button>
      </div>
    </header>

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
          <SettingNumber label="Max dimension" value={maxDimension} min={256} max={2048} step={32} onChange={setMaxDimension} suffix="px" />
        </section>
        <p className="settings-note">These controls change the matching values in your Qwen Image 2.1 workflow.</p>
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

    <main className="app-main">
      <section className="image-pickers">
        <ImagePicker glow={isBusy || fadeImageGlow} slot="image_1" label="Figure A" image={imageOne} busy={uploading.one} disabled={isBusy} onChange={(file) => void handleImageChange('one', file)} onClear={() => clearImage('one')} />
        <ImagePicker glow={isBusy || fadeImageGlow} slot="image_2" label="Figure B" image={imageTwo} busy={uploading.two} disabled={isBusy} onChange={(file) => void handleImageChange('two', file)} onClear={() => clearImage('two')} />
      </section>

      <section className="generation-embed">
        <div className="field"><label htmlFor="prompt">Prompt</label><textarea id="prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe what you want to generate..." rows={4} /></div>
        <div className="field"><label htmlFor="negative">Negative prompt (optional)</label><textarea id="negative" value={negativePrompt} onChange={(e) => setNegativePrompt(e.target.value)} placeholder="What to avoid..." rows={2} /></div>

        <div className="generation-actions">
          {isBusy ? (
            <button className="cancel-btn" onClick={() => void handleCancel()} disabled={cancelling}>
              {cancelling ? 'Cancelling...' : 'Stop Generation'}
            </button>
          ) : (
            <button className="generate-btn" onClick={handleGenerate} disabled={isUploading || !prompt.trim()}>
              {isUploading ? 'Uploading images...' : 'Generate'}
            </button>
          )}
          <button className="idea-btn" type="button" onClick={() => setIdeasOpen(true)} aria-label="Open ideas" title="Ideas">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 18h6"/>
              <path d="M10 21h4"/>
              <path d="M8.7 15.2C7.6 14.3 7 13 7 11.5A5 5 0 0 1 17 11.5c0 1.5-.6 2.8-1.7 3.7-.8.7-1.3 1.5-1.3 2.8h-4c0-1.3-.5-2.1-1.3-2.8Z"/>
              <path d="M12 2v2M4.9 4.9l1.4 1.4M2 12h2M19.1 4.9l-1.4 1.4M22 12h-2"/>
            </svg>
          </button>
        </div>
      </section>

      {isBusy && <div className="progress-wrap"><div className="progress-label"><span>Generation progress</span><strong>{percent}%</strong></div><div className="progress-bar"><div className="progress-fill" style={{ width: `${percent}%` }} /></div>{progress && <div className="progress-detail">Step {progress.value} of {progress.max}</div>}</div>}
      {status === 'cancelling' && <p className="cancel-text">Cancelling generation…</p>}
      {errorMsg && <p className="error-text">{errorMsg}</p>}
      {latestResultId && results.length > 0 && (() => {
        const latestResult = results.find((item) => item.id === latestResultId)
        return latestResult ? (
          <section className="latest-result">
            <img
              src={latestResult.url}
              alt="Generated result"
              loading="lazy"
              onLoad={(event) => {
                const width = event.currentTarget.naturalWidth
                const height = event.currentTarget.naturalHeight
                if (width && height && (latestResult.width !== width || latestResult.height !== height)) {
                  setResults((prev) => prev.map((item) => item.id === latestResult.id ? { ...item, width, height } : item))
                }
              }}
            />
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
              onHold={() => handleHistoryHold(img.id)}
              onOpen={() => setSelectedHistoryId(img.id)}
              onRestore={() => restoreFromTrash(img.id)}
              onPermanentDelete={() => permanentlyDelete(img.id)}
            />)}
          </div> : <div className="history-empty">{historySection === 'history' ? 'No generations in history.' : 'Recycle Bin is empty.'}</div>}
          {activePageCount > 1 && <div className="history-pagination">
            <button type="button" onClick={() => setHistoryPage((p) => Math.max(1, p - 1))} disabled={safeHistoryPage <= 1}>Previous</button>
            <span>{safeHistoryPage} / {activePageCount}</span>
            <button type="button" onClick={() => setHistoryPage((p) => Math.min(activePageCount, p + 1))} disabled={safeHistoryPage >= activePageCount}>Next</button>
          </div>}
        </section>
      </div>}

    {selectedHistoryId && (() => {
      const item = [...results, ...trash].find((x) => x.id === selectedHistoryId)
      if (!item) return null
      return <div className="history-viewer-backdrop" onClick={() => setSelectedHistoryId(null)}>
        <section className="history-viewer" onClick={(e) => e.stopPropagation()}>
          <div className="history-viewer-header">
            <div><h2>Generation</h2><span>{item.createdAt ? new Date(item.createdAt).toLocaleString() : ''}</span></div>
            <button className="close-btn" type="button" onClick={() => setSelectedHistoryId(null)}>×</button>
          </div>
          <div className="history-viewer-scroll">
            <img className="history-viewer-image" src={item.url} alt="Full generated result" />
            <div className="history-viewer-info">
              <label>Prompt</label>
              <textarea defaultValue={item.prompt || ''} placeholder="No prompt was saved for this generation." rows={6} id={`history-prompt-${item.id}`} />
              <div className="history-viewer-buttons">
                <button type="button" onClick={() => { const el = document.getElementById(`history-prompt-${item.id}`) as HTMLTextAreaElement | null; if (el) updateHistoryPrompt(item.id, el.value) }}>Save Prompt</button>
                <button type="button" onClick={() => { const el = document.getElementById(`history-prompt-${item.id}`) as HTMLTextAreaElement | null; if (el) copyHistoryPrompt(el.value) }}>Copy Prompt</button>
              </div>
              {item.negativePrompt && <><label>Negative Prompt</label><div className="history-viewer-text">{item.negativePrompt}</div></>}
              <div className="history-viewer-settings">
                <div><span>CFG</span><b>{item.cfg ?? '—'}</b></div>
                <div><span>Steps</span><b>{item.steps ?? '—'}</b></div>
                <div><span>Megapixels</span><b>{item.megapixels ?? '—'}</b></div>
              </div>
              <div className="history-use-generated">
                <label>Use this generated image as</label>
                <div>
                  <button type="button" onClick={() => void useGeneratedAsFigure(item, 'one').then((ok) => { if (ok) setSelectedHistoryId(null) })} disabled={isBusy || isUploading}>Figure A</button>
                  <button type="button" onClick={() => void useGeneratedAsFigure(item, 'two').then((ok) => { if (ok) setSelectedHistoryId(null) })} disabled={isBusy || isUploading}>Figure B</button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    })()}
    </main>
  </div>
}

function HistoryItem({ img, index, section, onHold, onOpen, onRestore, onPermanentDelete }: { img: ResultImage; index: number; section: 'history' | 'trash'; onHold: () => void; onOpen: () => void; onRestore: () => void; onPermanentDelete: () => void }) {
  const holdTimer = useRef<number | null>(null)
  const tapTimer = useRef<number | null>(null)
  const didHold = useRef(false)
  const [tapArmed, setTapArmed] = useState(false)

  const startHold = () => {
    didHold.current = false
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current)
    holdTimer.current = window.setTimeout(() => {
      didHold.current = true
      if (tapTimer.current !== null) { window.clearTimeout(tapTimer.current); tapTimer.current = null }
      setTapArmed(false)
      if (navigator.vibrate) navigator.vibrate(25)
      onHold()
    }, 650)
  }

  const endHold = () => {
    if (holdTimer.current !== null) { window.clearTimeout(holdTimer.current); holdTimer.current = null }
  }

  const handleTap = () => {
    if (didHold.current) return
    if (tapArmed) {
      if (tapTimer.current !== null) { window.clearTimeout(tapTimer.current); tapTimer.current = null }
      setTapArmed(false)
      onOpen()
      return
    }
    setTapArmed(true)
    if (tapTimer.current !== null) window.clearTimeout(tapTimer.current)
    tapTimer.current = window.setTimeout(() => {
      tapTimer.current = null
      setTapArmed(false)
    }, 700)
  }

  useEffect(() => () => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current)
    if (tapTimer.current !== null) window.clearTimeout(tapTimer.current)
  }, [])

  return <article className={`history-item${tapArmed ? ' history-item-tap-armed' : ''}`} onPointerDown={startHold} onPointerUp={endHold} onPointerCancel={endHold} onPointerLeave={endHold} onClick={handleTap} onContextMenu={(e) => e.preventDefault()}>
    <img src={img.url} alt={`Generated result ${index + 1}`} loading="lazy" draggable={false} />
    <div className="history-details">
      <div className="history-meta">{section === 'history' ? `Generation ${index + 1}` : 'Deleted generation'}</div>
      <div className="history-hold-hint">Tap and hold for options</div>
      <div className="history-prompt"><strong>Prompt</strong><p>{img.prompt || 'Prompt not saved for this generation.'}</p></div>
      {img.negativePrompt && <div className="history-prompt negative"><strong>Negative prompt</strong><p>{img.negativePrompt}</p></div>}
      <div className="history-settings"><span>CFG <b>{img.cfg ?? '—'}</b></span><span>Steps <b>{img.steps ?? '—'}</b></span><span>Megapixels <b>{img.megapixels ?? '—'}</b></span></div>
      {section === 'trash' && <div className="history-actions"><button className="history-restore-btn" type="button" onPointerDown={(e) => e.stopPropagation()} onClick={onRestore}>Restore</button><button className="history-delete-btn permanent" type="button" onPointerDown={(e) => e.stopPropagation()} onClick={onPermanentDelete}>Delete Permanently</button></div>}
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

