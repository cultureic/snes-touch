import type { Machine } from './machine'
import type { System } from './systems'

/** Starts a PS2 or GameCube disc; each emulator loads only when its first game does. */
export async function launchDisc(system: System, canvas: HTMLCanvasElement, file: File, saveFiles?: Record<string, Uint8Array>): Promise<Machine> {
  if (system === 'ps2') {
    const { Ps2Machine } = await import('./ps2')
    return Ps2Machine.launch({ canvas, file, saveFiles })
  }
  if (system === 'gc') {
    const { GcMachine } = await import('./gc')
    return GcMachine.launch({ canvas, file, saveFiles })
  }
  throw new Error(`${system} games aren't discs`)
}
