import { createStore, delMany, get, set, update } from 'idb-keyval'

// Everything lives in IndexedDB on the device: ROMs, battery saves, save states.

export interface GameMeta {
  id: string
  name: string
  /** file name handed to the emulator; RetroArch names save files after it */
  fileName: string
  size: number
  addedAt: number
  playedAt?: number
}

export interface SavedState {
  state: Uint8Array
  savedAt: number
}

export type StateSlot = 'auto' | 'manual'

const store = createStore('snes-touch', 'data')

export async function listGames() {
  const games = (await get<GameMeta[]>('games', store)) ?? []
  return games.sort((a, b) => (b.playedAt ?? b.addedAt) - (a.playedAt ?? a.addedAt))
}

export async function addGame(game: GameMeta, rom: Uint8Array) {
  await set(`rom:${game.id}`, rom, store)
  await update<GameMeta[]>(
    'games',
    (games = []) => {
      const existing = games.find(({ id }) => id === game.id)
      return [{ ...game, addedAt: existing?.addedAt ?? game.addedAt, playedAt: existing?.playedAt }, ...games.filter(({ id }) => id !== game.id)]
    },
    store,
  )
}

export async function markPlayed(id: string) {
  await update<GameMeta[]>('games', (games = []) => games.map((game) => (game.id === id ? { ...game, playedAt: Date.now() } : game)), store)
}

export async function removeGame(id: string) {
  await delMany([`rom:${id}`, `sram:${id}`, `state:${id}:auto`, `state:${id}:manual`, `thumb:${id}`], store)
  await update<GameMeta[]>('games', (games = []) => games.filter((game) => game.id !== id), store)
}

export const getRom = (id: string) => get<Uint8Array>(`rom:${id}`, store)
export const getSram = (id: string) => get<Uint8Array>(`sram:${id}`, store)
export const putSram = (id: string, sram: Uint8Array) => set(`sram:${id}`, sram, store)
export const getState = (id: string, slot: StateSlot) => get<SavedState>(`state:${id}:${slot}`, store)
export const putState = (id: string, slot: StateSlot, state: SavedState) => set(`state:${id}:${slot}`, state, store)
/** ROM files a private build shipped that were already added, so removing one keeps it removed. */
export const getBundled = async () => (await get<string[]>('bundled', store)) ?? []
export const putBundled = (names: string[]) => set('bundled', names, store)
export const getThumbnail = (id: string) => get<Uint8Array>(`thumb:${id}`, store)
export const putThumbnail = (id: string, png: Uint8Array) => set(`thumb:${id}`, png, store)
