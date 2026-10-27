import { unzipSync } from 'fflate'
import { Nostalgist } from 'nostalgist'
import { closeAudio } from './audio'
import type { Button } from './controller'
import type { System } from './systems'

type CoreName = 'snes9x' | 'mupen64plus_next' | 'parallel_n64'

// RetroArch has no keyboard bindings for player 2 by default, and Nostalgist presses buttons
// through them. Letters that neither player 1 nor Nostalgist's enabled hotkeys use.
const PLAYER_2_KEYS: Partial<Record<Button, string>> = {
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
// The N64 cores come from EmulatorJS's builds, which take input straight from JavaScript
// (analog values included) as RetroPad ids. Their N64 layout: RetroPad B is A, Y is B, L2 is Z,
// the left stick is the stick and the right stick is the C buttons.
const N64_INPUT: Partial<Record<Button, number>> = {
  a: 0,
  b: 1,
  start: 3,
  up: 4,
  down: 5,
  left: 6,
  right: 7,
  l: 10,
  r: 11,
  z: 12,
  cr: 20,
  cl: 21,
  cd: 22,
  cu: 23,
}
const STICK = { right: 16, left: 17, down: 18, up: 19 }
const AXIS_MAX = 0x7fff
// snes9x is the same build Nostalgist 0.23 uses by default, fetched here so the download can
// report progress and be unzipped with fflate instead of a second CDN library. The N64 cores
// are EmulatorJS 4.2 builds (GPLv2, source: github.com/EmulatorJS/mupen64plus-libretro-nx and
// github.com/EmulatorJS/parallel-n64) served from /cores; the file names carry the version.
const CORE_URLS: Record<CoreName, string> = {
  snes9x: 'https://cdn.jsdelivr.net/gh/arianrhodsandlot/retroarch-emscripten-build@v1.22.2/retroarch/snes9x_libretro.zip',
  mupen64plus_next: '/cores/mupen64plus_next-ejs-2.0.2.zip',
  parallel_n64: '/cores/parallel_n64-ejs-2.0.2.zip',
}
const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

/** The core that runs a system on this device. */
export function coreFor(system: System): CoreName {
  if (system === 'snes') return 'snes9x'
  // EmulatorJS picks parallel_n64 on iPhones and iPads too: mupen64plus_next misbehaves in Safari there
  return ios ? 'parallel_n64' : 'mupen64plus_next'
}

interface CoreFiles {
  js: Blob
  wasm: Blob
}

const cores = new Map<CoreName, Promise<CoreFiles>>()
const progressListeners = new Set<(fraction: number) => void>()

export function loadCore(name: CoreName) {
  let core = cores.get(name)
  if (!core) {
    core = downloadCore(name).catch((error: unknown) => {
      cores.delete(name)
      throw error
    })
    cores.set(name, core)
  }
  return core
}

export function onCoreProgress(listener: (fraction: number) => void) {
  progressListeners.add(listener)
  return () => {
    progressListeners.delete(listener)
  }
}

async function downloadCore(name: CoreName): Promise<CoreFiles> {
  const response = await fetch(CORE_URLS[name])
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
  const find = (extension: string) => files.find(([file]) => file.endsWith(extension))?.[1]
  const js = find('.js')
  const wasm = find('.wasm')
  if (!js || !wasm) throw new Error('the emulator download was incomplete')
  const script = name === 'snes9x' ? js : patchEmulatorJsCore(name, new TextDecoder().decode(js))
  return { js: toBlob(script, 'text/javascript'), wasm: toBlob(wasm, 'application/wasm') }
}

// Nostalgist loads a core script as an ES module that defines `libretro_<core>`. EmulatorJS
// names its factory EJS_Runtime and finds itself through document.currentScript instead of
// import.meta.url, which is how Nostalgist tells a modular build apart.
function patchEmulatorJsCore(name: CoreName, js: string) {
  if (!js.includes('var EJS_Runtime')) throw new Error('unexpected emulator build')
  return `${js.replace('var EJS_Runtime', `var libretro_${name}`)}\n// import.meta.url\n`
}

export interface LaunchOptions {
  system: System
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

  private constructor(
    private readonly nostalgist: Nostalgist,
    readonly system: System,
  ) {}

  // RetroArch sizes the canvas from its CSS box and follows that box when it changes
  // (rotation included), so the app never resizes the canvas itself.
  static async launch(options: LaunchOptions) {
    const core = coreFor(options.system)
    const { js, wasm } = await loadCore(core)
    const nostalgist = await Nostalgist.launch({
      core,
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
      retroarchCoreConfig: options.system === 'n64' ? N64_OPTIONS : {},
      // EmulatorJS builds look up the canvas's container (for input and fullscreen) as Module.parent
      emscriptenModule: { parent: options.canvas.parentElement } as object,
      resolveCoreJs: () => js,
      resolveCoreWasm: () => wasm,
    })
    return new Emulator(nostalgist, options.system)
  }

  press(button: Button, down: boolean, player = 1) {
    if (this.system === 'n64') {
      const id = N64_INPUT[button]
      if (id !== undefined) this.input(player, id, down ? (id >= 16 ? AXIS_MAX : 1) : 0)
    } else if (down) this.nostalgist.pressDown({ button, player })
    else this.nostalgist.pressUp({ button, player })
  }

  /** The analog stick, x and y from -1 to 1 (y points down). Only the N64 has one. */
  stick(x: number, y: number, player = 1) {
    if (this.system !== 'n64') return
    this.input(player, STICK.right, Math.max(x, 0) * AXIS_MAX)
    this.input(player, STICK.left, Math.max(-x, 0) * AXIS_MAX)
    this.input(player, STICK.down, Math.max(y, 0) * AXIS_MAX)
    this.input(player, STICK.up, Math.max(-y, 0) * AXIS_MAX)
  }

  private input(player: number, id: number, value: number) {
    const module = this.nostalgist.getEmscriptenModule() as { _simulate_input?: (player: number, id: number, value: number) => void }
    module._simulate_input?.(player - 1, id, Math.round(value))
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

// mupen64plus_next and parallel_n64 option names; both take the fast choices for phones.
const N64_OPTIONS = {
  'mupen64plus-rdp-plugin': 'gliden64',
  'mupen64plus-rsp-plugin': 'hle',
  'mupen64plus-43screensize': '320x240',
  'mupen64plus-cpucore': 'cached_interpreter',
  'mupen64plus-pak1': 'memory',
  'mupen64plus-pak2': 'memory',
  'parallel-n64-gfxplugin': 'auto',
  'parallel-n64-screensize': '320x240',
  'parallel-n64-pak1': 'memory',
  'parallel-n64-pak2': 'memory',
}

function withTimeout<T>(promise: Promise<T>, ms: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

const toBlob = (data: Uint8Array | string, type = 'application/octet-stream') =>
  new Blob([data as Uint8Array<ArrayBuffer> | string], { type })

const toBytes = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer())
