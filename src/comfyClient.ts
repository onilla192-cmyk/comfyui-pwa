export type WorkflowPrompt = Record<string, {
  inputs: Record<string, any>
  class_type: string
  _meta?: Record<string, any>
}>

const COMFY_BASE_URL = import.meta.env.PROD
  ? 'https://comfyui.tail84bda1.ts.net'
  : ''

const LAUNCHER_BASE_URL = import.meta.env.PROD
  ? 'https://comfyui.tail84bda1.ts.net/launcher'
  : '/launcher'

export type LauncherStatus = {
  ok: boolean
  comfyui: 'running' | 'starting' | 'stopped' | string
  launcher: string
  batFound: boolean
  batPath: string
}

export async function getLauncherLogs(): Promise<string[]> {
  const response = await fetch(`${LAUNCHER_BASE_URL}/logs`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Launcher logs returned ${response.status}`)
  const data = await response.json() as { logs?: unknown }
  return Array.isArray(data.logs) ? data.logs.map((line) => String(line)) : []
}

export async function getLauncherStatus(): Promise<LauncherStatus> {
  if (import.meta.env.PROD) {
    const remote = await getRemoteControlStatus()
    return {
      ok: remote.ok === true,
      comfyui: remote.comfyui ?? 'stopped',
      launcher: remote.launcher ?? 'unknown',
      batFound: true,
      batPath: '',
    }
  }

  const response = await fetch(`${LAUNCHER_BASE_URL}/status`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Launcher returned ${response.status}`)
  return response.json() as Promise<LauncherStatus>
}

export async function getComfySystemStats(): Promise<any> {
  const response = await fetch(`${COMFY_BASE_URL}/system_stats`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Could not read ComfyUI system stats (${response.status})`)
  return response.json()
}

export async function waitForComfyReady(timeoutMs = 120000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${COMFY_BASE_URL}/system_stats`, { cache: 'no-store' })
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error('ComfyUI did not finish starting.')
}

export async function startComfyUI(): Promise<void> {
  // Production uses the phone remote controller. The old /launcher route is not exposed through Tailscale.
  if (import.meta.env.PROD) {
    await startComfyFromPhone()
    return
  }

  const response = await fetch(`${LAUNCHER_BASE_URL}/start`, { method: 'POST' })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `Could not start ComfyUI (launcher ${response.status})`)
  }
  await waitForComfyReady()
}

export async function stopComfyUI(): Promise<void> {
  const response = await fetch(`${LAUNCHER_BASE_URL}/stop`, { method: 'POST' })
  if (!response.ok) throw new Error(`Could not stop ComfyUI (launcher ${response.status})`)
}

export async function freeComfyMemory(): Promise<void> {
  const response = await fetch(`${COMFY_BASE_URL}/free`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unload_models: true, free_memory: true }),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `Could not free ComfyUI memory (${response.status})`)
  }
}

export async function ensureComfyRunning(): Promise<void> {
  await startComfyUI()
}
function getClientId() {
  const key = 'comfy-client-id'
  const existing = localStorage.getItem(key)
  if (existing) return existing
  const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
  localStorage.setItem(key, id)
  return id
}

export async function queuePrompt(prompt: WorkflowPrompt) {
  await ensureComfyRunning()
  const response = await fetch(`${COMFY_BASE_URL}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: getClientId() })
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `ComfyUI returned ${response.status}`)
  }
  return response.json() as Promise<{ prompt_id: string }>
}

export async function getHistory(promptId?: string) {
  const url = promptId
    ? `${COMFY_BASE_URL}/history/${encodeURIComponent(promptId)}`
    : `${COMFY_BASE_URL}/history`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not read ComfyUI history (${response.status})`)
  return response.json()
}

export function viewImageUrl(filename: string, subfolder = '', type = 'output') {
  const params = new URLSearchParams({ filename, subfolder, type })
  return `${COMFY_BASE_URL}/view?${params.toString()}`
}

export async function uploadImage(file: File) {
  const form = new FormData()
  form.append('image', file, file.name)
  form.append('type', 'input')
  form.append('overwrite', 'true')
  const response = await fetch(`${COMFY_BASE_URL}/upload/image`, {
    method: 'POST',
    body: form
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `Image upload failed (${response.status})`)
  }
  return response.json() as Promise<{ name: string; subfolder: string; type: string }>
}

export function connectProgress(
  promptId: string,
  onProgress: (value: number, max: number) => void,
  onFinished?: () => void
) {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsBase = import.meta.env.PROD
    ? 'wss://comfyui.tail84bda1.ts.net'
    : `${wsProtocol}//${window.location.host}`

  const ws = new WebSocket(`${wsBase}/ws?clientId=${encodeURIComponent(getClientId())}`)
  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data)
      if (message?.type === 'progress' && message?.data) {
        const value = Number(message.data.value)
        const max = Number(message.data.max)
        if (Number.isFinite(value) && Number.isFinite(max) && max > 0) {
          onProgress(value, max)
        }
      }
      if (
        (message?.type === 'executing' || message?.type === 'executed') &&
        message?.data?.prompt_id === promptId &&
        (message?.data?.node === null || message?.type === 'executed')
      ) {
        onFinished?.()
        ws.close()
      }
    } catch {}
  }
  return () => ws.close()
}

export async function interruptGeneration(): Promise<void> {
  const response = await fetch(`${COMFY_BASE_URL}/interrupt`, { method: 'POST' })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `Could not stop generation (${response.status})`)
  }
}


const REMOTE_CONTROL_URL = import.meta.env.PROD
  ? 'https://comfyui.tail84bda1.ts.net/remote'
  : '/remote'

export async function startComfyFromPhone(): Promise<void> {
  const response = await fetch(`${REMOTE_CONTROL_URL}/start`, {
    method: 'POST',
    cache: 'no-store',
  })

  const text = await response.text()

  if (!response.ok) {
    throw new Error(text || `Remote start failed (${response.status})`)
  }

  let data: { ok?: boolean; comfyui?: string } = {}
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('Remote launcher returned an invalid response.')
  }

  if (data.ok !== true || data.comfyui !== 'running') {
    throw new Error('ComfyUI did not reach the running state.')
  }
}


export async function getRemoteControlStatus(): Promise<any> {
  const response = await fetch(`${REMOTE_CONTROL_URL}/status`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Remote control returned ${response.status}`)
  return response.json()
}
