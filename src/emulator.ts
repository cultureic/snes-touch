import { unzipSync } from 'fflate'
import { Nostalgist } from 'nostalgist'
import { closeAudio } from './audio'
import type { Button } from './controller'

const CORE = 'snes9x'
// RetroArch has no keyboard bindings for player 2 by default, and Nostalgist presses buttons
// through them. Letters that neither player 1 nor Nostalgist's enabled hotkeys use.
const PLAYER_2_KEYS: Record<Button, string> = {
  up: 'i',
  down: 'k',
  left: 'j',
  right: 'l',
  a: 'n',
  b: 'b',
  x: 'h',
  y: 'g',
  l: 't',
  r: 'y',
  select: 'u',
  start: 'p',
}
// The same build Nostalgist 0.23 uses by default, fetched here so the download can
// report progress and be unzipped with fflate instead of a second CDN library.
const CORE_URL = `https://cdn.jsdelivr.net/gh/arianrhodsandlot/retroarch-emscripten-build@v1.22.2/retroarch/${CORE}_libretro.zip`

interface CoreFiles {
  js: Blob
  wasm: Blob
}

let core: Promise<CoreFiles> | undefined
const progressListeners = new Set<(fraction: number) => void>()

export function loadCore() {
  core ??= downloadCore().catch((error: unknown) => {
    core = undefined
    throw error
  })
  return core
}

export function onCoreProgress(listener: (fraction: number) => void) {
  progressListeners.add(listener)
  return () => {
    progressListeners.delete(listener)
  }
}

async function downloadCore(): Promise<CoreFiles> {
  const response = await fetch(CORE_URL)
  if (!response.ok || !response.body) throw new Error(`the emulator download failed (HTTP ${response.status})`)
  const total = Number(response.headers.get('content-length')) || 0
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    if (total) for (const listener of progressListeners) listener(Math.min(received / total, 1))
  }
  const zip = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    zip.set(chunk, offset)
    offset += chunk.length
  }
  const files = Object.entries(unzipSync(zip))
  const find = (extension: string) => files.find(([name]) => name.endsWith(extension))?.[1]
  const js = find('.js')
  const wasm = find('.wasm')
  if (!js || !wasm) throw new Error('the emulator download was incomplete')
  return { js: toBlob(js, 'text/javascript'), wasm: toBlob(wasm, 'application/wasm') }
}

export interface LaunchOptions {
  canvas: HTMLCanvasElement
  fileName: string
  rom: Uint8Array
  sram?: Uint8Array
  state?: Uint8Array
}

export class Emulator {
  // Saves are read back through RetroArch's virtual file system and Nostalgist polls for
  // each file, so file operations run one at a time.
  private queue: Promise<unknown> = Promise.resolve()
  private hasSram = true
  private fastForward = false

  private constructor(private readonly nostalgist: Nostalgist) {}

  // RetroArch sizes the canvas from its CSS box and follows that box when it changes
  // (rotation included), so the app never resizes the canvas itself.
  static async launch(options: LaunchOptions) {
    const { js, wasm } = await loadCore()
    const nostalgist = await Nostalgist.launch({
      core: CORE,
      element: options.canvas,
      rom: { fileName: options.fileName, fileContent: toBlob(options.rom) },
      sram: options.sram && toBlob(options.sram),
      state: options.state && toBlob(options.state),
      retroarchConfig: {
        video_smooth: false,
        video_font_enable: false, // the app shows its own messages
        video_gpu_screenshot: false, // native-resolution screenshots and thumbnails
        pause_nonactive: false, // the app pauses on its own when it is backgrounded
        fastforward_ratio: 3,
        ...Object.fromEntries(Object.entries(PLAYER_2_KEYS).map(([button, key]) => [`input_player2_${button}`, key])),
      },
      resolveCoreJs: () => js,
      resolveCoreWasm: () => wasm,
    })
    return new Emulator(nostalgist)
  }

  press(button: Button, down: boolean, player = 1) {
    if (down) this.nostalgist.pressDown({ button, player })
    else this.nostalgist.pressUp({ button, player })
  }

  pause() {
    this.nostalgist.pause()
  }

  resume() {
    this.nostalgist.resume()
  }

  reset() {
    this.nostalgist.restart()
  }

  toggleFastForward() {
    this.nostalgist.sendCommand('FAST_FORWARD')
    this.fastForward = !this.fastForward
    return this.fastForward
  }

  saveState() {
    return this.serial(async () => {
      const { state, thumbnail } = await withTimeout(this.nostalgist.saveState(), 10_000)
      return { state: await toBytes(state), thumbnail: thumbnail && (await toBytes(thumbnail)) }
    })
  }

  loadState(state: Uint8Array) {
    return this.serial(() => withTimeout(this.nostalgist.loadState(toBlob(state)), 10_000))
  }

  /** The cart's battery-backed save RAM, or undefined when the game has none. */
  saveSram() {
    return this.serial(async () => {
      if (!this.hasSram) return undefined
      try {
        return await toBytes(await withTimeout(this.nostalgist.saveSRAM(), 4000))
      } catch {
        // RetroArch never writes a save file for carts without battery RAM
        this.hasSram = false
        return undefined
      }
    })
  }

  exit() {
    this.nostalgist.exit()
    closeAudio()
  }

  private serial<T>(task: () => Promise<T>) {
    const result = this.queue.then(task)
    this.queue = result.catch(() => undefined)
    return result
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

const toBlob = (bytes: Uint8Array, type = 'application/octet-stream') =>
  new Blob([bytes as Uint8Array<ArrayBuffer>], { type })

const toBytes = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer())
