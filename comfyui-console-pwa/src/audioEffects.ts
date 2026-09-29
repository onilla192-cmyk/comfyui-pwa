// Web Audio API synthesizer for tactile hardware cartridge clicks, relays, and chimes
// Zero external assets required, 100% resilient and instant

let audioCtx: AudioContext | null = null
let soundEnabled = true

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (AudioContextClass) {
      audioCtx = new AudioContextClass()
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    void audioCtx.resume()
  }
  return audioCtx
}

export function isSoundEnabled(): boolean {
  return soundEnabled
}

export function toggleSound(): boolean {
  soundEnabled = !soundEnabled
  if (soundEnabled) {
    playCartridgeInsert()
  }
  return soundEnabled
}

/**
 * Satisfying mechanical cartridge insertion sound (heavy plastic contact + spring relay click)
 */
export function playCartridgeInsert() {
  if (!soundEnabled) return
  const ctx = getAudioContext()
  if (!ctx) return

  const now = ctx.currentTime

  // Stage 1: Initial plastic impact thud
  const thudOsc = ctx.createOscillator()
  const thudGain = ctx.createGain()
  thudOsc.type = 'triangle'
  thudOsc.frequency.setValueAtTime(140, now)
  thudOsc.frequency.exponentialRampToValueAtTime(35, now + 0.08)

  thudGain.gain.setValueAtTime(0.4, now)
  thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.09)

  thudOsc.connect(thudGain)
  thudGain.connect(ctx.destination)
  thudOsc.start(now)
  thudOsc.stop(now + 0.1)

  // Stage 2: Mechanical latch click (sharp transient)
  const clickOsc = ctx.createOscillator()
  const clickGain = ctx.createGain()
  clickOsc.type = 'square'
  clickOsc.frequency.setValueAtTime(820, now + 0.04)
  clickOsc.frequency.exponentialRampToValueAtTime(160, now + 0.08)

  clickGain.gain.setValueAtTime(0, now)
  clickGain.gain.setValueAtTime(0.25, now + 0.04)
  clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.09)

  clickOsc.connect(clickGain)
  clickGain.connect(ctx.destination)
  clickOsc.start(now + 0.04)
  clickOsc.stop(now + 0.1)

  // Stage 3: Sci-fi contact bus chime (subtle low harmonic ring)
  const chimeOsc = ctx.createOscillator()
  const chimeGain = ctx.createGain()
  chimeOsc.type = 'sine'
  chimeOsc.frequency.setValueAtTime(587.33, now + 0.07) // D5
  chimeOsc.frequency.setValueAtTime(880, now + 0.11) // A5

  chimeGain.gain.setValueAtTime(0, now)
  chimeGain.gain.setValueAtTime(0.12, now + 0.07)
  chimeGain.gain.exponentialRampToValueAtTime(0.001, now + 0.26)

  chimeOsc.connect(chimeGain)
  chimeGain.connect(ctx.destination)
  chimeOsc.start(now + 0.07)
  chimeOsc.stop(now + 0.28)
}

/**
 * Cartridge ejection sound (spring slide and mechanical release)
 */
export function playCartridgeEject() {
  if (!soundEnabled) return
  const ctx = getAudioContext()
  if (!ctx) return

  const now = ctx.currentTime

  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sawtooth'
  osc.frequency.setValueAtTime(450, now)
  osc.frequency.exponentialRampToValueAtTime(120, now + 0.07)

  gain.gain.setValueAtTime(0.25, now)
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08)

  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(now)
  osc.stop(now + 0.09)
}

/**
 * Tactile micro-chirp for buttons and interactions
 */
export function playChirp(freq = 640) {
  if (!soundEnabled) return
  const ctx = getAudioContext()
  if (!ctx) return

  const now = ctx.currentTime
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(freq, now)
  osc.frequency.exponentialRampToValueAtTime(freq * 1.5, now + 0.04)

  gain.gain.setValueAtTime(0.1, now)
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05)

  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(now)
  osc.stop(now + 0.06)
}
