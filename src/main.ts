import './style.css'
import { trackAudioContexts, unlockAudio } from './audio'
import { TouchController } from './controller'
import { Emulator, loadCore, onCoreProgress } from './emulator'
import { setHapticsEnabled } from './haptics'
import { readRoms, romId } from './rom'
import * as db from './storage'

trackAudioContexts()

const TEST_GAME: db.GameMeta = { id: 'controller-test', name: 'Controller test', fileName: 'controller-test.sfc', size: 0, addedAt: 0 }
const SRAM_EVERY = 15_000
const AUTOSAVE_EVERY = 60_000
const HAPTICS_KEY = 'snes-touch:haptics'
const debug = new URLSearchParams(location.search).has('debug')

function element<T extends HTMLElement = HTMLElement>(id: string) {
  const node = document.getElementById(id)
  if (!node) throw new Error(`#${id} is missing`)
  return node as T
}

const ui = {
  library: element('library'),
  romInput: element<HTMLInputElement>('rom-input'),
  testButton: element<HTMLButtonElement>('test-button'),
  games: element<HTMLUListElement>('games'),
  gamesEmpty: element('games-empty'),
  iosTip: element('ios-tip'),
  installButton: element<HTMLButtonElement>('install-button'),
  player: element('player'),
  screen: element('screen'),
  status: element('status'),
  statusText: element('status-text'),
  statusBack: element<HTMLButtonElement>('status-back'),
  title: element('game-title'),
  menuButton: element<HTMLButtonElement>('menu-button'),
  ffButton: element<HTMLButtonElement>('ff-button'),
  pad: element('pad'),
  menu: element<HTMLDialogElement>('menu'),
  menuTitle: element('menu-title'),
  resumeButton: element<HTMLButtonElement>('resume-button'),
  saveButton: element<HTMLButtonElement>('save-button'),
  loadButton: element<HTMLButtonElement>('load-button'),
  saveInfo: element('save-info'),
  resetButton: element<HTMLButtonElement>('reset-button'),
  fullscreenButton: element<HTMLButtonElement>('fullscreen-button'),
  hapticsToggle: element<HTMLInputElement>('haptics-toggle'),
  quitButton: element<HTMLButtonElement>('quit-button'),
  toast: element('toast'),
}

interface Session {
  game: db.GameMeta
  canvas: HTMLCanvasElement
  emulator?: Emulator
  timers: number[]
  lastSram?: Uint8Array
  quitting?: boolean
}

let session: Session | undefined

const controller = new TouchController(ui.pad, (button, down) => session?.emulator?.press(button, down))

// ------------------------------------------------------------ library

let thumbnailUrls: string[] = []
let renderToken = 0

async function renderLibrary() {
  const token = ++renderToken
  const urls: string[] = []
  const games = await db.listGames()
  const items = await Promise.all(games.map((game) => renderGame(game, urls)))
  const stale = token === renderToken ? thumbnailUrls : urls // a newer render won
  for (const url of stale) URL.revokeObjectURL(url)
  if (token !== renderToken) return
  thumbnailUrls = urls
  ui.games.replaceChildren(...items)
  ui.gamesEmpty.hidden = games.length > 0
}

async function renderGame(game: db.GameMeta, urls: string[]) {
  const item = document.createElement('li')
  item.className = 'game'

  const play = document.createElement('button')
  play.type = 'button'
  play.className = 'game-play'
  play.addEventListener('click', () => void openGame(game))

  const art = document.createElement('div')
  art.className = 'game-art'
  const png = await db.getThumbnail(game.id)
  if (png) {
    const url = URL.createObjectURL(new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }))
    urls.push(url)
    const image = new Image()
    image.src = url
    image.alt = ''
    art.append(image)
  } else {
    art.textContent = initials(game.name)
  }

  const text = document.createElement('div')
  text.className = 'game-text'
  const name = document.createElement('span')
  name.className = 'game-name'
  name.textContent = game.name
  const meta = document.createElement('span')
  meta.className = 'game-meta'
  meta.textContent = `${game.playedAt ? `Played ${timeAgo(game.playedAt)}` : 'Not played yet'} · ${formatSize(game.size)}`
  text.append(name, meta)
  play.append(art, text)

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'game-remove'
  remove.setAttribute('aria-label', `Remove ${game.name}`)
  remove.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>'
  remove.addEventListener('click', async () => {
    if (!confirm(`Remove “${game.name}” and its saves from this device?`)) return
    await db.removeGame(game.id)
    void renderLibrary()
  })

  item.append(play, remove)
  return item
}

async function openGame(game: db.GameMeta) {
  const rom = await db.getRom(game.id)
  if (!rom) {
    toast('This ROM is missing. Load it again.')
    return
  }
  void play(game, rom)
}

interface AddResult {
  added: number
  skipped: string[]
  first?: { game: db.GameMeta; rom: Uint8Array }
}

async function addRoms(files: File[]) {
  const result: AddResult = { added: 0, skipped: [] }
  for (const file of files) {
    try {
      for (const rom of await readRoms(file)) {
        const game: db.GameMeta = {
          id: await romId(rom.bytes),
          name: rom.name,
          fileName: rom.fileName,
          size: rom.bytes.length,
          addedAt: Date.now(),
        }
        await db.addGame(game, rom.bytes)
        result.first ??= { game, rom: rom.bytes }
        result.added++
      }
    } catch (error) {
      result.skipped.push(errorMessage(error))
    }
  }
  if (result.added > 0) void navigator.storage?.persist?.() // ask the browser not to evict saved games
  return result
}

// One ROM starts right away; a batch (several files, or a zip of games) fills the library.
async function importFiles(files: File[]) {
  if (files.length === 0) return
  const { added, skipped, first } = await addRoms(files)
  await renderLibrary()
  if (first && added === 1 && skipped.length === 0) void play(first.game, first.rom)
  else if (added === 0) toast(skipped.length === 1 ? skipped[0] : `No SNES ROMs in those ${skipped.length} files`)
  else toast(`Added ${count(added, 'game')}${skipped.length ? `, skipped ${count(skipped.length, 'file')}` : ''}`)
}

// Private builds (scripts/deploy-private.sh) ship ROMs in /roms with an index.json;
// add each one to the library the first time this device sees it. The public site has none.
async function addBundledGames() {
  try {
    const index = await fetch('/roms/index.json', { cache: 'no-cache' })
    if (!index.ok) return
    const names = ((await index.json()) as unknown[]).filter((name): name is string => typeof name === 'string')
    const seen = new Set(await db.getBundled())
    const fresh = names.filter((name) => !seen.has(name))
    if (fresh.length === 0) return
    toast(`Adding ${count(fresh.length, 'game')} from this build…`)
    let added = 0
    for (const name of fresh) {
      const response = await fetch(`/roms/${encodeURIComponent(name)}`)
      if (!response.ok) continue
      added += (await addRoms([new File([await response.blob()], name)])).added
      seen.add(name)
    }
    await db.putBundled([...seen])
    await renderLibrary()
    toast(`Added ${count(added, 'game')} from this build`)
  } catch {
    // offline or not a private build: try again next visit
  }
}

ui.romInput.addEventListener('change', () => {
  const files = Array.from(ui.romInput.files ?? [])
  ui.romInput.value = ''
  void importFiles(files)
})

// Desktop: drop ROM files anywhere on the library.
document.addEventListener('dragover', (event) => {
  if (session || !event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  document.body.classList.add('is-dropping')
})
document.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) document.body.classList.remove('is-dropping')
})
document.addEventListener('drop', (event) => {
  document.body.classList.remove('is-dropping')
  if (session || !event.dataTransfer?.files.length) return
  event.preventDefault()
  void importFiles(Array.from(event.dataTransfer.files))
})

ui.testButton.addEventListener('click', async () => {
  try {
    const response = await fetch('/controller-test.sfc')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const rom = new Uint8Array(await response.arrayBuffer())
    void play({ ...TEST_GAME, size: rom.length }, rom)
  } catch (error) {
    toast(`Couldn't load the test ROM: ${errorMessage(error)}`)
  }
})

// ------------------------------------------------------------ playing

async function play(game: db.GameMeta, rom: Uint8Array) {
  if (session) return
  const canvas = document.createElement('canvas')
  ui.screen.prepend(canvas)
  const current: Session = { game, canvas, timers: [] }
  session = current
  showPlayer(game)
  setStatus('Loading emulator…')
  const stopProgress = onCoreProgress((fraction) => setStatus(`Downloading emulator… ${Math.round(fraction * 100)}%`))
  try {
    const [sram, autosave] = await Promise.all([db.getSram(game.id), db.getState(game.id, 'auto'), loadCore()])
    stopProgress()
    if (session !== current) return
    setStatus('Starting game…')
    const emulator = await Emulator.launch({
      canvas,
      fileName: game.fileName,
      rom,
      sram,
      state: autosave?.state,
    })
    if (session !== current) {
      emulator.exit()
      return
    }
    current.emulator = emulator
    current.lastSram = sram
    setStatus()
    if (autosave) toast('Resumed where you left off')
    current.timers.push(
      window.setInterval(() => void saveSram(current), SRAM_EVERY),
      window.setInterval(() => {
        if (document.visibilityState === 'visible' && !ui.menu.open) void saveAutosave(current)
      }, AUTOSAVE_EVERY),
    )
    void db.markPlayed(game.id)
  } catch (error) {
    stopProgress()
    if (session === current) setStatus(`Couldn't start the game: ${errorMessage(error)}`, true)
  }
}

async function saveSram(current: Session) {
  const sram = await current.emulator?.saveSram().catch(() => undefined)
  if (!sram || (current.lastSram && sameBytes(sram, current.lastSram))) return
  current.lastSram = sram
  await db.putSram(current.game.id, sram)
}

async function saveAutosave(current: Session) {
  const saved = await current.emulator?.saveState().catch(() => undefined)
  if (!saved) return
  await db.putState(current.game.id, 'auto', { state: saved.state, savedAt: Date.now() })
  if (saved.thumbnail) await db.putThumbnail(current.game.id, saved.thumbnail)
}

async function quit(reason: string) {
  const current = session
  if (!current || current.quitting) return
  current.quitting = true
  if (debug) console.info('[snes-touch] quit:', reason)
  if (ui.menu.open) ui.menu.close()
  controller.releaseAll()
  for (const timer of current.timers) clearInterval(timer)
  if (current.emulator) {
    setStatus('Saving…')
    current.emulator.resume()
    await Promise.all([saveSram(current), saveAutosave(current)])
    current.emulator.exit()
  }
  current.canvas.remove()
  session = undefined
  setStatus()
  showLibrary()
  if (history.state?.player) history.back()
  void renderLibrary()
}

function showPlayer(game: db.GameMeta) {
  ui.title.textContent = game.name
  ui.menuTitle.textContent = game.name
  ui.ffButton.setAttribute('aria-pressed', 'false')
  ui.library.hidden = true
  ui.player.hidden = false
  document.body.classList.add('playing')
  history.pushState({ player: true }, '')
}

function showLibrary() {
  ui.player.hidden = true
  ui.library.hidden = false
  document.body.classList.remove('playing')
}

function setStatus(text?: string, isError = false) {
  ui.status.hidden = !text
  ui.statusText.textContent = text ?? ''
  ui.status.classList.toggle('is-error', isError)
  ui.statusBack.hidden = !isError
}

ui.statusBack.addEventListener('click', () => void quit('status back button'))

ui.ffButton.addEventListener('click', () => {
  const on = session?.emulator?.toggleFastForward()
  if (on !== undefined) ui.ffButton.setAttribute('aria-pressed', String(on))
})

// The system back gesture leaves the game (it is saved on the way out).
window.addEventListener('popstate', () => void quit('history back'))
if (history.state?.player) history.replaceState(null, '')

// ------------------------------------------------------------ pause menu

async function openMenu() {
  const current = session
  if (!current?.emulator || current.quitting || ui.menu.open) return
  controller.releaseAll()
  current.emulator.pause()
  ui.menu.showModal()
  ui.resumeButton.focus()
  await refreshSaveInfo(current)
}

let savingState = false

async function refreshSaveInfo(current: Session) {
  const saved = await db.getState(current.game.id, 'manual')
  if (savingState) return // a save started while this was loading; it sets the label itself
  ui.loadButton.disabled = !saved
  ui.saveInfo.textContent = saved ? `Saved state from ${timeAgo(saved.savedAt)}` : 'No saved state yet'
}

ui.menuButton.addEventListener('click', () => void openMenu())
ui.menu.addEventListener('close', () => {
  if (session && !session.quitting) session.emulator?.resume()
})
// tapping the backdrop resumes (the dialog's own padding also targets the dialog)
ui.menu.addEventListener('click', (event) => {
  if (event.target !== ui.menu) return
  const box = ui.menu.getBoundingClientRect()
  const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom
  if (!inside) ui.menu.close()
})
ui.resumeButton.addEventListener('click', () => ui.menu.close())

ui.saveButton.addEventListener('click', async () => {
  const current = session
  if (!current?.emulator) return
  savingState = true
  ui.saveButton.disabled = true
  ui.saveInfo.textContent = 'Saving…'
  try {
    const { state } = await current.emulator.saveState()
    await db.putState(current.game.id, 'manual', { state, savedAt: Date.now() })
    ui.loadButton.disabled = false
    ui.saveInfo.textContent = 'State saved'
  } catch (error) {
    ui.saveInfo.textContent = `Save failed: ${errorMessage(error)}`
  } finally {
    savingState = false
    ui.saveButton.disabled = false
  }
})

ui.loadButton.addEventListener('click', async () => {
  const current = session
  const saved = current && (await db.getState(current.game.id, 'manual'))
  if (!current?.emulator || !saved) return
  try {
    await current.emulator.loadState(saved.state)
    ui.menu.close()
    toast('State loaded')
  } catch (error) {
    ui.saveInfo.textContent = `Load failed: ${errorMessage(error)}`
  }
})

ui.resetButton.addEventListener('click', () => {
  session?.emulator?.reset()
  ui.menu.close()
  toast('Game restarted')
})

ui.fullscreenButton.hidden = !document.fullscreenEnabled
ui.fullscreenButton.addEventListener('click', async () => {
  ui.menu.close()
  if (document.fullscreenElement) await document.exitFullscreen()
  else await document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined)
})

ui.quitButton.addEventListener('click', () => void quit('menu quit button'))

setHapticsEnabled(readSetting(HAPTICS_KEY) !== 'off')
ui.hapticsToggle.checked = readSetting(HAPTICS_KEY) !== 'off'
ui.hapticsToggle.addEventListener('change', () => {
  setHapticsEnabled(ui.hapticsToggle.checked)
  writeSetting(HAPTICS_KEY, ui.hapticsToggle.checked ? 'on' : 'off')
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && session && !ui.menu.open) void openMenu()
})

// Leaving the app: release held buttons, keep the save RAM, and come back paused.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden' || !session?.emulator || session.quitting) return
  controller.releaseAll()
  void saveSram(session)
  void openMenu()
})
window.addEventListener('pagehide', () => {
  if (session?.emulator) void saveSram(session)
})

// ------------------------------------------------------------ page setup

for (const type of ['pointerdown', 'pointerup', 'touchend', 'keydown']) {
  document.addEventListener(type, unlockAudio, { capture: true, passive: true })
}
document.addEventListener('gesturestart', (event) => event.preventDefault()) // iOS pinch zoom
document.addEventListener('dblclick', (event) => event.preventDefault())

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
}
let installPrompt: InstallPromptEvent | undefined
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault()
  installPrompt = event as InstallPromptEvent
  ui.installButton.hidden = false
})
ui.installButton.addEventListener('click', async () => {
  await installPrompt?.prompt()
  installPrompt = undefined
  ui.installButton.hidden = true
})

const standalone =
  matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone === true
const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
ui.iosTip.hidden = !ios || standalone

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined)
}

if (debug) {
  Object.assign(window, { snesTouch: { get emulator() { return session?.emulator }, controller, addBundledGames } })
}

void renderLibrary().then(addBundledGames)
// warm the cache so the first game starts faster
window.setTimeout(() => void loadCore().catch(() => undefined), 1500)

// ------------------------------------------------------------ helpers

let toastTimer = 0
function toast(message: string) {
  ui.toast.textContent = message
  ui.toast.classList.add('is-visible')
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => ui.toast.classList.remove('is-visible'), 2600)
}

function readSetting(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeSetting(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // private browsing: the setting lasts for this visit only
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function initials(name: string) {
  const words = name.replace(/\(.*?\)|\[.*?\]/g, '').split(/\s+/).filter(Boolean)
  return words.slice(0, 2).map((word) => word[0].toUpperCase()).join('') || '?'
}

function count(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

function formatSize(bytes: number) {
  return bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
}

function timeAgo(time: number) {
  const minutes = Math.round((Date.now() - time) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}
