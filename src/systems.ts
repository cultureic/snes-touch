export type System = 'snes' | 'n64'

/** File extensions of every ROM the app can play. */
export const ROM_FILE = /\.(sfc|smc|fig|swc|z64|n64|v64)$/i

export const systemOf = (fileName: string): System => (/\.(z64|n64|v64)$/i.test(fileName) ? 'n64' : 'snes')

export const SYSTEM_NAMES: Record<System, string> = { snes: 'Super NES', n64: 'Nintendo 64' }
