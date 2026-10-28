import type { Button } from './controller'
import type { Machine } from './machine'

// PlayStation 2 through Play! (github.com/jpd002/Play-, BSD-2-Clause), the build its own web
// version serves, kept in /cores with its licence. It runs on threads, so the page has to be
// cross-origin isolated (vercel.json). Play! reads the disc itself, in slices, straight from the
// File, so a 4 GB image never has to fit in memory.

const BASE = '/cores/play-2026-10-26/'
// Play! only takes input as key presses on its canvas, with these keys for pad 1.
const KEYS: Partial<Record<Button, string>> = {
  b: 'KeyZ', // cross (bottom)
  a: 'KeyX', // circle (right)
  y: 'KeyA', // square (left)
  x: 'KeyS', // triangle (top)
  // Play! names the digit keys "Key1" and so on, not the browser's "Digit1"
  l: 'Key1',
  l2: 'Key2',
  l3: 'Key3',
  r: 'Key8',
  r2: 'Key9',
  r3: 'Key0',
  select: 'Backspace',
  start: 'Enter',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
}
// Its sticks are keys too (each direction is all or nothing): left stick, then right stick.
const STICK_KEYS = [
  { left: 'KeyF', right: 'KeyH', up: 'KeyT', down: 'KeyG' },
  { left: 'KeyJ', right: 'KeyL', up: 'KeyI', down: 'KeyK' },
]
const STICK_THRESHOLD = 0.5
// where Play! keeps memory cards and settings in its virtual file system
const SAVE_ROOT = '/home/web_user'

interface PlayModule {
  FS: EmscriptenFileSystem
  HEAPU8: Uint8Array
  ccall(name: string, returnType: string, argTypes: string[], args: unknown[]): unknown
  bootDiscImage(path: string): void
  bootElf(path: string): void
  discImageDevice: DiscImageDevice
}

interface EmscriptenFileSystem {
  mkdir(path: string): void
  mkdirTree?(path: string): void
  writeFile(path: string, data: Uint8Array): void
  readFile(path: string): Uint8Array
  readdir(path: string): string[]
  stat(path: string): { mode: number }
  isDir(mode: number): boolean
  analyzePath(path: string): { exists: boolean }
}

/** The disc reader Play! calls from its own code: it asks for a slice, then polls isDone. */
class DiscImageDevice {
  private done = false

  constructor(
    private readonly module: PlayModule,
    private readonly file: Blob,
  ) {}

  read(destination: number, offset: number, size: number) {
    this.done = false
    void this.file
      .slice(offset, offset + size)
      .arrayBuffer()
      .then((bytes) => {
        this.module.HEAPU8.set(new Uint8Array(bytes), destination)
        this.done = true
      })
  }

  getFileSize() {
    return this.file.size
  }

  isDone() {
    return this.done
  }
}

export interface Ps2LaunchOptions {
  canvas: HTMLCanvasElement
  file: File
  saveFiles?: Record<string, Uint8Array>
}

export class Ps2Machine implements Machine {
  readonly system = 'ps2' as const
  readonly canSaveState = false
  readonly canFastForward = false
  readonly canReset = false
  readonly reloadOnExit = true
  private readonly held = new Set<string>()

  private constructor(
    readonly canvas: HTMLCanvasElement,
    readonly module: PlayModule,
  ) {}

  static async launch({ canvas, file, saveFiles }: Ps2LaunchOptions) {
    if (!crossOriginIsolated) throw new Error('PS2 games need a newer browser (this page is not cross-origin isolated)')
    // initVm looks the canvas up by this id; the size is the one Play! presents at
    canvas.id = 'outputCanvas'
    canvas.width = 640
    canvas.height = 480
    canvas.tabIndex = -1
    const { default: Play } = (await import(/* @vite-ignore */ `${BASE}Play.js`)) as {
      default: (overrides: object) => Promise<PlayModule>
    }
    const module = await Play({ locateFile: (path: string) => BASE + path, mainScriptUrlOrBlob: `${BASE}Play.js` })
    for (const [path, data] of Object.entries(saveFiles ?? {})) {
      mkdirs(module.FS, path.slice(0, path.lastIndexOf('/')))
      module.FS.writeFile(path, data)
    }
    module.FS.mkdir('/work')
    module.discImageDevice = new DiscImageDevice(module, file)
    module.ccall('initVm', '', [], [])
    const name = file.name.replace(/[^\w.-]+/g, '_')
    if (/\.elf$/i.test(name)) {
      module.FS.writeFile(name, new Uint8Array(await file.arrayBuffer()))
      module.bootElf(name)
    } else module.bootDiscImage(name)
    return new Ps2Machine(canvas, module)
  }

  press(button: Button, down: boolean, player = 1) {
    const code = KEYS[button]
    if (code && player === 1) this.key(code, down)
  }

  stick(x: number, y: number, player = 1, stick: 0 | 1 = 0) {
    if (player !== 1) return
    const keys = STICK_KEYS[stick]
    this.key(keys.left, x < -STICK_THRESHOLD)
    this.key(keys.right, x > STICK_THRESHOLD)
    this.key(keys.up, y < -STICK_THRESHOLD)
    this.key(keys.down, y > STICK_THRESHOLD)
  }

  // Play! has no pause or reset of its own on the web; the menu says so.
  pause() {}
  resume() {}
  reset() {}

  toggleFastForward() {
    return false
  }

  saveState(): Promise<{ state: Uint8Array }> {
    return Promise.reject(new Error("PS2 games can't save states yet"))
  }

  loadState(): Promise<unknown> {
    return Promise.reject(new Error("PS2 games can't load states yet"))
  }

  saveSram() {
    return Promise.resolve(undefined)
  }

  /** Memory cards and anything else Play! wrote, to restore on the next launch. */
  saveFiles() {
    const files: Record<string, Uint8Array> = {}
    collect(this.module.FS, SAVE_ROOT, files)
    return Promise.resolve(files)
  }

  exit() {}

  private key(code: string, down: boolean) {
    if (down === this.held.has(code)) return
    if (down) this.held.add(code)
    else this.held.delete(code)
    this.canvas.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code, bubbles: true }))
  }
}

function mkdirs(fs: EmscriptenFileSystem, path: string) {
  let current = ''
  for (const part of path.split('/').filter(Boolean)) {
    current += `/${part}`
    if (!fs.analyzePath(current).exists) fs.mkdir(current)
  }
}

function collect(fs: EmscriptenFileSystem, path: string, files: Record<string, Uint8Array>) {
  if (!fs.analyzePath(path).exists) return
  for (const name of fs.readdir(path)) {
    if (name === '.' || name === '..') continue
    const child = `${path}/${name}`
    if (fs.isDir(fs.stat(child).mode)) collect(fs, child, files)
    else files[child] = fs.readFile(child)
  }
}
