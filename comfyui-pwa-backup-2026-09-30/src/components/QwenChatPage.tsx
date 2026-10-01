import './QwenChatPage.css'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { buildQwenChatWorkflow } from '../qwenChatWorkflow'
import { queuePrompt, uploadImage, waitForTextOutput } from '../comfyClient'
import { clearQwenChatBackground, loadQwenChatBackground, loadQwenAvatar, loadQwenChats, saveQwenChatBackground, saveQwenAvatar, saveQwenChats, type QwenChat, type QwenChatMessage } from '../qwenChatDb'

type MessagePart =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string; language: string }

function splitMessageParts(text: string): MessagePart[] {
  const parts: MessagePart[] = []
  const fence = /\`\`\`([^\n`]*)\n([\s\S]*?)\n?\`\`\`/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = fence.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, match.index) })
    }
    parts.push({
      type: 'code',
      language: match[1].trim(),
      value: match[2].replace(/\n$/, ''),
    })
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) })
  }

  return parts.length ? parts : [{ type: 'text', value: text }]
}

function makeStateUid(existing: QwenChat[] = []): number {
  const used = new Set(existing.map((chat) => chat.stateUid))
  let value = 100000 + Math.floor(Math.random() * 900000)
  while (used.has(value)) value = 100000 + Math.floor(Math.random() * 900000)
  return value
}

function repairStateUids(chats: QwenChat[]): QwenChat[] {
  const used = new Set<number>()

  return chats.map((chat) => {
    const valid = Number.isInteger(chat.stateUid) && chat.stateUid >= 0 && chat.stateUid <= 999999 && !used.has(chat.stateUid)
    const stateUid = valid ? chat.stateUid : makeStateUid(Array.from(used).map((uid) => ({ stateUid: uid } as QwenChat)))
    used.add(stateUid)

    return valid ? chat : { ...chat, stateUid }
  })
}

function makeChat(existing: QwenChat[] = [], title = 'New Chat'): QwenChat {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    title,
    stateUid: makeStateUid(existing),
    messages: [],
    createdAt: now,
    updatedAt: now,
  }
}

type QwenDynamicTheme = {
  userBg: string
  userText: string
  assistantBg: string
  assistantText: string
  accent: string
}

function rgbToCss(r: number, g: number, b: number): string {
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`
}

function mixRgb(a: [number, number, number], b: [number, number, number], amount: number): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * amount,
    a[1] + (b[1] - a[1]) * amount,
    a[2] + (b[2] - a[2]) * amount,
  ]
}

function contrastText(rgb: [number, number, number]): string {
  const luminance = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
  return luminance > 0.58 ? '#111114' : '#ffffff'
}

function extractQwenTheme(url: string): Promise<QwenDynamicTheme | null> {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        const size = 48
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) {
          resolve(null)
          return
        }

        ctx.drawImage(image, 0, 0, size, size)
        const data = ctx.getImageData(0, 0, size, size).data

        let weightedR = 0
        let weightedG = 0
        let weightedB = 0
        let weightTotal = 0
        let allR = 0
        let allG = 0
        let allB = 0
        let allCount = 0

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i]
          const g = data[i + 1]
          const b = data[i + 2]
          const max = Math.max(r, g, b)
          const min = Math.min(r, g, b)
          const saturation = max === 0 ? 0 : (max - min) / max
          const brightness = (r + g + b) / (255 * 3)

          allR += r
          allG += g
          allB += b
          allCount += 1

          if (saturation > 0.18 && brightness > 0.08 && brightness < 0.94) {
            const weight = saturation * (0.35 + Math.min(brightness, 0.75))
            weightedR += r * weight
            weightedG += g * weight
            weightedB += b * weight
            weightTotal += weight
          }
        }

        const base: [number, number, number] = weightTotal > 0
          ? [weightedR / weightTotal, weightedG / weightTotal, weightedB / weightTotal]
          : [allR / allCount, allG / allCount, allB / allCount]

        const baseLuminance = (0.2126 * base[0] + 0.7152 * base[1] + 0.0722 * base[2]) / 255
        const userBase = baseLuminance > 0.62
          ? mixRgb(base, [0, 0, 0], 0.28)
          : mixRgb(base, [255, 255, 255], 0.10)
        const assistantBase = baseLuminance > 0.62
          ? mixRgb(base, [255, 255, 255], 0.72)
          : mixRgb(base, [0, 0, 0], 0.42)

        resolve({
          userBg: rgbToCss(...userBase),
          userText: contrastText(userBase),
          assistantBg: rgbToCss(...assistantBase),
          assistantText: contrastText(assistantBase),
          accent: rgbToCss(...userBase),
        })
      } catch {
        resolve(null)
      }
    }
    image.onerror = () => resolve(null)
    image.src = url
  })
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Could not prepare the image for chat history.'))
    }
    reader.onerror = () => reject(reader.error || new Error('Could not read the image.'))
    reader.readAsDataURL(file)
  })
}

export function QwenChatPage({ onClose }: { onClose: () => void }) {
  const [chats, setChats] = useState<QwenChat[]>([])
  const [activeChatId, setActiveChatId] = useState('')
  const [loadingChats, setLoadingChats] = useState(true)
  const [chatListOpen, setChatListOpen] = useState(false)
  const [backgroundBlob, setBackgroundBlob] = useState<Blob | null>(null)
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null)
  const [qwenAvatarBlob, setQwenAvatarBlob] = useState<Blob | null>(null)
  const [qwenAvatarUrl, setQwenAvatarUrl] = useState<string | null>(null)
  const [dynamicTheme, setDynamicTheme] = useState<QwenDynamicTheme | null>(null)
  const [text, setText] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [composerExpanded, setComposerExpanded] = useState(false)
  const endRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  const activeChat = chats.find((chat) => chat.id === activeChatId) ?? null
  const messages = activeChat?.messages ?? []
  const sortedChats = [...chats].sort((a, b) => b.updatedAt - a.updatedAt)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        let loaded = await loadQwenChats()

        if (!loaded.length) {
          try {
            const legacy = JSON.parse(localStorage.getItem('qwen3.5-hauhau-chat-v1') || '[]')
            if (Array.isArray(legacy) && legacy.length) {
              const migrated = makeChat([], 'Previous Chat')
              migrated.messages = legacy as QwenChatMessage[]
              migrated.updatedAt = Date.now()
              loaded = [migrated]
            }
          } catch {}
        }

        if (!loaded.length) loaded = [makeChat([])]

        loaded = repairStateUids(loaded)

        if (!cancelled) {
          setChats(loaded)
          setActiveChatId(loaded[0].id)
        }
      } catch {
        if (!cancelled) {
          const fallback = makeChat([])
          setChats([fallback])
          setActiveChatId(fallback.id)
          setError('Could not load saved chats. A new chat was created.')
        }
      } finally {
        if (!cancelled) setLoadingChats(false)
      }
    })()

    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!loadingChats) void saveQwenChats(chats).catch(() => {})
  }, [chats, loadingChats])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [activeChatId, messages])

  useEffect(() => {
    let cancelled = false

    void loadQwenChatBackground()
      .then((blob) => {
        if (!cancelled) setBackgroundBlob(blob)
      })
      .catch(() => {
        if (!cancelled) setBackgroundBlob(null)
      })

    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!backgroundBlob) {
      setBackgroundUrl(null)
      return
    }
    const url = URL.createObjectURL(backgroundBlob)
    setBackgroundUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [backgroundBlob])

  useEffect(() => {
    if (!backgroundUrl) {
      setDynamicTheme(null)
      return
    }

    let cancelled = false
    void extractQwenTheme(backgroundUrl).then((theme) => {
      if (!cancelled) setDynamicTheme(theme)
    })

    return () => { cancelled = true }
  }, [backgroundUrl])

  useEffect(() => {
    let cancelled = false
    void loadQwenAvatar()
      .then((blob) => {
        if (!cancelled) setQwenAvatarBlob(blob)
      })
      .catch(() => {
        if (!cancelled) setQwenAvatarBlob(null)
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!qwenAvatarBlob) {
      setQwenAvatarUrl(null)
      return
    }
    const url = URL.createObjectURL(qwenAvatarBlob)
    setQwenAvatarUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [qwenAvatarBlob])

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

  async function handleQwenAvatar(file?: File) {
    if (!file) return
    try {
      await saveQwenAvatar(file)
      setQwenAvatarBlob(file)
    } catch {
      setError('Could not save the Qwen avatar.')
    }
  }

  async function handleBackground(file?: File) {
    if (!file) return
    try {
      await saveQwenChatBackground(file)
      setBackgroundBlob(file)
    } catch {
      setError('Could not save the chat background.')
    }
  }

  async function removeBackground() {
    try {
      await clearQwenChatBackground()
      setBackgroundBlob(null)
    } catch {
      setError('Could not remove the chat background.')
    }
  }

  function updateChat(chatId: string, updater: (chat: QwenChat) => QwenChat) {
    setChats((current) => current.map((chat) => chat.id === chatId ? updater(chat) : chat))
  }

  function createNewChat() {
    if (sending || loadingChats) return
    const chat = makeChat(chats)
    setChats((current) => [chat, ...current])
    setActiveChatId(chat.id)
    setText('')
    setImageFile(null)
    setError('')
    setComposerExpanded(false)
    setChatListOpen(false)
  }

  function switchChat(chatId: string) {
    if (sending || chatId === activeChatId) {
      if (!sending) setChatListOpen(false)
      return
    }
    setActiveChatId(chatId)
    setText('')
    setImageFile(null)
    setError('')
    setComposerExpanded(false)
    setChatListOpen(false)
  }

  function renameChat(chat: QwenChat) {
    if (sending) return
    const next = window.prompt('Rename chat', chat.title)
    if (!next?.trim()) return
    updateChat(chat.id, (current) => ({ ...current, title: next.trim(), updatedAt: Date.now() }))
  }

  function deleteChat(chat: QwenChat) {
    if (sending) return
    if (!window.confirm(`Delete "${chat.title}"? This cannot be undone.`)) return

    setChats((current) => {
      const remaining = current.filter((item) => item.id !== chat.id)
      if (remaining.length) {
        if (chat.id === activeChatId) setActiveChatId(remaining[0].id)
        return remaining
      }

      const replacement = makeChat(current)
      setActiveChatId(replacement.id)
      return [replacement]
    })

    if (chat.id === activeChatId) {
      setText('')
      setImageFile(null)
      setError('')
    }
  }

  async function copyMessage(message: QwenChatMessage) {
    try {
      await navigator.clipboard.writeText(message.text)
      setCopiedId(message.id)
      window.setTimeout(() => setCopiedId((current) => current === message.id ? null : current), 1400)
    } catch {
      setError('Could not copy Qwen message.')
    }
  }

  function sendToMainPrompt(message: QwenChatMessage) {
    const confirmed = window.confirm(
      'Send this Qwen response to the Main Prompt box? This will replace the current Main Prompt text, but your Hook Prompts will remain unchanged.'
    )
    if (!confirmed) return

    window.dispatchEvent(new CustomEvent('qwen-send-to-main-prompt', { detail: message.text }))
  }

  async function copyCode(code: string, id: string) {
    try {
      await navigator.clipboard.writeText(code)
      setCopiedId(id)
      window.setTimeout(() => setCopiedId((current) => current === id ? null : current), 1400)
    } catch {
      setError('Could not copy code.')
    }
  }

  async function sendMessage() {
    const prompt = text.trim()
    if ((!prompt && !imageFile) || sending || loadingChats || !activeChat) return

    const chatId = activeChat.id
    const stateUid = activeChat.stateUid
    const responseText = prompt || 'Describe this image.'

    setSending(true)
    setError('')
    setComposerExpanded(false)

    let persistedImageUrl = imagePreview || undefined
    if (imageFile) {
      try {
        persistedImageUrl = await fileToDataUrl(imageFile)
      } catch {}
    }

    const userMessage: QwenChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text: responseText,
      imageUrl: persistedImageUrl,
    }

    updateChat(chatId, (chat) => ({
      ...chat,
      title: chat.messages.length ? chat.title : responseText.slice(0, 42) || 'New Chat',
      messages: [...chat.messages, userMessage],
      updatedAt: Date.now(),
    }))
    setText('')

    try {
      let imageName: string | undefined
      if (imageFile) {
        const uploaded = await uploadImage(imageFile)
        imageName = uploaded.name
      }

      const workflow = buildQwenChatWorkflow({
        prompt: responseText,
        imageName,
        stateUid,
      })

      const { prompt_id: promptId } = await queuePrompt(workflow)
      const answer = await waitForTextOutput(promptId)

      updateChat(chatId, (chat) => ({
        ...chat,
        messages: [
          ...chat.messages,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            text: answer,
          },
        ],
        updatedAt: Date.now(),
      }))
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
    <section
      className={`qwen-chat-page ${composerExpanded ? 'composer-expanded' : ''}${backgroundUrl ? ' has-background' : ''}`}
      aria-label="Qwen Chat"
      style={backgroundUrl ? ({
        '--qwen-chat-background': `url("${backgroundUrl}")`,
        '--qwen-user-bubble': dynamicTheme?.userBg,
        '--qwen-user-text': dynamicTheme?.userText,
        '--qwen-assistant-bubble': dynamicTheme?.assistantBg,
        '--qwen-assistant-text': dynamicTheme?.assistantText,
        '--qwen-chat-accent': dynamicTheme?.accent,
      } as CSSProperties) : undefined}
    >
      <input
        id="qwen-avatar-upload"
        className="qwen-avatar-upload-input"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={(event) => {
          void handleQwenAvatar(event.target.files?.[0])
          event.currentTarget.value = ''
        }}
      />
      <header className="qwen-chat-header">
        <button
          type="button"
          className={`qwen-chat-chats-btn${chatListOpen ? ' active' : ''}`}
          onClick={() => setChatListOpen((open) => !open)}
          disabled={loadingChats}
          aria-expanded={chatListOpen}
          aria-label="Open chats"
        >
          <span aria-hidden="true">☰</span>
          <span>Chats</span>
        </button>
        <div className="qwen-chat-header-title">
          <h2>{activeChat?.title || 'Qwen Chat'}</h2>
          <span>Qwen3.5 4B · Hauhau · ComfyUI</span>
        </div>
        <div className="qwen-chat-header-actions">
          <label className={`qwen-chat-background-btn${backgroundUrl ? ' active' : ''}`} title="Set chat background">
            <span className="qwen-chat-background-icon" aria-hidden="true">▧</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={(event) => {
                void handleBackground(event.target.files?.[0])
                event.currentTarget.value = ''
              }}
            />
          </label>
          {backgroundUrl && (
            <button type="button" className="qwen-chat-background-remove" onClick={() => void removeBackground()} aria-label="Remove chat background" title="Remove background">×</button>
          )}
          <button type="button" className="close-btn" onClick={onClose} aria-label="Close Qwen Chat">×</button>
        </div>
      </header>

      {chatListOpen && (
        <>
          <button type="button" className="qwen-chat-list-backdrop" onClick={() => setChatListOpen(false)} aria-label="Close chat list" />
          <aside className="qwen-chat-list" aria-label="Chats">
            <div className="qwen-chat-list-header">
              <div>
                <strong>Chats</strong>
                <span>{chats.length} conversation{chats.length === 1 ? '' : 's'}</span>
              </div>
              <button type="button" onClick={createNewChat} disabled={sending || loadingChats}>+ New Chat</button>
            </div>
            <div className="qwen-chat-list-items">
              {sortedChats.map((chat) => (
                <div className={`qwen-chat-list-item${chat.id === activeChatId ? ' active' : ''}`} key={chat.id}>
                  <button type="button" className="qwen-chat-list-select" onClick={() => switchChat(chat.id)} disabled={sending}>
                    <strong>{chat.title}</strong>
                    <span>{chat.messages.length ? `${chat.messages.length} message${chat.messages.length === 1 ? '' : 's'}` : 'New conversation'}</span>
                  </button>
                  <div className="qwen-chat-list-actions">
                    <button type="button" onClick={() => renameChat(chat)} disabled={sending} aria-label={`Rename ${chat.title}`} title="Rename">✎</button>
                    <button type="button" onClick={() => deleteChat(chat)} disabled={sending} aria-label={`Delete ${chat.title}`} title="Delete">×</button>
                  </div>
                </div>
              ))}
            </div>
          </aside>
        </>
      )}

      <div className="qwen-chat-messages">
        {loadingChats ? (
          <div className="qwen-chat-empty">
            <strong>Loading chats…</strong>
            <span>Opening your saved conversations.</span>
          </div>
        ) : !messages.length && (
          <div className="qwen-chat-empty">
            <strong>{activeChat?.title || 'Qwen3.5 Hauhau'}</strong>
            <span>Send a message or attach an image.</span>
          </div>
        )}

        {messages.map((message) => (
          <article key={message.id} className={`qwen-chat-message ${message.role}`}>
            <div className="qwen-chat-message-row">
              <div className={`qwen-chat-avatar qwen-chat-avatar-${message.role}`}>
                {message.role === 'assistant' ? (
                  <label className="qwen-chat-avatar-button" htmlFor="qwen-avatar-upload" title="Customize Qwen avatar" aria-label="Customize Qwen avatar">
                    {qwenAvatarUrl ? <img src={qwenAvatarUrl} alt="Qwen avatar" /> : <span>Q</span>}
                  </label>
                ) : (
                  <span className="qwen-chat-avatar-user" aria-label="You">Y</span>
                )}
              </div>
              <div className="qwen-chat-message-content">
            {message.imageUrl && (
              <img className="qwen-chat-message-image" src={message.imageUrl} alt="Attached image" />
            )}
            <div className="qwen-chat-message-bubble">
              <span className="qwen-chat-message-role">{message.role === 'user' ? 'You' : 'Qwen'}</span>
              {message.role === 'assistant'
                ? splitMessageParts(message.text).map((part, index) =>
                    part.type === 'code' ? (
                      <div className="qwen-code-block" key={index}>
                        <div className="qwen-code-header">
                          <span>{part.language || 'code'}</span>
                          <button
                            type="button"
                            className={`qwen-code-copy ${copiedId === `${message.id}-${index}` ? 'copied' : ''}`}
                            onClick={() => void copyCode(part.value, `${message.id}-${index}`)}
                          >
                            {copiedId === `${message.id}-${index}` ? '✓ Copied' : 'Copy'}
                          </button>
                        </div>
                        <pre><code>{part.value}</code></pre>
                      </div>
                    ) : (
                      <p key={index}>{part.value}</p>
                    )
                  )
                : <p>{message.text}</p>}
              </div>
              </div>
            </div>
            {message.role === 'assistant' && (
              <div className="qwen-chat-response-actions">
                <button
                  type="button"
                  className={`qwen-chat-copy ${copiedId === message.id ? 'copied' : ''}`}
                  onClick={() => void copyMessage(message)}
                  aria-label={copiedId === message.id ? 'Copied Qwen message' : 'Copy Qwen message'}
                >
                  {copiedId === message.id ? '✓ Copied' : 'Copy'}
                </button>
                <button
                  type="button"
                  className="qwen-chat-send-to-prompt"
                  onClick={() => sendToMainPrompt(message)}
                >
                  Send to Prompt
                </button>
              </div>
            )}
          </article>
        ))}

        {sending && (
          <article className="qwen-chat-message assistant">
            <div className="qwen-chat-message-row">
              <div className="qwen-chat-avatar qwen-chat-avatar-assistant">
                <label className="qwen-chat-avatar-button" htmlFor="qwen-avatar-upload" title="Customize Qwen avatar" aria-label="Customize Qwen avatar">
                  {qwenAvatarUrl ? <img src={qwenAvatarUrl} alt="Qwen avatar" /> : <span>Q</span>}
                </label>
              </div>
              <div className="qwen-chat-message-content">
            <div className="qwen-chat-message-bubble">
              <span className="qwen-chat-message-role">Qwen</span>
              <p className="qwen-chat-thinking">Thinking…</p>
            </div>
              </div>
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
            disabled={sending || loadingChats}
            onChange={(event) => {
              handleImage(event.target.files?.[0])
              event.currentTarget.value = ''
            }}
          />
        </label>

        <textarea
          ref={inputRef}
          value={text}
          disabled={sending || loadingChats}
          placeholder="Message Qwen…"
          rows={2}
          onFocus={() => setComposerExpanded(true)}
          onBlur={() => {
            if (!text.trim()) setComposerExpanded(false)
          }}
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
          disabled={sending || loadingChats || (!text.trim() && !imageFile)}
          onClick={() => void sendMessage()}
        >
          {sending ? '…' : 'Send'}
        </button>
      </div>
    </section>
  )
}