import { useEffect, useMemo, useRef, useState } from 'react'
import {
  connectProgress,
  getHistory,
  getRemoteControlStatus,
  interruptGeneration,
  queuePrompt,
  startComfyFromPhone,
  uploadImage,
  viewImageUrl,
} from './comfyClient'
import { buildWorkflow } from './workflowTemplate'
import './App.css'

type PowerState = 'off' | 'starting' | 'active' | 'idle'
type Panel = 'none' | 'history' | 'datasets' | 'logs' | 'settings'

type ImageSlot = {
  file: File
  preview: string
  comfyName?: string
  subfolder?: string
}

type HistoryItem = {
  id: string
  url: string
  prompt: string
  negativePrompt: string
  createdAt: number
  steps: number
  cfg: number
}

type DatasetCard = {
  id: string
  image: string
  prompt: string
  createdAt: number
}

const HISTORY_KEY = 'comfyui-pwa-history-v1'
const DATASET_DB = 'comfyui-pwa-datasets-v1'
const DATASET_STORE = 'cards'

const aspectRatios = ['1:1 (Square)', '4:3', '3:2', '16:9', '2:3', '3:4', '9:16', '21:9']
const schedulers = ['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform', 'beta']

function readHistory(): HistoryItem[] {
  try {
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function openDatasetDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATASET_DB, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(DATASET_STORE)) {
        db.createObjectStore(DATASET_STORE, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function readDatasetCards(): Promise<DatasetCard[]> {
  const db = await openDatasetDb()
  return new Promise((resolve, reject) => {
    const request = db.transaction(DATASET_STORE, 'readonly').objectStore(DATASET_STORE).getAll()
    request.onsuccess = () => {
      db.close()
      resolve((request.result as DatasetCard[]).sort((a, b) => b.createdAt - a.createdAt))
    }
    request.onerror = () => {
      db.close()
      reject(request.error)
    }
  })
}

async function writeDatasetCard(card: DatasetCard) {
  const db = await openDatasetDb()
  return new Promise<void>((resolve, reject) => {
    const request = db.transaction(DATASET_STORE, 'readwrite').objectStore(DATASET_STORE).put(card)
    request.onsuccess = () => { db.close(); resolve() }
    request.onerror = () => { db.close(); reject(request.error) }
  })
}

async function deleteDatasetCard(id: string) {
  const db = await openDatasetDb()
  return new Promise<void>((resolve, reject) => {
    const request = db.transaction(DATASET_STORE, 'readwrite').objectStore(DATASET_STORE).delete(id)
    request.onsuccess = () => { db.close(); resolve() }
    request.onerror = () => { db.close(); reject(request.error) }
  })
}

function makeId(prefix: string) {
  return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
}

function App() {
  const [panel, setPanel] = useState<Panel>('none')
  const [footerExpanded, setFooterExpanded] = useState(false)
  const [power, setPower] = useState<PowerState>('off')
  const [sleepLocked, setSleepLocked] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [negativePrompt, setNegativePrompt] = useState('avoid duplicated body parts, extra hands, extra arms, distorted body parts, extra fingers, blurriness, low quality, watermarks')
  const [cfg, setCfg] = useState(2.5)
  const [steps, setSteps] = useState(30)
  const [scheduler, setScheduler] = useState('normal')
  const [aspectRatio, setAspectRatio] = useState('1:1 (Square)')
  const [megapixels, setMegapixels] = useState(0.5)
  const [maxDimension, setMaxDimension] = useState(720)
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 900000000000000))
  const [imageA, setImageA] = useState<ImageSlot | null>(null)
  const [imageB, setImageB] = useState<ImageSlot | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ value: number; max: number } | null>(null)
  const [message, setMessage] = useState('Ready')
  const [history, setHistory] = useState<HistoryItem[]>(readHistory)
  const [datasets, setDatasets] = useState<DatasetCard[]>([])
  const [logs, setLogs] = useState<string[]>([])
  const [promptBuilderOpen, setPromptBuilderOpen] = useState(false)
  const [builderValues, setBuilderValues] = useState<Record<string, string>>({})
  const [editingDataset, setEditingDataset] = useState<DatasetCard | null>(null)
  const [datasetImportBusy, setDatasetImportBusy] = useState(false)
  const stopProgress = useRef<(() => void) | null>(null)

  const builderLabels = ['BODY EFFECTS', 'CLOTHING', 'HEAD ANGLE', 'LIPS', 'HAIR DETAILS', 'HANDS', 'EYES', 'CAMERA', 'POSTURE', 'BODY DIRECTION']

  const finalPrompt = useMemo(() => {
    const builder = builderLabels
      .map((label) => builderValues[label]?.trim() ? label + ': ' + builderValues[label].trim() : '')
      .filter(Boolean)
      .join('\n')
    return [prompt.trim(), builder].filter(Boolean).join('\n\n')
  }, [prompt, builderValues])

  useEffect(() => {
    void readDatasetCards().then(setDatasets).catch(() => setLogs((v) => [...v, 'IndexedDB is unavailable.']))
  }, [])

  useEffect(() => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 50)))
  }, [history])

  useEffect(() => () => {
    stopProgress.current?.()
    if (imageA) URL.revokeObjectURL(imageA.preview)
    if (imageB) URL.revokeObjectURL(imageB.preview)
  }, [])

  async function refreshPower() {
    try {
      const status = await getRemoteControlStatus()
      const state = status?.comfyui
      setPower(state === 'running' ? 'active' : state === 'starting' ? 'starting' : 'off')
    } catch {
      setPower('off')
    }
  }

  async function startComfy() {
    if (power !== 'off') return
    setPower('starting')
    setMessage('Starting ComfyUI…')
    try {
      await startComfyFromPhone()
      setPower('active')
      setMessage('ComfyUI ready')
    } catch (error) {
      setPower('off')
      setMessage(error instanceof Error ? error.message : 'Could not start ComfyUI')
    }
  }

  async function chooseImage(slot: 'A' | 'B', file?: File) {
    if (!file) return
    const preview = URL.createObjectURL(file)
    const uploaded = await uploadImage(file)
    const value: ImageSlot = { file, preview, comfyName: uploaded.name, subfolder: uploaded.subfolder }
    if (slot === 'A') setImageA(value)
    else setImageB(value)
    setMessage(`Figure ${slot} loaded`)
  }

  async function generate() {
    if (running) return
    if (!finalPrompt.trim()) {
      setMessage('Enter a prompt first.')
      return
    }
    setRunning(true)
    setProgress(null)
    setMessage('Preparing…')
    stopProgress.current?.()
    try {
      const uploadedA = imageA?.comfyName
      const uploadedB = imageB?.comfyName
      const workflow = buildWorkflow({
        prompt: finalPrompt,
        negativePrompt,
        seed,
        image1: uploadedA,
        image2: uploadedB,
        cfg,
        steps,
        scheduler,
        aspectRatio,
        megapixels,
        maxDimension,
      })
      const result = await queuePrompt(workflow)
      setMessage('Generating…')
      stopProgress.current = connectProgress(result.prompt_id, (value, max) => setProgress({ value, max }), () => void finishGeneration(result.prompt_id))
      setSeed(Math.floor(Math.random() * 900000000000000))
    } catch (error) {
      setRunning(false)
      setMessage(error instanceof Error ? error.message : 'Generation failed')
      setLogs((v) => [...v, String(error)])
    }
  }

  async function finishGeneration(promptId: string) {
    try {
      const data = await getHistory(promptId)
      const entry = data?.[promptId]
      const outputs = entry?.outputs || {}
      let filename = ''
      let subfolder = ''
      for (const node of Object.values(outputs) as any[]) {
        const images = Array.isArray(node?.images) ? node.images : []
        if (images[0]?.filename) {
          filename = images[0].filename
          subfolder = images[0].subfolder || ''
          break
        }
      }
      if (filename) {
        const item: HistoryItem = {
          id: makeId('generation'),
          url: viewImageUrl(filename, subfolder, 'output'),
          prompt: finalPrompt,
          negativePrompt,
          createdAt: Date.now(),
          steps,
          cfg,
        }
        setHistory((v) => [item, ...v])
        setMessage('Generation complete')
      } else {
        setMessage('Generation finished, but no output image was found.')
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not read generation result')
    } finally {
      setRunning(false)
      setProgress(null)
      stopProgress.current?.()
      stopProgress.current = null
    }
  }

  async function cancel() {
    try {
      await interruptGeneration()
      setMessage('Generation interrupted')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not interrupt')
    } finally {
      setRunning(false)
      stopProgress.current?.()
      stopProgress.current = null
      setProgress(null)
    }
  }

  function deleteHistory(id: string) {
    setHistory((v) => v.filter((item) => item.id !== id))
  }

  async function createDatasetCard(image: File, cardPrompt: string) {
    const reader = new FileReader()
    const imageData = await new Promise<string>((resolve, reject) => {
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(image)
    })
    const card: DatasetCard = { id: makeId('dataset'), image: imageData, prompt: cardPrompt, createdAt: Date.now() }
    await writeDatasetCard(card)
    setDatasets((v) => [card, ...v])
  }

  async function importDatasetJson(file: File) {
    setDatasetImportBusy(true)
    try {
      const raw = JSON.parse(await file.text())
      const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : Array.isArray(raw?.data) ? raw.data : []
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        const image = typeof row.image === 'string' ? row.image : typeof row.image_url === 'string' ? row.image_url : ''
        const text = typeof row.prompt === 'string' ? row.prompt : typeof row.text === 'string' ? row.text : ''
        if (!image) continue
        const card: DatasetCard = { id: makeId('dataset'), image, prompt: text, createdAt: Date.now() }
        await writeDatasetCard(card)
      }
      setDatasets(await readDatasetCards())
      setMessage('Dataset imported')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Dataset import failed')
    } finally {
      setDatasetImportBusy(false)
    }
  }

  function exportDataset() {
    const blob = new Blob([JSON.stringify(datasets, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'dataset.json'
    link.click()
    URL.revokeObjectURL(url)
  }

  function openPanel(next: Panel) {
    setPanel(next)
    setFooterExpanded(false)
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">COMFYUI PWA</div>
          <h1>Console</h1>
        </div>
        <div className="topbar-status">
          <span className={`status-dot ${power}`} />
          <span>{power === 'active' ? 'ONLINE' : power === 'starting' ? 'STARTING' : 'OFFLINE'}</span>
        </div>
      </header>

      <main className="workspace">
        <section className="image-grid">
          <ImageNode label="Figure A" image={imageA} onChoose={(file) => void chooseImage('A', file)} onClear={() => setImageA(null)} />
          <ImageNode label="Figure B" image={imageB} onChoose={(file) => void chooseImage('B', file)} onClear={() => setImageB(null)} />
        </section>

        {progress && (
          <div className="progress-wrap">
            <div className="progress-label"><span>{message}</span><span>{progress.value}/{progress.max}</span></div>
            <div className="progress-track"><span style={{ width: `${Math.min(100, (progress.value / progress.max) * 100)}%` }} /></div>
          </div>
        )}

        <section className="prompt-card">
          <div className="section-head">
            <span>MAIN PROMPT</span>
            <button type="button" onClick={() => setPromptBuilderOpen((v) => !v)}>{promptBuilderOpen ? 'Close Builder' : 'Prompt Builder'}</button>
          </div>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe the image you want to create…" />
          {promptBuilderOpen && (
            <div className="builder">
              {builderLabels.map((label) => (
                <label key={label} className="builder-row">
                  <span>{label}</span>
                  <input value={builderValues[label] || ''} onChange={(e) => setBuilderValues((v) => ({ ...v, [label]: e.target.value }))} placeholder="Optional" />
                </label>
              ))}
              <button type="button" className="builder-preview" onClick={() => setPrompt(finalPrompt)}>Use Final Prompt</button>
            </div>
          )}
          <label className="negative">
            <span>NEGATIVE PROMPT</span>
            <textarea value={negativePrompt} onChange={(e) => setNegativePrompt(e.target.value)} />
          </label>
        </section>

        <section className="controls-card">
          <div className="control-grid">
            <NumberControl label="CFG" value={cfg} min={0} max={20} step={0.1} onChange={setCfg} />
            <NumberControl label="STEPS" value={steps} min={1} max={100} step={1} onChange={setSteps} />
            <NumberControl label="MAX DIM" value={maxDimension} min={256} max={4096} step={32} onChange={setMaxDimension} />
            <NumberControl label="MP" value={megapixels} min={0.1} max={4} step={0.1} onChange={setMegapixels} />
            <label><span>ASPECT</span><select value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}>{aspectRatios.map((v) => <option key={v}>{v}</option>)}</select></label>
            <label><span>SCHEDULER</span><select value={scheduler} onChange={(e) => setScheduler(e.target.value)}>{schedulers.map((v) => <option key={v}>{v}</option>)}</select></label>
          </div>
          <div className="generation-row">
            <button type="button" className="generate" onClick={() => void generate()} disabled={running}>{running ? 'GENERATING…' : 'GENERATE'}</button>
            {running && <button type="button" className="cancel" onClick={() => void cancel()}>STOP</button>}
            <button type="button" className="seed" onClick={() => setSeed(Math.floor(Math.random() * 900000000000000))}>SEED {seed}</button>
          </div>
          <div className="message">{message}</div>
        </section>
      </main>

      {panel !== 'none' && (
        <div className="panel-backdrop" onClick={() => setPanel('none')}>
          <section className="panel" onClick={(e) => e.stopPropagation()}>
            <div className="panel-head">
              <div>
                <div className="eyebrow">COMFYUI PWA</div>
                <h2>{panel === 'history' ? 'History' : panel === 'datasets' ? 'Datasets' : panel === 'logs' ? 'Logs' : 'Settings'}</h2>
              </div>
              <button type="button" className="close" onClick={() => setPanel('none')}>×</button>
            </div>

            {panel === 'history' && (
              <div className="history-grid">
                {history.length === 0 && <div className="empty">No generations yet.</div>}
                {history.map((item) => (
                  <article className="history-card" key={item.id}>
                    <img src={item.url} alt="Generated result" />
                    <div className="history-card-body">
                      <small>{new Date(item.createdAt).toLocaleString()}</small>
                      <p>{item.prompt || 'No prompt saved.'}</p>
                      <button type="button" onClick={() => { setPrompt(item.prompt); setPanel('none') }}>SEND TO PROMPT</button>
                      <button type="button" className="danger-text" onClick={() => deleteHistory(item.id)}>DELETE</button>
                    </div>
                  </article>
                ))}
              </div>
            )}

            {panel === 'datasets' && (
              <div className="datasets-panel">
                <div className="dataset-actions">
                  <label className="file-button">ADD CARD<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => { const file = e.target.files?.[0]; if (file) void createDatasetCard(file, prompt); e.currentTarget.value = '' }} /></label>
                  <label className="file-button">IMPORT JSON<input type="file" accept="application/json,.json" disabled={datasetImportBusy} onChange={(e) => { const file = e.target.files?.[0]; if (file) void importDatasetJson(file); e.currentTarget.value = '' }} /></label>
                  <button type="button" onClick={exportDataset}>EXPORT JSON</button>
                </div>
                <div className="dataset-grid">
                  {datasets.length === 0 && <div className="empty">No dataset cards yet.</div>}
                  {datasets.map((card) => (
                    <article className="dataset-card" key={card.id}>
                      <img src={card.image} alt="" />
                      <textarea value={editingDataset?.id === card.id ? editingDataset.prompt : card.prompt} readOnly={editingDataset?.id !== card.id} onChange={(e) => setEditingDataset((v) => v ? { ...v, prompt: e.target.value } : null)} />
                      <div>
                        {editingDataset?.id === card.id ? (
                          <button type="button" onClick={() => { if (editingDataset) void writeDatasetCard(editingDataset).then(() => { setDatasets((v) => v.map((x) => x.id === editingDataset.id ? editingDataset : x)); setEditingDataset(null) }) }}>SAVE</button>
                        ) : (
                          <button type="button" onClick={() => setEditingDataset(card)}>EDIT</button>
                        )}
                        <button type="button" className="danger-text" onClick={() => void deleteDatasetCard(card.id).then(() => setDatasets((v) => v.filter((x) => x.id !== card.id)))}>DELETE</button>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            )}

            {panel === 'logs' && (
              <div className="logs">
                {logs.length === 0 ? <div className="empty">No errors logged.</div> : logs.map((line, index) => <pre key={index}>{line}</pre>)}
              </div>
            )}

            {panel === 'settings' && (
              <div className="settings">
                <div className="setting-line"><span>Sleep timer</span><button type="button" className={sleepLocked ? 'toggle on' : 'toggle'} onClick={() => setSleepLocked((v) => !v)}>{sleepLocked ? 'LOCKED' : 'AUTO'}</button></div>
                <div className="setting-line"><span>Server status</span><button type="button" onClick={() => void refreshPower()}>REFRESH</button></div>
                <div className="setting-line"><span>App version</span><strong>Clean rebuild</strong></div>
              </div>
            )}
          </section>
        </div>
      )}

      <footer className={`app-footer ${footerExpanded ? 'expanded' : ''}`}>
        <div className="footer-dock">
          <button type="button" className="footer-toggle" onClick={() => setFooterExpanded((v) => !v)} aria-label="Toggle footer menu">⌃</button>
          <div className="footer-actions">
            <button type="button" onClick={() => setSleepLocked((v) => !v)}>{sleepLocked ? 'LOCK' : 'SLEEP'}</button>
            <button type="button" className={`power ${power}`} onClick={() => void startComfy()} disabled={power !== 'off'}>{power === 'starting' ? '…' : 'POWER'}</button>
            <button type="button" onClick={() => openPanel('history')}>HISTORY</button>
            <button type="button" onClick={() => openPanel('datasets')}>DATASETS</button>
            <button type="button" onClick={() => openPanel('logs')}>LOGS</button>
            <button type="button" onClick={() => openPanel('settings')}>SETTINGS</button>
          </div>
          <div className="footer-vram">VRAM / SERVER REMOTE</div>
        </div>
      </footer>
    </div>
  )
}

function ImageNode({ label, image, onChoose, onClear }: { label: string; image: ImageSlot | null; onChoose: (file?: File) => void; onClear: () => void }) {
  return (
    <section className={`image-node ${label === 'Figure A' ? 'red' : 'blue'}`}>
      <div className="node-head"><span>{label}</span><span>{image ? 'LOADED' : 'EMPTY'}</span></div>
      <label className="image-drop">
        {image ? <img src={image.preview} alt={label} /> : <><strong>INSERT IMAGE</strong><small>TAP TO LOAD SOURCE</small></>}
        <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => { onChoose(e.target.files?.[0]); e.currentTarget.value = '' }} />
      </label>
      <div className="node-bottom"><span>{image ? image.file.name : 'AWAITING SOURCE'}</span>{image && <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClear() }}>×</button>}</div>
    </section>
  )
}

function NumberControl({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return <label><span>{label}</span><input type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} /></label>
}

export default App
