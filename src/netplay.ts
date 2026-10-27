import { RealtimeClient, type RealtimeChannel } from '@supabase/realtime-js'
import { SUPABASE_KEY, SUPABASE_URL } from './config'
import type { Button } from './controller'
import type { System } from './systems'

// Multiplayer rooms: 2 players for SNES games, up to 4 for N64. The host runs the emulator and
// streams its screen and sound over WebRTC to each guest; each guest's pad comes back over a
// data channel as player 2, 3 or 4. Supabase Realtime only carries the handshake (offer, answer,
// ICE candidates); the game itself flows peer to peer, or through a TURN relay when the networks
// in between don't allow a direct path.

const BUTTON_BITS: Button[] = ['up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'select', 'start', 'z', 'cu', 'cd', 'cl', 'cr']
const STICK_SCALE = 0x7fff
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O or 1/I
const STUN: RTCIceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }]
const OPEN_TIMEOUT = 10_000
const HELLO_EVERY = 1500
const HELLO_TRIES = 20 // 30 s: a host on a phone may still be in another app, sending the invite
const INPUT_EVERY = 50 // ms; pad state is resent so a lost packet costs at most this much
const DISCONNECT_GRACE = 8000

type Signal =
  | { kind: 'hello'; from: string }
  | { kind: 'busy' | 'bye'; from: string; to: string }
  | { kind: 'offer'; from: string; to: string; sdp: RTCSessionDescriptionInit; system?: System; player?: number }
  | { kind: 'answer'; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | { kind: 'ice'; from: string; to: string; candidate: RTCIceCandidateInit }
type Outgoing = Signal extends infer S ? (S extends Signal ? Omit<S, 'from'> : never) : never

export function normalizeCode(raw: string) {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4)
}

export function newRoomCode() {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (n) => CODE_LETTERS[n % CODE_LETTERS.length]).join('')
}

export const inviteLink = (code: string) => `${location.origin}/#join=${code}`

/** A guest's pad: buttons as a bit mask, plus the analog stick from -1 to 1 (N64 only). */
export interface PadState {
  mask: number
  x: number
  y: number
}

export const NO_INPUT: PadState = { mask: 0, x: 0, y: 0 }

/** Calls `apply` for every button whose state differs between two pad masks. */
export function diffButtons(previous: number, next: number, apply: (button: Button, down: boolean) => void) {
  BUTTON_BITS.forEach((button, bit) => {
    const was = (previous >> bit) & 1
    const is = (next >> bit) & 1
    if (was !== is) apply(button, is === 1)
  })
}

// STUN always works for the handshake; the snes-ice edge function adds TURN relays when one
// is configured. TURN credentials expire, so fetch fresh ones for each connection.
async function iceServers(): Promise<RTCIceServer[]> {
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/snes-ice`, {
      headers: { apikey: SUPABASE_KEY },
      signal: AbortSignal.timeout(4000),
    })
    if (!response.ok) return STUN
    return ((await response.json()) as { iceServers: RTCIceServer[] }).iceServers
  } catch {
    return STUN
  }
}

class Signaling {
  readonly id = crypto.randomUUID()
  private readonly client = new RealtimeClient(`${SUPABASE_URL}/realtime/v1`, { params: { apikey: SUPABASE_KEY } })
  private readonly channel: RealtimeChannel

  constructor(code: string, onSignal: (signal: Signal) => void) {
    this.channel = this.client.channel(`snes-touch:${code}`, { config: { broadcast: { self: false } } })
    this.channel.on('broadcast', { event: 'signal' }, ({ payload }) => {
      const signal = payload as Signal
      if ('to' in signal && signal.to !== this.id) return
      onSignal(signal)
    })
  }

  // A dropped socket reconnects and rejoins by itself, so errors only count once time is up.
  open() {
    return new Promise<void>((resolve, reject) => {
      let lastError: unknown
      const giveUp = window.setTimeout(() => {
        void this.close()
        reject(new Error('the matchmaking server is unreachable', { cause: lastError }))
      }, OPEN_TIMEOUT)
      this.channel.subscribe((status, error) => {
        if (status === 'SUBSCRIBED') {
          window.clearTimeout(giveUp)
          resolve()
        } else if (error) lastError = error
      })
    })
  }

  send(signal: Outgoing) {
    void this.channel.send({ type: 'broadcast', event: 'signal', payload: { ...signal, from: this.id } })
  }

  async close() {
    await this.client.removeChannel(this.channel).catch(() => undefined)
    await this.client.disconnect().catch(() => undefined)
  }
}

// ICE candidates can arrive before the description they belong to.
class Peer {
  readonly pc: RTCPeerConnection
  private pending: RTCIceCandidateInit[] = []
  private described = false

  constructor(servers: RTCIceServer[]) {
    this.pc = new RTCPeerConnection({ iceServers: servers })
  }

  async describe(description: RTCSessionDescriptionInit) {
    await this.pc.setRemoteDescription(description)
    this.described = true
    for (const candidate of this.pending.splice(0)) await this.pc.addIceCandidate(candidate).catch(() => undefined)
  }

  async candidate(candidate: RTCIceCandidateInit) {
    if (this.described) await this.pc.addIceCandidate(candidate).catch(() => undefined)
    else this.pending.push(candidate)
  }
}

/** A guest's seat in the room: which player they are, and whether they are in yet. */
export interface Seat {
  player: number
  state: 'connecting' | 'connected'
}

interface HostEvents {
  /** Every time a guest arrives, connects or leaves. */
  seats(seats: Seat[]): void
  input(player: number, pad: PadState): void
}

interface Guest {
  id: string
  player: number
  connected: boolean
  peer?: Peer
  lastSeq: number
}

/** How many people can play a system's games, the host included. */
export const maxPlayers = (system: System) => (system === 'n64' ? 4 : 2)

export class HostRoom {
  private readonly guests = new Map<string, Guest>()
  private signaling!: Signaling

  private constructor(
    readonly code: string,
    private readonly media: MediaStream,
    private readonly system: System,
    private readonly events: HostEvents,
  ) {}

  static async open(code: string, media: MediaStream, system: System, events: HostEvents) {
    const room = new HostRoom(code, media, system, events)
    room.signaling = new Signaling(code, (signal) => void room.handle(signal))
    await room.signaling.open()
    return room
  }

  async close() {
    for (const guest of this.guests.values()) {
      this.signaling.send({ kind: 'bye', to: guest.id })
      this.drop(guest)
    }
    await this.signaling.close()
  }

  private async handle(signal: Signal) {
    const guest = this.guests.get(signal.from)
    switch (signal.kind) {
      case 'hello': {
        if (guest) break // a repeated hello while connecting
        const player = this.freeSeat()
        if (player) await this.connect(signal.from, player)
        else this.signaling.send({ kind: 'busy', to: signal.from })
        break
      }
      case 'answer':
        if (guest?.peer) {
          await guest.peer.describe(signal.sdp)
          for (const sender of guest.peer.pc.getSenders()) if (sender.track?.kind === 'video') void tuneVideo(sender)
        }
        break
      case 'ice':
        await guest?.peer?.candidate(signal.candidate)
        break
      case 'bye':
        if (guest) this.drop(guest)
        break
    }
  }

  /** The lowest free player number, or undefined when the room is full. */
  private freeSeat() {
    const taken = new Set(Array.from(this.guests.values(), ({ player }) => player))
    for (let player = 2; player <= maxPlayers(this.system); player++) if (!taken.has(player)) return player
    return undefined
  }

  private async connect(guestId: string, player: number) {
    const guest: Guest = { id: guestId, player, connected: false, lastSeq: -1 }
    this.guests.set(guestId, guest) // claim the seat before the await, so a repeated hello is ignored
    this.announce()
    const peer = new Peer(await iceServers())
    if (this.guests.get(guestId) !== guest) return
    guest.peer = peer
    const { pc } = peer
    for (const track of this.media.getTracks()) pc.addTrack(track, this.media)
    const input = pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 })
    input.binaryType = 'arraybuffer'
    input.onmessage = ({ data }) => this.receive(guest, data as ArrayBuffer)
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.signaling.send({ kind: 'ice', to: guestId, candidate: candidate.toJSON() })
    }
    let grace = 0
    pc.onconnectionstatechange = () => {
      if (this.guests.get(guestId) !== guest) return
      window.clearTimeout(grace)
      if (pc.connectionState === 'connected') {
        guest.connected = true
        this.announce()
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.drop(guest)
      else if (pc.connectionState === 'disconnected') grace = window.setTimeout(() => this.drop(guest), DISCONNECT_GRACE)
    }
    await pc.setLocalDescription(await pc.createOffer())
    if (pc.localDescription) {
      this.signaling.send({ kind: 'offer', to: guestId, sdp: pc.localDescription.toJSON(), system: this.system, player })
    }
  }

  private receive(guest: Guest, data: ArrayBuffer) {
    // [sequence, buttons low 16 bits, buttons high 16 bits, stick x, stick y]
    const [seq, low, high = 0] = new Uint16Array(data)
    const [, , , x = 0, y = 0] = new Int16Array(data)
    // drop packets older than the last one applied (the 16-bit sequence wraps around)
    if (guest.lastSeq >= 0 && ((seq - guest.lastSeq) & 0xffff) >= 0x8000) return
    guest.lastSeq = seq
    this.events.input(guest.player, { mask: low | (high << 16), x: x / STICK_SCALE, y: y / STICK_SCALE })
  }

  private drop(guest: Guest) {
    if (this.guests.get(guest.id) !== guest) return
    this.guests.delete(guest.id)
    guest.peer?.pc.close()
    this.events.input(guest.player, NO_INPUT)
    this.announce()
  }

  private announce() {
    const seats = Array.from(this.guests.values(), ({ player, connected }): Seat => ({ player, state: connected ? 'connected' : 'connecting' }))
    this.events.seats(seats.sort((a, b) => a.player - b.player))
  }
}

// Games favour frame rate over sharpness, and the stream is small anyway.
async function tuneVideo(sender: RTCRtpSender) {
  const params = sender.getParameters()
  if (!params.encodings?.length) return
  params.encodings[0].maxBitrate = 2_500_000
  params.encodings[0].maxFramerate = 60
  await sender.setParameters(params).catch(() => undefined)
}

export type GuestState = 'connecting' | 'connected' | 'ended'

interface GuestEvents {
  /** The host's system, which decides the pad to show, and which player this guest is. */
  seated(system: System, player: number): void
  stream(stream: MediaStream): void
  state(state: GuestState, reason?: string): void
}

export class GuestLink {
  private hostId?: string
  private peer?: Peer
  private input?: RTCDataChannel
  private mask = 0
  private stickX = 0
  private stickY = 0
  private seq = 0
  private resend = 0
  private answered?: (busy: boolean) => void
  private closed = false
  private signaling!: Signaling

  private constructor(private readonly events: GuestEvents) {}

  /** Joins a room as the next free player; rejects when no host answers or the room is full. */
  static async join(code: string, events: GuestEvents) {
    const link = new GuestLink(events)
    link.signaling = new Signaling(code, (signal) => void link.handle(signal))
    await link.signaling.open()
    try {
      await link.knock()
    } catch (error) {
      await link.close()
      throw error
    }
    return link
  }

  press(button: Button, down: boolean) {
    const bit = 1 << BUTTON_BITS.indexOf(button)
    this.mask = down ? this.mask | bit : this.mask & ~bit
    this.send()
  }

  stick(x: number, y: number) {
    this.stickX = Math.round(x * STICK_SCALE)
    this.stickY = Math.round(y * STICK_SCALE)
    this.send()
  }

  async close() {
    this.closed = true
    window.clearInterval(this.resend)
    if (this.hostId) this.signaling.send({ kind: 'bye', to: this.hostId })
    this.peer?.pc.close()
    await this.signaling.close()
  }

  // Broadcasts are fire-and-forget, so say hello until the host answers.
  private knock() {
    return new Promise<void>((resolve, reject) => {
      let tries = 0
      const timer = window.setInterval(hello, HELLO_EVERY)
      const signaling = this.signaling
      function hello() {
        if (++tries > HELLO_TRIES) {
          window.clearInterval(timer)
          reject(new Error('No game with that code is running.'))
        } else signaling.send({ kind: 'hello' })
      }
      this.answered = (busy) => {
        window.clearInterval(timer)
        if (busy) reject(new Error('That game is full.'))
        else resolve()
      }
      hello()
    })
  }

  private async handle(signal: Signal) {
    if (this.closed) return
    const fromHost = signal.from === this.hostId
    switch (signal.kind) {
      case 'offer':
        if (this.hostId && !fromHost) return
        this.hostId = signal.from
        this.answered?.(false)
        // hosts from before N64 support say neither
        this.events.seated(signal.system ?? 'snes', signal.player ?? 2)
        await this.answer(signal.sdp)
        break
      case 'busy':
        this.answered?.(true)
        break
      case 'ice':
        if (fromHost) await this.peer?.candidate(signal.candidate)
        break
      case 'bye':
        if (fromHost) this.events.state('ended', 'The host ended the game.')
        break
    }
  }

  private async answer(offer: RTCSessionDescriptionInit) {
    const peer = new Peer(await iceServers())
    this.peer = peer
    const { pc } = peer
    pc.ontrack = ({ streams, receiver }) => {
      // play as soon as frames arrive instead of buffering for smoothness
      if ('jitterBufferTarget' in receiver) Object.assign(receiver, { jitterBufferTarget: 0 })
      if (streams[0]) this.events.stream(streams[0])
    }
    pc.ondatachannel = ({ channel }) => {
      channel.binaryType = 'arraybuffer'
      this.input = channel
    }
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && this.hostId) this.signaling.send({ kind: 'ice', to: this.hostId, candidate: candidate.toJSON() })
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') this.events.state('connected')
      else if (pc.connectionState === 'failed') this.events.state('ended', 'Lost the connection to the host.')
    }
    await peer.describe(offer)
    await pc.setLocalDescription(await pc.createAnswer())
    if (this.hostId && pc.localDescription) this.signaling.send({ kind: 'answer', to: this.hostId, sdp: pc.localDescription.toJSON() })
    this.resend = window.setInterval(() => this.send(), INPUT_EVERY)
    this.events.state('connecting')
  }

  private send() {
    if (this.input?.readyState !== 'open') return
    this.seq = (this.seq + 1) & 0xffff
    const packet = new Int16Array([this.seq, this.mask & 0xffff, this.mask >>> 16, this.stickX, this.stickY])
    this.input.send(packet)
  }
}
