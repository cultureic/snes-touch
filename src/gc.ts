import type { Button } from './controller'
import type { Machine } from './machine'

// GameCube through wasm-dolphin (github.com/dougchansan/wasm-dolphin, commit 7e38409, GPLv2+):
// Dolphin compiled to WebAssembly with a PowerPC-to-WASM JIT. Its page reads ~80 settings from
// its own URL and starts its workers relative to itself, so it runs unchanged from /gc in a
// same-origin frame and the app drives it through the globals it exposes (window.__host).
// Desktop Chrome only: it needs 1.5 GB of shared memory and 16 threads.

// The README's recommended settings, without metrics, and without its own gamepad polling,
// which would overwrite the input the app sends.
const PAGE =
  '/gc/?core=upstream&video=software&presenter=webgpu&cpu=dual&speed=1&wasmjit=1&jitwarmup=700&oc=1&pacing=tick&fastsw=1&nogamepad=1'
const BOOT_TIMEOUT = 60_000
const FAST_FORWARD_SPEED = 3

// its pad state's button bits (src/input.js)
const BITS: Partial<Record<Button, number>> = {
  a: 0,
  b: 1,
  x: 2,
  y: 3,
  start: 4,
  l: 5,
  r: 6,
  z: 7,
  up: 8,
  down: 9,
  left: 10,
  right: 11,
}
const CENTER = 0x80

interface PadInput {
  mask: number
  stickX: number
  stickY: number
  cStickX: number
  cStickY: number
  triggerLeft: number
  triggerRight: number
  analogA: number
  analogB: number
}

interface DolphinWindow extends Window {
  /** read by our patch to its worker adapter: memory card files to restore before the disc boots */
  __snesTouchUserFiles?: Record<string, Uint8Array>
  __host?: {
    setInputState(state: PadInput): void
    reset(): void
    adapter?: {
      request(name: string, payload: object): Promise<unknown>
      saveStateFile(): Promise<{ saved: boolean; bytes?: Uint8Array }>
      loadStateFile(bytes: Uint8Array): Promise<unknown>
    }
  }
  /** its audio output: an AudioWorklet feeding this gain node */
  __audio?: { context?: AudioContext; gain?: GainNode }
  DataTransfer: typeof DataTransfer
  Event: typeof Event
}

export interface GcLaunchOptions {
  canvas: HTMLCanvasElement
  file: File
  saveFiles?: Record<string, Uint8Array>
}

export class GcMachine implements Machine {
  readonly system = 'gc' as const
  readonly canSaveState = true
  readonly canFastForward = true
  readonly canReset = true
  readonly reloadOnExit = true
  private fastForward = false
  /** each player's pad, players 1-4 */
  private readonly inputs: PadInput[] = Array.from({ length: 4 }, () => ({
    mask: 0,
    stickX: CENTER,
    stickY: CENTER,
    cStickX: CENTER,
    cStickY: CENTER,
    triggerLeft: 0,
    triggerRight: 0,
    analogA: 0,
    analogB: 0,
  }))

  private constructor(
    private readonly placeholder: HTMLCanvasElement,
    private readonly frame: HTMLIFrameElement,
    private readonly page: DolphinWindow,
  ) {}

  /** Dolphin's own screen inside the frame (the page may swap the element, so look it up each time). */
  get canvas() {
    return this.page.document.querySelector<HTMLCanvasElement>('#screen') ?? this.placeholder
  }

  audioStream() {
    const audio = this.page.__audio
    if (!audio?.context || !audio.gain) return undefined
    const destination = audio.context.createMediaStreamDestination()
    audio.gain.connect(destination)
    return destination.stream
  }

  static async launch({ canvas, file, saveFiles }: GcLaunchOptions) {
    if (!crossOriginIsolated) throw new Error('GameCube games need a newer browser (this page is not cross-origin isolated)')
    if (/iPad|iPhone|iPod|Android/.test(navigator.userAgent)) throw new Error('GameCube games only run in Chrome on a computer for now')
    const frame = document.createElement('iframe')
    frame.className = 'gc-frame'
    frame.src = PAGE
    frame.tabIndex = -1 // keys go to the app, which sends them on as pad input
    frame.setAttribute('allow', 'autoplay; fullscreen; gamepad')
    canvas.hidden = true
    canvas.after(frame)
    await new Promise<void>((resolve, reject) => {
      frame.addEventListener('load', () => resolve(), { once: true })
      frame.addEventListener('error', () => reject(new Error("the GameCube emulator didn't load")), { once: true })
    })
    const page = frame.contentWindow as DolphinWindow
    showOnlyTheScreen(page.document)
    page.__snesTouchUserFiles = saveFiles
    await waitFor(() => !!page.__host, BOOT_TIMEOUT, "the GameCube emulator didn't start")
    // the page's own disc picker path: it applies the game's settings profile and turns sound on
    const input = page.document.querySelector<HTMLInputElement>('#romInput')
    if (!input) throw new Error('unexpected GameCube emulator page')
    const transfer = new page.DataTransfer()
    transfer.items.add(file)
    input.files = transfer.files
    input.dispatchEvent(new page.Event('change'))
    await waitFor(() => !!page.__host?.adapter, BOOT_TIMEOUT, "the GameCube emulator couldn't open the disc")
    return new GcMachine(canvas, frame, page)
  }

  press(button: Button, down: boolean, player = 1) {
    const bit = BITS[button]
    const input = this.inputs[player - 1]
    if (bit === undefined || !input) return
    input.mask = down ? input.mask | (1 << bit) : input.mask & ~(1 << bit)
    if (button === 'l') input.triggerLeft = down ? 0xff : 0
    if (button === 'r') input.triggerRight = down ? 0xff : 0
    if (button === 'a') input.analogA = down ? 0xff : 0
    if (button === 'b') input.analogB = down ? 0xff : 0
    this.send(player)
  }

  stick(x: number, y: number, player = 1, stick: 0 | 1 = 0) {
    const input = this.inputs[player - 1]
    if (!input) return
    // bytes centred on 0x80, with up the higher value
    const toByte = (value: number) => Math.max(0, Math.min(255, Math.round(CENTER + value * 127)))
    if (stick === 0) {
      input.stickX = toByte(x)
      input.stickY = toByte(-y)
    } else {
      input.cStickX = toByte(x)
      input.cStickY = toByte(-y)
    }
    this.send(player)
  }

  // The page's own pause only stops its main-thread loop; this one stops the core.
  pause() {
    void this.page.__host?.adapter?.request('validationSetCorePaused', { paused: true }).catch(() => undefined)
  }

  resume() {
    void this.page.__host?.adapter?.request('validationSetCorePaused', { paused: false }).catch(() => undefined)
    this.frame.blur()
  }

  reset() {
    this.page.__host?.reset()
  }

  toggleFastForward() {
    this.fastForward = !this.fastForward
    void this.page.__host?.adapter?.request('snesTouchSetSpeed', { speed: this.fastForward ? FAST_FORWARD_SPEED : 1 }).catch(() => undefined)
    return this.fastForward
  }

  /** The memory card's save files, copied out of Dolphin's user folder (our worker patch). */
  async saveFiles() {
    const result = (await this.page.__host?.adapter?.request('snesTouchExportUserFiles', {})) as { files?: Record<string, Uint8Array> } | undefined
    return result?.files ?? {}
  }

  // Save states work too, on top of the memory card.
  async saveState() {
    const result = await this.page.__host?.adapter?.saveStateFile()
    if (!result?.saved || !result.bytes) throw new Error("the emulator couldn't save a state")
    return { state: new Uint8Array(result.bytes) }
  }

  async loadState(state: Uint8Array) {
    return this.page.__host?.adapter?.loadStateFile(state)
  }

  saveSram() {
    return Promise.resolve(undefined)
  }

  exit() {
    this.frame.remove()
  }

  // Player 1 takes the port's own fast path; players 2-4 go through our worker patch.
  private send(player: number) {
    const state = { ...this.inputs[player - 1] }
    if (player === 1) this.page.__host?.setInputState(state)
    else void this.page.__host?.adapter?.request('snesTouchSetPortInput', { port: player - 1, state }).catch(() => undefined)
  }
}

// Only the game picture: the emulator page's own controls, panels and touch pad are hidden.
function showOnlyTheScreen(document: Document) {
  const style = document.createElement('style')
  style.textContent = `
    html, body { margin: 0 !important; background: #000 !important; overflow: hidden !important; }
    body * { visibility: hidden !important; }
    #screen { visibility: visible !important; position: fixed !important; inset: 0 !important;
      width: 100vw !important; height: 100vh !important; object-fit: contain; transform: none !important;
      z-index: 2147483647; }
  `
  document.head.append(style)
}

async function waitFor(check: () => boolean, ms: number, message: string) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
