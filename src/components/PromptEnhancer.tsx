import { useEffect, useRef, useState } from 'react'

const PERCHANCE_ORIGIN = 'https://text-generation.perchance.org'
const PERCHANCE_IFRAME_ID = 'comfyui-pwa-perchance-ai-text'

const CATEGORIES = [
  { value: 'portrait', label: 'Character Portrait' },
  { value: 'landscape', label: 'Landscape/Scene' },
  { value: 'action', label: 'Action Scene' },
  { value: 'fantasy', label: 'Fantasy' },
  { value: 'scifi', label: 'Sci-Fi' },
  { value: 'erotic', label: 'Erotic/NSFW' },
  { value: 'explicit', label: 'Explicit Adult', disabled: true },
]

function buildInstruction(category: string, userInput: string) {
  const categoryLabel = CATEGORIES.find((item) => item.value === category)?.label ?? category
  let instruction = `Generate a detailed image prompt for ${categoryLabel} category`
  if (userInput.trim()) instruction += ` that includes: ${userInput.trim()}`

  instruction += `.
  
You are generating a prompt specifically for Qwen Image Edit 2.1.
Return only the final image-editing prompt. Do not explain your reasoning, do not add headings, and do not say "Here is your prompt".

Expand the user's idea into a precise, coherent visual instruction while preserving every concrete requirement the user gave you. Do not replace, contradict, or silently remove requested subjects, relationships, poses, positioning, clothing, composition, or camera direction.

When useful, make the prompt precise about subject appearance, pose and body positioning, spatial relationships, composition, framing, camera position and perspective, lighting, environment, materials, atmosphere, depth of field, and important visual detail.

Because this is Qwen Image Edit 2.1, treat existing source/reference characters as locked assets when the user's request involves them: preserve identity, facial features, hairstyle, clothing, body proportions, colors, accessories, and original art style unless the user explicitly asks to change one of those things. Clearly describe only the requested edit or addition.

Do not invent major story elements or unnecessary details that could change the user's intended scene. Keep the result natural and optimized for image editing rather than generic prose.`

  if (category === 'erotic') {
    instruction += `
    
Keep this category adult and non-graphic: suggestive/erotic atmosphere is allowed, but do not describe explicit sexual acts or graphic sexual anatomy.`
  }

  return instruction
}

function getPerchanceText(instruction: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let iframe = document.getElementById(PERCHANCE_IFRAME_ID) as HTMLIFrameElement | null
    if (!iframe) {
      iframe = document.createElement('iframe')
      iframe.id = PERCHANCE_IFRAME_ID
      iframe.src = `${PERCHANCE_ORIGIN}/embed`
      iframe.style.cssText = 'display:none;position:fixed;width:1px;height:1px;border:0;opacity:0;pointer-events:none;'
      document.body.appendChild(iframe)
    }

    const requestId = `comfyPrompt_${Date.now()}_${Math.random().toString(36).slice(2)}`
    let output = ''
    let finished = false
    let ready = iframe.dataset.ready === 'true'

    const cleanup = () => {
      window.removeEventListener('message', onMessage)
      window.clearTimeout(timeout)
    }

    const finish = (value: string) => {
      if (finished) return
      finished = true
      cleanup()
      const result = value.trim()
      if (!result) reject(new Error('The prompt enhancer returned an empty response.'))
      else resolve(result)
    }

    const fail = (error: Error) => {
      if (finished) return
      finished = true
      cleanup()
      reject(error)
    }

    const send = () => {
      if (!iframe?.contentWindow) {
        fail(new Error('Prompt enhancer could not connect to the AI service.'))
        return
      }
      iframe.contentWindow.postMessage({
        type: 'startStream',
        url: `${PERCHANCE_ORIGIN}/api/generate`,
        postData: {
          instruction: instruction.replace(' ', '\u00a0'),
          startWith: '',
          stopSequences: [],
          generatorName: 'comfyui-pwa',
        },
        requestId,
        perchanceGeneratorOrigin: window.location.origin,
      }, PERCHANCE_ORIGIN)
    }

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== PERCHANCE_ORIGIN || event.source !== iframe?.contentWindow) return

      if (event.data?.type === 'embedIsReady') {
        ready = true
        iframe!.dataset.ready = 'true'
        iframe!.contentWindow?.postMessage({ type: 'verifyUser' }, PERCHANCE_ORIGIN)
        return
      }

      if (event.data?.type === 'verified') {
        iframe!.dataset.ready = 'true'
        if (!ready) ready = true
        send()
        return
      }

      if (event.data?.requestId !== requestId) return

      if (event.data?.type === 'streamData') {
        const chunk = event.data?.value?.text
        if (typeof chunk === 'string') output += chunk
        if (event.data?.value?.final) finish(output)
      } else if (event.data?.type === 'streamEnd') {
        finish(output)
      } else if (event.data?.type === 'streamError') {
        fail(new Error(`Prompt enhancer error: ${String(event.data.status ?? 'unknown error').replace(/_/g, ' ')}`))
      }
    }

    const timeout = window.setTimeout(() => fail(new Error('Prompt enhancement timed out. Please try again.')), 90000)
    window.addEventListener('message', onMessage)

    if (ready) send()
    else if (iframe.contentWindow) iframe.contentWindow.postMessage({ type: 'verifyUser' }, PERCHANCE_ORIGIN)
  })
}

interface PromptEnhancerProps {
  initialPrompt: string
  disabled?: boolean
  onUsePrompt: (prompt: string) => void
}

export function PromptEnhancer({ initialPrompt, disabled = false, onUsePrompt }: PromptEnhancerProps) {
  const [open, setOpen] = useState(false)
  const [category, setCategory] = useState('portrait')
  const [idea, setIdea] = useState(initialPrompt)
  const [result, setResult] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (open) {
      setIdea(initialPrompt)
      window.setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open, initialPrompt])

  async function enhance() {
    const value = idea.trim()
    if (!value || loading) return
    if (category === 'explicit') return
    setLoading(true)
    setError('')
    setResult('')
    try {
      const enhanced = await getPerchanceText(buildInstruction(category, value))
      setResult(enhanced)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Prompt enhancement failed.')
    } finally {
      setLoading(false)
    }
  }

  function useResult() {
    if (!result.trim()) return
    onUsePrompt(result.trim())
    setOpen(false)
  }

  return (
    <>
      <button
        type="button"
        className="prompt-enhancer-trigger"
        onClick={() => setOpen(true)}
        disabled={disabled}
        title="Enhance prompt"
        aria-label="Enhance prompt"
      >
        ✨ Enhance Prompt
      </button>

      {open && (
        <div className="prompt-enhancer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}>
          <div className="prompt-enhancer-panel" role="dialog" aria-modal="true" aria-label="Enhance Prompt">
            <div className="prompt-enhancer-header">
              <strong>✨ Enhance Prompt</strong>
              <button type="button" className="prompt-enhancer-close" onClick={() => setOpen(false)} aria-label="Close">×</button>
            </div>

            <select value={category} onChange={(event) => setCategory(event.target.value)} disabled={loading} className="prompt-enhancer-category" aria-label="Prompt category">
              {CATEGORIES.map((item) => <option key={item.value} value={item.value} disabled={item.disabled}>{item.label}</option>)}
            </select>

            <textarea
              ref={inputRef}
              value={idea}
              onChange={(event) => setIdea(event.target.value)}
              onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void enhance() } }}
              placeholder="Describe the prompt you want..."
              rows={5}
              disabled={loading}
              className="prompt-enhancer-input"
            />

            <button type="button" className="prompt-enhancer-generate" onClick={() => void enhance()} disabled={loading || !idea.trim()}>
              {loading ? 'Generating…' : 'Generate Prompt'}
            </button>

            {error && <div className="prompt-enhancer-error">{error}</div>}

            {result && (
              <>
                <textarea value={result} readOnly rows={10} className="prompt-enhancer-result" aria-label="Enhanced prompt" />
                <button type="button" className="prompt-enhancer-use" onClick={useResult}>Use Enhanced Prompt</button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}
