let audioContext: AudioContext | null = null

function getAudioContext() {
  if (typeof window === 'undefined') return null
  audioContext ??= new AudioContext()
  if (audioContext.state === 'suspended') void audioContext.resume()
  return audioContext
}

function tone(ctx: AudioContext, frequency: number, duration: number, type: OscillatorType, volume: number, when = 0) {
  const start = ctx.currentTime + when
  const oscillator = ctx.createOscillator()
  const gain = ctx.createGain()
  oscillator.type = type
  oscillator.frequency.setValueAtTime(frequency, start)
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.008)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  oscillator.connect(gain)
  gain.connect(ctx.destination)
  oscillator.start(start)
  oscillator.stop(start + duration + 0.02)
}

export function playArcadeSound(kind: 'click' | 'insert' | 'generate' | 'complete' | 'error') {
  const ctx = getAudioContext()
  if (!ctx) return

  if (kind === 'click') {
    tone(ctx, 180, 0.045, 'square', 0.035)
    tone(ctx, 320, 0.035, 'square', 0.02, 0.025)
    return
  }

  if (kind === 'insert') {
    tone(ctx, 95, 0.08, 'square', 0.055)
    tone(ctx, 180, 0.08, 'square', 0.045, 0.07)
    tone(ctx, 360, 0.11, 'square', 0.035, 0.14)
    return
  }

  if (kind === 'generate') {
    tone(ctx, 220, 0.07, 'square', 0.045)
    tone(ctx, 330, 0.07, 'square', 0.04, 0.075)
    tone(ctx, 440, 0.12, 'square', 0.035, 0.15)
    return
  }

  if (kind === 'complete') {
    tone(ctx, 523.25, 0.09, 'square', 0.05)
    tone(ctx, 659.25, 0.09, 'square', 0.05, 0.09)
    tone(ctx, 783.99, 0.12, 'square', 0.05, 0.18)
    tone(ctx, 1046.5, 0.18, 'square', 0.04, 0.3)
    return
  }

  tone(ctx, 140, 0.12, 'sawtooth', 0.045)
  tone(ctx, 90, 0.18, 'square', 0.04, 0.1)
}
