export type WorkflowPrompt = Record<string, {
  inputs: Record<string, any>
  class_type: string
  _meta?: Record<string, any>
}>

function getClientId() {
  const key = 'comfy-client-id'
  const existing = localStorage.getItem(key)
  if (existing) return existing
  const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
  localStorage.setItem(key, id)
  return id
}

export async function queuePrompt(prompt: WorkflowPrompt) {
  const response = await fetch('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, client_id: getClientId() }) })
  if (!response.ok) { const text = await response.text(); throw new Error(text || `ComfyUI returned ${response.status}`) }
  return response.json() as Promise<{ prompt_id: string }>
}

export async function getHistory(promptId?: string) {
  const url = promptId ? `/history/${encodeURIComponent(promptId)}` : '/history'
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not read ComfyUI history (${response.status})`)
  return response.json()
}

export function viewImageUrl(filename: string, subfolder = '', type = 'output') {
  const params = new URLSearchParams({ filename, subfolder, type })
  return `/view?${params.toString()}`
}

export async function uploadImage(file: File) {
  const form = new FormData()
  form.append('image', file, file.name)
  form.append('type', 'input')
  form.append('overwrite', 'true')
  const response = await fetch('/upload/image', { method: 'POST', body: form })
  if (!response.ok) { const text = await response.text(); throw new Error(text || `Image upload failed (${response.status})`) }
  return response.json() as Promise<{ name: string; subfolder: string; type: string }>
}

export function connectProgress(promptId: string, onProgress: (value: number, max: number) => void, onFinished?: () => void) {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws?clientId=${encodeURIComponent(getClientId())}`)
  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data)
      if (message?.type === 'progress' && message?.data) {
        const value = Number(message.data.value); const max = Number(message.data.max)
        if (Number.isFinite(value) && Number.isFinite(max) && max > 0) onProgress(value, max)
      }
      if ((message?.type === 'executing' || message?.type === 'executed') && message?.data?.prompt_id === promptId && (message?.data?.node === null || message?.type === 'executed')) {
        onFinished?.(); ws.close()
      }
    } catch {}
  }
  return () => ws.close()
}

export async function interruptGeneration(): Promise<void> {
  const response = await fetch('/interrupt', { method: 'POST' })
  if (!response.ok) { const text = await response.text(); throw new Error(text || `Could not stop generation (${response.status})`) }
}
