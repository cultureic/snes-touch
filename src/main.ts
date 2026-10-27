import './style.css'
import { gameAudioStream, trackAudioContexts, unlockAudio } from './audio'
import { type Button, TouchController } from './controller'
import { coreFor, Emulator, loadCore, onCoreProgress } from './emulator'
import { Gamepads } from './gamepads'
import { UsbPads } from './usbpads'
import { setHapticsEnabled } from './haptics'
import {
  diffButtons,
  GuestLink,
  HostRoom,
  inviteLink,
  maxPlayers,
  newRoomCode,
  NO_INPUT,
  normalizeCode,
  type PadState,
  type Seat,
} from './netplay'
import { readRoms, romId } from './rom'
import * as db from './storage'
import { type System, systemOf } from './systems'

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
  joinButton: element<HTMLButtonElement>('join-button'),
  usbButton: element<HTMLButtonElement>('usb-button'),
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
  p2Badge: element('p2-badge'),
  menuButton: element<HTMLButtonElement>('menu-button'),
  ffButton: element<HTMLButtonElement>('ff-button'),
  pad: element('pad'),
  menu: element<HTMLDialogElement>('menu'),
  menuTitle: element('menu-title'),
  resumeButton: element<HTMLButtonElement>('resume-button'),
  hostTools: element('host-tools'),
  saveButton: element<HTMLButtonElement>('save-button'),
  loadButton: element<HTMLButtonElement>('load-button'),
  saveInfo: element('save-info'),
  resetButton: element<HTMLButtonElement>('reset-button'),
  inviteButton: element<HTMLButtonElement>('invite-button'),
  inviteLabel: element('invite-label'),
  inviteError: element('invite-error'),
  inviteRoom: element('invite-room'),
  inviteCode: element('invite-code'),
  inviteLink: element('invite-link'),
  inviteStatus: element('invite-status'),
  inviteShare: element<HTMLButtonElement>('invite-share'),
  inviteStop: element<HTMLButtonElement>('invite-stop'),
  fullscreenButton: element<HTMLButtonElement>('fullscreen-button'),
  hapticsToggle: element<HTMLInputElement>('haptics-toggle'),
  quitButton: element<HTMLButtonElement>('quit-button'),
  joinDialog: element<HTMLDialogElement>('join-dialog'),
  joinCode: element<HTMLInputElement>('join-code'),
  joinGo: element<HTMLButtonElement>('join-go'),
  joinCancel: element<HTMLButtonElement>('join-cancel'),
  toast: element('toast'),
}

/** A game running on this device, possibly hosting a room for other players. */
interface Session {
  game: db.GameMeta
  system: System
  canvas: HTMLCanvasElement
  emulator?: Emulator
  timers: number[]
  lastSram?: Uint8Array
  quitting?: boolean
  room?: HostRoom
  seats: Seat[]
  /** each guest's pad, by player number */
  pads: Map<number, PadState>
}

/** Playing on someone else's game as player 2, 3 or 4, watching their stream. */
interface GuestSession {
  code: string
  system?: System
  player?: number
  video: HTMLVideoElement
  link?: GuestLink
  leaving?: boolean
}

let session: Session | undefined
let guest: GuestSession | undefined

const controller = new TouchController(
  ui.pad,
  (button, down) => {
    if (guest) guest.link?.press(button, down)
    else session?.emulator?.press(button, down)
  },
  (x, y) => {
    if (guest) guest.link?.stick(x, y)
    else session?.emulator?.stick(x, y)
  },
)

// USB and Bluetooth pads: the first one is player 1 (or this guest), the next player 2, and so
// on. While other people are in the room, only the first pad plays, so seats don't clash.
const gamepads = new Gamepads({
  system: () => {
    if (ui.menu.open) return undefined
    if (guest) return guest.link && !guest.leaving ? guest.system : undefined
    return session?.emulator && !session.quitting ? session.system : undefined
  },
  press: (player, button, down) => {
    if (guest) {
      if (player === 1) guest.link?.press(button, down)
    } else if (session && (player === 1 || (!session.room && player <= maxPlayers(session.system)))) {
      session.emulator?.press(button, down, player)
    }
  },
  stick: (player, x, y) => {
    if (guest) {
      if (player === 1) guest.link?.stick(x, y)
    } else if (session && (player === 1 || (!session.room && player <= maxPlayers(session.system)))) {
      session.emulator?.stick(x, y, player)
    }
  },
  menu: () => void openMenu(),
})

// Xbox One pads that the system has no driver for (third-party ones on a Mac) work over WebUSB
// once picked here; Chrome remembers the choice for later visits.
ui.usbButton.hidden = !UsbPads.supported || /iPad|iPhone|iPod|Android/.test(navigator.userAgent)
ui.usbButton.addEventListener('click', async () => {
  try {
    toast(`${await gamepads.usb.request()} connected`)
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) toast(`Couldn't connect: ${errorMessage(error)}`) // NotFoundError: chooser closed
  }
})

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
  const system = systemOf(game.fileName) === 'n64' ? 'N64 · ' : ''
  meta.textContent = `${system}${game.playedAt ? `Played ${timeAgo(game.playedAt)}` : 'Not played yet'} · ${formatSize(game.size)}`
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
  else if (added === 0) toast(skipped.length === 1 ? skipped[0] : `No ROMs in those ${skipped.length} files`)
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
  if (session || guest || !event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  document.body.classList.add('is-dropping')
})
document.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) document.body.classList.remove('is-dropping')
})
document.addEventListener('drop', (event) => {
  document.body.classList.remove('is-dropping')
  if (session || guest || !event.dataTransfer?.files.length) return
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
  if (session || guest) return
  const canvas = document.createElement('canvas')
  ui.screen.prepend(canvas)
  const system = systemOf(game.fileName)
  const current: Session = { game, system, canvas, timers: [], seats: [], pads: new Map() }
  session = current
  controller.use(system)
  showPlayer(game.name)
  setStatus('Loading emulator…')
  const stopProgress = onCoreProgress((fraction) => setStatus(`Downloading emulator… ${Math.round(fraction * 100)}%`))
  try {
    const [sram, autosave] = await Promise.all([db.getSram(game.id), db.getState(game.id, 'auto'), loadCore(coreFor(system))])
    stopProgress()
    if (session !== current) return
    setStatus('Starting game…')
    const emulator = await Emulator.launch({
      system,
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
  if (guest) return leaveGame()
  const current = session
  if (!current || current.quitting) return
  current.quitting = true
  if (debug) console.info('[snes-touch] quit:', reason)
  if (ui.menu.open) ui.menu.close()
  controller.releaseAll()
  for (const timer of current.timers) clearInterval(timer)
  await closeRoom(current)
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

function showPlayer(title: string, asGuest = false) {
  ui.title.textContent = title
  ui.menuTitle.textContent = title
  ui.ffButton.setAttribute('aria-pressed', 'false')
  ui.ffButton.hidden = asGuest
  ui.hostTools.hidden = asGuest
  ui.quitButton.textContent = asGuest ? 'Leave game' : 'Save and quit to games'
  showInvite(session)
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

// The system back gesture leaves the game (it is saved on the way out). An invite link opened
// in this tab also lands here; followInvite handles that one.
window.addEventListener('popstate', () => {
  if (!/^#join=/i.test(location.hash)) void quit('history back')
})
if (history.state?.player) history.replaceState(null, '')

// ------------------------------------------------------------ multiplayer: hosting

ui.inviteButton.addEventListener('click', async () => {
  const current = session
  if (!current?.emulator || current.room) return
  ui.inviteButton.disabled = true
  ui.inviteError.hidden = true
  // Copy the link before the room is open: browsers only allow clipboard writes during the
  // tap itself, and opening the room takes a moment.
  const code = newRoomCode()
  const copied = copyText(inviteLink(code))
  try {
    const video = current.canvas.captureStream(60)
    for (const track of video.getVideoTracks()) track.contentHint = 'motion'
    const media = new MediaStream([...video.getTracks(), ...(gameAudioStream()?.getTracks() ?? [])])
    const room = await HostRoom.open(code, media, current.system, {
      seats: (seats) => seatsChanged(current, seats),
      input: (player, pad) => setPad(current, player, pad),
    })
    if (session !== current || current.quitting) {
      void room.close()
      return
    }
    current.room = room
    seatsChanged(current, [])
    if (await copied) {
      const friends = maxPlayers(current.system) - 1
      ui.inviteStatus.textContent = `Invite link copied. Send it to ${friends === 1 ? 'player 2' : `up to ${friends} friends`}.`
    }
  } catch (error) {
    ui.inviteError.textContent = `Couldn't open a room: ${errorMessage(error)}`
    ui.inviteError.hidden = false
  } finally {
    ui.inviteButton.disabled = false
  }
})

function seatsChanged(current: Session, seats: Seat[]) {
  if (session !== current || !current.room) return
  const wasIn = new Set(current.seats.filter(({ state }) => state === 'connected').map(({ player }) => player))
  const isIn = new Set(seats.filter(({ state }) => state === 'connected').map(({ player }) => player))
  current.seats = seats
  showInvite(current)
  if (ui.menu.open) return
  const joined = [...isIn].filter((player) => !wasIn.has(player))
  const left = [...wasIn].filter((player) => !isIn.has(player))
  if (joined.length) toast(`${players(joined)} joined`)
  else if (left.length) toast(`${players(left)} left`)
}

function showInvite(current?: Session) {
  const code = current?.room?.code
  const seats = current?.seats ?? []
  const room = current ? maxPlayers(current.system) : 2
  ui.inviteLabel.textContent = room > 2 ? 'Invite players' : 'Invite player 2'
  ui.inviteButton.hidden = !!code
  ui.inviteRoom.hidden = !code
  ui.inviteCode.textContent = code ?? ''
  ui.inviteLink.textContent = code ? inviteLink(code).replace(/^https?:\/\//, '') : ''
  const isIn = seats.filter(({ state }) => state === 'connected').map(({ player }) => player)
  const arriving = seats.filter(({ state }) => state === 'connecting').map(({ player }) => player)
  const status = []
  if (isIn.length) status.push(`${players(isIn)} ${isIn.length === 1 ? 'is' : 'are'} in. Resume to play!`)
  if (arriving.length) status.push(`${players(arriving)} ${arriving.length === 1 ? 'is' : 'are'} connecting…`)
  if (seats.length < room - 1) status.push(seats.length ? 'Room for more.' : room > 2 ? 'Waiting for players…' : 'Waiting for player 2…')
  ui.inviteStatus.textContent = status.join(' ')
  ui.p2Badge.hidden = isIn.length === 0
  ui.p2Badge.textContent = `${isIn.length + 1}P`
  if (!code) ui.inviteError.hidden = true
}

/** "Player 2", "Players 2 and 3", "Players 2, 3 and 4" */
function players(numbers: number[]) {
  if (numbers.length === 1) return `Player ${numbers[0]}`
  return `Players ${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`
}

async function closeRoom(current: Session) {
  const room = current.room
  if (!room) return
  current.room = undefined
  current.seats = []
  for (const player of current.pads.keys()) setPad(current, player, NO_INPUT)
  if (session === current) showInvite(current)
  await room.close()
}

function setPad(current: Session, player: number, pad: PadState) {
  const { emulator } = current
  const previous = current.pads.get(player) ?? NO_INPUT
  diffButtons(previous.mask, pad.mask, (button, down) => emulator?.press(button, down, player))
  if (pad.x !== previous.x || pad.y !== previous.y) emulator?.stick(pad.x, pad.y, player)
  current.pads.set(player, pad)
}

ui.inviteShare.addEventListener('click', async () => {
  const code = session?.room?.code
  if (!code) return
  const url = inviteLink(code)
  try {
    // only the link: with extra text, some apps (and the share sheet's Copy) drop the URL
    if (navigator.share) await navigator.share({ title: 'Join my SNES Touch game', url })
    else if (await copyText(url)) ui.inviteStatus.textContent = 'Invite link copied'
  } catch {
    // share sheet dismissed
  }
})

ui.inviteLink.addEventListener('click', async () => {
  const code = session?.room?.code
  if (code && (await copyText(inviteLink(code)))) ui.inviteStatus.textContent = 'Invite link copied'
})

ui.inviteStop.addEventListener('click', () => {
  if (session) void closeRoom(session)
})

// ------------------------------------------------------------ multiplayer: joining

function openJoin() {
  ui.joinCode.value = ''
  ui.joinDialog.showModal()
  ui.joinCode.focus()
}

ui.joinButton.addEventListener('click', () => openJoin())
ui.joinCancel.addEventListener('click', () => ui.joinDialog.close())
ui.joinCode.addEventListener('input', () => {
  ui.joinCode.value = normalizeCode(ui.joinCode.value)
})
ui.joinCode.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') ui.joinGo.click()
})
ui.joinGo.addEventListener('click', () => {
  const code = normalizeCode(ui.joinCode.value)
  if (code.length !== 4) {
    ui.joinCode.focus()
    return
  }
  ui.joinDialog.close()
  void joinGame(code)
})

async function joinGame(code: string) {
  if (session || guest) return
  const video = document.createElement('video')
  video.playsInline = true
  video.autoplay = true
  video.muted = true // autoplay rules; the first tap on the pad turns the sound on
  ui.screen.prepend(video)
  const current: GuestSession = { code, video }
  guest = current
  controller.use('snes') // until the host says which system it runs
  showPlayer(`Room ${code}`, true)
  setStatus(`Joining room ${code}…`)
  try {
    const link = await GuestLink.join(code, {
      seated: (system, player) => {
        if (guest !== current) return
        current.player = player
        current.system = system
        controller.use(system)
        ui.title.textContent = ui.menuTitle.textContent = `Player ${player} · room ${code}`
      },
      stream: (stream) => {
        video.srcObject = stream
        void video.play().catch(() => undefined)
      },
      state: (state, reason) => {
        if (guest !== current) return
        if (state === 'connecting') setStatus('Connecting to the host…')
        else if (state === 'connected') {
          setStatus()
          toast(`You're player ${current.player ?? 2}. Tap the pad for sound.`)
        } else setStatus(reason ?? 'The game ended.', true)
      },
    })
    if (guest !== current) await link.close()
    else current.link = link
  } catch (error) {
    if (guest === current) setStatus(errorMessage(error), true)
  }
}

async function leaveGame() {
  const current = guest
  if (!current || current.leaving) return
  current.leaving = true
  if (ui.menu.open) ui.menu.close()
  controller.releaseAll()
  await current.link?.close()
  current.video.srcObject = null
  current.video.remove()
  guest = undefined
  setStatus()
  showLibrary()
  if (history.state?.player) history.back()
}

function unmuteGuest() {
  const video = guest?.video
  if (!video?.muted || !video.srcObject) return
  video.muted = false
  void video.play().catch(() => undefined)
}

// Invite links look like https://…/#join=ABCD and go straight into the game. An installed app
// that is already open gets them as a hash change instead of a fresh load.
async function followInvite() {
  const invited = /^#join=([a-z0-9]{4})$/i.exec(location.hash)
  if (!invited) return
  history.replaceState(null, '', location.pathname + location.search)
  const code = normalizeCode(invited[1])
  if (session) return toast(`Quit this game to join room ${code}`)
  await leaveGame() // already a guest in another room
  void joinGame(code)
}
void followInvite()
window.addEventListener('hashchange', () => void followInvite())

// ------------------------------------------------------------ pause menu

async function openMenu() {
  if (ui.menu.open) return
  if (guest) {
    if (guest.leaving) return
    controller.releaseAll()
    ui.menu.showModal()
    ui.resumeButton.focus()
    return
  }
  const current = session
  if (!current?.emulator || current.quitting) return
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
  if (event.key === 'Escape' && (session || guest) && !ui.menu.open) void openMenu()
})

// RetroArch reads the keyboard for SNES games itself; the N64 cores take input from the app,
// so their keys are mapped here. Arrows steer the stick.
const N64_KEYS: Record<string, Button> = {
  KeyX: 'a',
  KeyZ: 'b',
  KeyA: 'z',
  KeyQ: 'l',
  KeyW: 'r',
  Enter: 'start',
  KeyI: 'cu',
  KeyK: 'cd',
  KeyJ: 'cl',
  KeyL: 'cr',
}
const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
const arrowsHeld = new Set<string>()

function n64Key(event: KeyboardEvent) {
  const emulator = session?.emulator
  const down = event.type === 'keydown'
  // key releases still count while the menu is open, so nothing stays held
  if (emulator?.system !== 'n64' || (down && ui.menu.open) || event.repeat || event.metaKey || event.ctrlKey) return
  const button = N64_KEYS[event.code]
  if (button) emulator.press(button, down)
  else if (event.code in ARROWS) {
    if (down) arrowsHeld.add(event.code)
    else arrowsHeld.delete(event.code)
    let x = 0
    let y = 0
    for (const code of arrowsHeld) {
      x += ARROWS[code][0]
      y += ARROWS[code][1]
    }
    const length = Math.hypot(x, y) || 1
    emulator.stick(x / length, y / length)
  } else return
  event.preventDefault()
}
document.addEventListener('keydown', n64Key)
document.addEventListener('keyup', n64Key)

// Leaving the app: release held buttons, keep the save RAM, and come back paused.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return
  if (guest) {
    controller.releaseAll()
    return
  }
  if (!session?.emulator || session.quitting) return
  controller.releaseAll()
  void saveSram(session)
  void openMenu()
})
window.addEventListener('pagehide', () => {
  if (session?.emulator) void saveSram(session)
})

// ------------------------------------------------------------ page setup

for (const type of ['pointerdown', 'pointerup', 'touchend', 'keydown']) {
  document.addEventListener(
    type,
    () => {
      unlockAudio()
      unmuteGuest()
    },
    { capture: true, passive: true },
  )
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
  Object.assign(window, {
    snesTouch: {
      get emulator() {
        return session?.emulator
      },
      get room() {
        return session?.room
      },
      get guest() {
        return guest
      },
      controller,
      addBundledGames,
    },
  })
}

void renderLibrary().then(addBundledGames)
// warm the cache so the first game starts faster
window.setTimeout(() => void loadCore(coreFor('snes')).catch(() => undefined), 1500)

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

/** Resolves to whether it worked. Call it before any await: browsers only allow it during a tap. */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // plain-http pages and in-app browsers that block the clipboard API still allow the old way
    return legacyCopy(text)
  }
}

function legacyCopy(text: string) {
  const focused = document.activeElement
  const field = document.createElement('textarea')
  field.value = text
  field.readOnly = true
  field.className = 'visually-hidden'
  // a modal dialog makes the rest of the page inert, so the field has to go inside it
  const host = document.querySelector('dialog[open]') ?? document.body
  host.append(field)
  field.select()
  field.setSelectionRange(0, text.length) // iOS
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    field.remove()
    if (focused instanceof HTMLElement) focused.focus()
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
