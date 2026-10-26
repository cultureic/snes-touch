import { unzipSync } from 'fflate'

const ROM_FILE = /\.(sfc|smc|fig|swc)$/i

export interface Rom {
  name: string
  fileName: string
  bytes: Uint8Array
}

/** Every SNES ROM in the file: the file itself, or each one inside a zip. */
export async function readRoms(file: File): Promise<Rom[]> {
  const data = new Uint8Array(await file.arrayBuffer())
  if (isZip(data)) {
    const entries = Object.entries(unzipSync(data, { filter: (entry) => ROM_FILE.test(entry.name) }))
    const roms = entries.filter(([, bytes]) => bytes.length >= MIN_SIZE).map(([path, bytes]) => toRom(path, bytes))
    if (roms.length === 0) throw new Error(`${file.name} has no SNES ROM inside.`)
    return roms
  }
  // No `accept` filter on the picker (iOS greys out unknown types), so check here.
  if (!ROM_FILE.test(file.name)) throw new Error(`${file.name} isn't a SNES ROM (.sfc, .smc, .fig or .zip).`)
  if (data.length < MIN_SIZE) throw new Error(`${file.name} is too small to be a SNES ROM.`)
  return [toRom(file.name, data)]
}

const MIN_SIZE = 0x8000

function toRom(path: string, bytes: Uint8Array): Rom {
  const file = path.split('/').pop() ?? path
  const extension = (file.match(ROM_FILE)?.[0] ?? '.sfc').toLowerCase()
  const name = file.replace(ROM_FILE, '').trim() || 'Untitled'
  // RetroArch names save files after the ROM, so keep it to plain characters.
  const safe = name.replace(/[^\w .()[\]-]+/g, '').trim().slice(0, 80) || 'game'
  return { name, fileName: safe + extension, bytes }
}

export async function romId(bytes: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes as Uint8Array<ArrayBuffer>))
  return Array.from(digest.subarray(0, 10), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const isZip = (data: Uint8Array) => data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04
