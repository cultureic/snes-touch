export type System = 'snes' | 'n64' | 'ps2' | 'gc'

/** File extensions of every cartridge ROM the app can play (read whole into the library). */
export const ROM_FILE = /\.(sfc|smc|fig|swc|z64|n64|v64)$/i

/** Disc images: too big to copy into the library, so the app keeps a handle to the file instead. */
export const DISC_FILE = /\.(iso|gcm|rvz|ciso|gcz|chd|cso|isz|elf)$/i

export const systemOf = (fileName: string): System => (/\.(z64|n64|v64)$/i.test(fileName) ? 'n64' : 'snes')

export const SYSTEM_NAMES: Record<System, string> = { snes: 'Super NES', n64: 'Nintendo 64', ps2: 'PlayStation 2', gc: 'GameCube' }
export const SHORT_NAMES: Record<System, string> = { snes: 'SNES', n64: 'N64', ps2: 'PS2', gc: 'GameCube' }

/**
 * Which console a disc image is for, from its header: GameCube discs carry a magic word at
 * 0x1C (Wii ones at 0x18), compressed Dolphin formats start with their own tags, and PS2 discs
 * are ISO 9660 ("CD001" at 0x8001). An .elf is a PS2 program.
 */
export async function detectDisc(file: Blob & { name: string }): Promise<System | undefined> {
  if (/\.elf$/i.test(file.name)) return 'ps2'
  if (/\.(gcm|rvz|ciso|gcz)$/i.test(file.name)) return 'gc'
  if (/\.(chd|cso|isz)$/i.test(file.name)) return 'ps2'
  const head = new Uint8Array(await file.slice(0, 0x8010).arrayBuffer())
  const view = new DataView(head.buffer)
  if (head.length >= 0x20 && (view.getUint32(0x1c) === 0xc2339f3d || view.getUint32(0x18) === 0x5d1c9ea3)) return 'gc'
  const tag = String.fromCharCode(...head.subarray(0, 4))
  if (tag === 'RVZ\x01' || tag === 'WIA\x01' || tag === 'CISO') return 'gc'
  if (String.fromCharCode(...head.subarray(0x8001, 0x8006)) === 'CD001') return 'ps2'
  return undefined
}
