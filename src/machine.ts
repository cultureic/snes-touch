import type { Button } from './controller'
import type { System } from './systems'

/**
 * What the app needs from an emulator. SNES and N64 run in RetroArch through Nostalgist
 * (emulator.ts); PS2 runs in Play! (ps2.ts) and GameCube in Dolphin (gc.ts), which each have
 * their own, smaller set of features.
 */
export interface Machine {
  readonly system: System
  /** the canvas the game draws on, for streaming it to other players */
  readonly canvas: HTMLCanvasElement
  readonly canSaveState: boolean
  readonly canFastForward: boolean
  readonly canReset: boolean
  /** Leaving tears the page down instead of exiting in place (threaded emulators can't be stopped cleanly). */
  readonly reloadOnExit: boolean
  press(button: Button, down: boolean, player?: number): void
  /** An analog stick, x and y from -1 to 1 (y points down); stick 1 is the right stick. */
  stick(x: number, y: number, player?: number, stick?: 0 | 1): void
  pause(): void
  resume(): void
  reset(): void
  toggleFastForward(): boolean
  saveState(): Promise<{ state: Uint8Array; thumbnail?: Uint8Array }>
  loadState(state: Uint8Array): Promise<unknown>
  /** The cartridge's battery save, or undefined when it has none (disc systems never do). */
  saveSram(): Promise<Uint8Array | undefined>
  /** Disc systems: the files the emulator saved (memory cards and the like), by path. */
  saveFiles?(): Promise<Record<string, Uint8Array>>
  /** The game's sound as a stream, for emulators whose audio the app doesn't tap itself. */
  audioStream?(): MediaStream | undefined
  exit(): void
}
