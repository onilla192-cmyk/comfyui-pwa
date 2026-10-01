import { useEffect, useRef, useState } from 'react'
import { buildQwenChatWorkflow } from '../qwenChatWorkflow'
import { queuePrompt, uploadImage, waitForTextOutput } from '../comfyClient'

type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  imageUrl?: string
}

const STORAGE_KEY = 'qwen3.5-hauhau-chat-v1'

export function QwenChatPage({ onClose }: { onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
      return Array.isArray(saved) ? saved : []
    } catch {
      return []
    }
  })
  const [text, setText] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const endRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages))
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (!imageFile) {
      setImagePreview(null)
      return
    }
    const url = URL.createObjectURL(imageFile)
    setImagePreview(url)
    return () => URL.revokeObjectURL(url)
  }, [imageFile])

  function handleImage(file?: File) {
    if (!file) return
    setImageFile(file)
    setError('')
  }

  function removeImage() {
    setImageFile(null)
  }

  async function sendMessage() {
    const prompt = text.trim()
    if ((!prompt && !imageFile) || sending) return

    setSending(true)
    setError('')

    const userId = crypto.randomUUID()
    const userMessage: ChatMessage = {
      id: userId,
      role: 'user',
      text: prompt || 'Describe this image.',
      imageUrl: imagePreview || undefined,
    }

    setMessages((current) => [...current, userMessage])
    setText('')

    try {
      let imageName: string | undefined
      if (imageFile) {
        const uploaded = await uploadImage(imageFile)
        imageName = uploaded.name
      }

      const workflow = buildQwenChatWorkflow({
        prompt: prompt || 'Describe this image.',
        imageName,
      })

      const { prompt_id: promptId } = await queuePrompt(workflow)
      const answer = await waitForTextOutput(promptId)

      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: answer,
        },
      ])
      setImageFile(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Qwen chat failed.'
      setError(message)
      setText(prompt)
    } finally {
      setSending(false)
      window.setTimeout(() => inputRef.current?.focus(), 0)
    }
  }

  return (
    <section className="qwen-chat-page" aria-label="Qwen Chat">
      <header className="qwen-chat-header">
        <div>
          <h2>Qwen Chat</h2>
          <span>Qwen3.5 4B · Hauhau · ComfyUI</span>
        </div>
        <button type="button" className="close-btn" onClick={onClose} aria-label="Close Qwen Chat">×</button>
      </header>

      <div className="qwen-chat-messages">
        {!messages.length && (
          <div className="qwen-chat-empty">
            <strong>Qwen3.5 Hauhau</strong>
            <span>Send a message or attach an image.</span>
          </div>
        )}

        {messages.map((message) => (
          <article key={message.id} className={`qwen-chat-message ${message.role}`}>
            {message.imageUrl && (
              <img className="qwen-chat-message-image" src={message.imageUrl} alt="Attached image" />
            )}
            <div className="qwen-chat-message-bubble">
              <span className="qwen-chat-message-role">{message.role === 'user' ? 'You' : 'Qwen'}</span>
              <p>{message.text}</p>
            </div>
          </article>
        ))}

        {sending && (
          <article className="qwen-chat-message assistant">
            <div className="qwen-chat-message-bubble">
              <span className="qwen-chat-message-role">Qwen</span>
              <p className="qwen-chat-thinking">Thinking…</p>
            </div>
          </article>
        )}

        <div ref={endRef} />
      </div>

      {error && <div className="qwen-chat-error">{error}</div>}

      {imagePreview && (
        <div className="qwen-chat-attachment">
          <img src={imagePreview} alt="Selected attachment" />
          <div>
            <strong>{imageFile?.name}</strong>
            <button type="button" onClick={removeImage}>Remove</button>
          </div>
        </div>
      )}

      <div className="qwen-chat-composer">
        <label className="qwen-chat-upload" title="Attach image">
          <span>+</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={sending}
            onChange={(event) => {
              handleImage(event.target.files?.[0])
              event.currentTarget.value = ''
            }}
          />
        </label>

        <textarea
          ref={inputRef}
          value={text}
          disabled={sending}
          placeholder="Message Qwen…"
          rows={2}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void sendMessage()
            }
          }}
        />

        <button
          type="button"
          className="qwen-chat-send"
          disabled={sending || (!text.trim() && !imageFile)}
          onClick={() => void sendMessage()}
        >
          {sending ? '…' : 'Send'}
        </button>
      </div>
    </section>
  )
}
