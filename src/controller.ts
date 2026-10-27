import { hapticTick } from './haptics'
import type { System } from './systems'

export type Button =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'a'
  | 'b'
  | 'x'
  | 'y'
  | 'l'
  | 'r'
  | 'select'
  | 'start'
  // N64 only
  | 'z'
  | 'cu'
  | 'cd'
  | 'cl'
  | 'cr'

// A touch that starts near the d-pad (or the N64 stick) steers it for as long as it stays
// down; any other touch presses whatever button is under it and can slide between them.
type Zone = 'dpad' | 'stick' | 'buttons'

interface Pointer {
  zone: Zone
  buttons: Button[]
  stick?: { x: number; y: number }
}

const DPAD_GRAB = 1.45 // touches within this many d-pad radii of its center grab the d-pad
const DPAD_DEADZONE = 0.22 // fraction of the radius around the center that presses nothing
const DIAGONAL_ARC = 34 // degrees around each diagonal that press two directions
const FACE_REACH = 0.9 // a face button's hit radius, relative to its distance from the cluster center
const RECT_SLOP = 14 // px of forgiveness around L/R and Select/Start
const BUTTON_REACH = 1.3 // N64 buttons: hit radius relative to the button's own radius
const STICK_TRAVEL = 0.62 // fraction of the stick's radius the thumb travels for a full push
const STICK_DEADZONE = 0.1 // of a full push
const OPPOSITE: Partial<Record<Button, Button>> = { a: 'y', y: 'a', b: 'x', x: 'b' }
// compass sectors clockwise from "right" (screen y points down)
const SECTORS: Button[][] = [
  ['right'],
  ['right', 'down'],
  ['down'],
  ['down', 'left'],
  ['left'],
  ['left', 'up'],
  ['up'],
  ['up', 'right'],
]

export class TouchController {
  private readonly pointers = new Map<number, Pointer>()
  private keys = new Map<Button, HTMLElement>()
  private held = new Set<Button>()
  private system: System = 'snes'
  private layout!: HTMLElement
  private dpad = { x: 0, y: 0, r: 1 }
  private stick?: { x: number; y: number; r: number }
  private stickAt = { x: 0, y: 0 }
  private face: { button: Button; x: number; y: number; reach: number }[] = []
  private rects: { button: Button; rect: DOMRect }[] = []

  constructor(
    private readonly root: HTMLElement,
    private readonly onChange: (button: Button, down: boolean) => void,
    private readonly onStick: (x: number, y: number) => void,
  ) {
    this.use('snes')
    root.addEventListener('pointerdown', this.down, { passive: false })
    root.addEventListener('pointermove', this.move, { passive: false })
    root.addEventListener('pointerup', this.up)
    root.addEventListener('pointercancel', this.up)
    root.addEventListener('lostpointercapture', this.up)
    root.addEventListener('contextmenu', (event) => event.preventDefault())
  }

  /** Shows the pad for a system; each one has its own layout in the markup. */
  use(system: System) {
    this.releaseAll()
    this.system = system
    for (const layout of this.root.querySelectorAll<HTMLElement>('[data-layout]')) {
      layout.hidden = layout.dataset.layout !== system
      if (!layout.hidden) this.layout = layout
    }
    this.keys = new Map(Array.from(this.layout.querySelectorAll<HTMLElement>('[data-btn]'), (key) => [key.dataset.btn as Button, key]))
  }

  releaseAll() {
    this.pointers.clear()
    this.sync()
  }

  private readonly down = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    if (this.pointers.size === 0) this.measure() // the layout only changes between touches
    try {
      this.root.setPointerCapture(event.pointerId)
    } catch {
      // synthetic events have no active pointer to capture
    }
    const pointer: Pointer = { zone: this.zoneAt(event.clientX, event.clientY), buttons: [] }
    this.pointers.set(event.pointerId, pointer)
    this.track(pointer, event.clientX, event.clientY)
  }

  private readonly move = (event: PointerEvent) => {
    const pointer = this.pointers.get(event.pointerId)
    if (!pointer) return
    event.preventDefault()
    this.track(pointer, event.clientX, event.clientY)
  }

  private readonly up = (event: PointerEvent) => {
    if (this.pointers.delete(event.pointerId)) this.sync()
  }

  private track(pointer: Pointer, x: number, y: number) {
    if (pointer.zone === 'stick') pointer.stick = this.stickValue(x, y)
    else pointer.buttons = pointer.zone === 'dpad' ? this.dpadAt(x, y) : this.buttonsAt(x, y)
    this.sync()
  }

  private sync() {
    const next = new Set<Button>()
    let stick = { x: 0, y: 0 }
    for (const pointer of this.pointers.values()) {
      for (const button of pointer.buttons) next.add(button)
      if (pointer.stick) stick = pointer.stick
    }
    this.moveStick(stick)
    let pressed = false
    for (const button of this.held) if (!next.has(button)) this.set(button, false)
    for (const button of next) {
      if (this.held.has(button)) continue
      this.set(button, true)
      pressed = true
    }
    this.held = next
    if (pressed) hapticTick()
  }

  private set(button: Button, down: boolean) {
    this.keys.get(button)?.classList.toggle('is-down', down)
    this.onChange(button, down)
  }

  private moveStick({ x, y }: { x: number; y: number }) {
    if (x === this.stickAt.x && y === this.stickAt.y) return
    this.stickAt = { x, y }
    const knob = this.layout.querySelector<HTMLElement>('.stick-knob')
    if (knob) knob.style.translate = `${x * 50}% ${y * 50}%`
    this.onStick(x, y)
  }

  private measure() {
    const center = (element: Element) => {
      const rect = element.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, r: rect.width / 2 }
    }
    const dpad = this.layout.querySelector('.dpad')
    const stick = this.layout.querySelector('.stick')
    const cluster = this.layout.querySelector('.face')
    if (!cluster) return
    if (dpad) this.dpad = center(dpad)
    const hub = center(cluster)
    this.stick = stick ? center(stick) : undefined
    // SNES buttons sit in a ring, so each reaches toward the ring's center; the N64's are
    // uneven, so each reaches a little past its own edge.
    this.face = Array.from(this.layout.querySelectorAll<HTMLElement>('.face-btn'), (element) => {
      const { x, y, r } = center(element)
      const reach = this.system === 'n64' ? r * BUTTON_REACH : Math.hypot(x - hub.x, y - hub.y) * FACE_REACH
      return { button: element.dataset.btn as Button, x, y, reach }
    })
    this.rects = Array.from(this.layout.querySelectorAll<HTMLElement>('.shoulder, .meta-btn'), (element) => ({
      button: element.dataset.btn as Button,
      rect: element.getBoundingClientRect(),
    }))
  }

  private zoneAt(x: number, y: number): Zone {
    // on narrow phones the d-pad's grab radius reaches the Y button, so buttons win
    if (this.rectAt(x, y) || this.faceAt(x, y).length > 0) return 'buttons'
    if (this.stick) return Math.hypot(x - this.stick.x, y - this.stick.y) <= this.stick.r * DPAD_GRAB ? 'stick' : 'buttons'
    return Math.hypot(x - this.dpad.x, y - this.dpad.y) <= this.dpad.r * DPAD_GRAB ? 'dpad' : 'buttons'
  }

  /** The stick's push for a thumb at this point, from -1 to 1 on each axis. */
  private stickValue(x: number, y: number) {
    if (!this.stick) return { x: 0, y: 0 }
    const travel = this.stick.r * STICK_TRAVEL
    const dx = (x - this.stick.x) / travel
    const dy = (y - this.stick.y) / travel
    const length = Math.hypot(dx, dy)
    if (length < STICK_DEADZONE) return { x: 0, y: 0 }
    // past the dead zone the push starts from zero, and it never goes past the rim
    const push = Math.min((length - STICK_DEADZONE) / (1 - STICK_DEADZONE), 1)
    return { x: (dx / length) * push, y: (dy / length) * push }
  }

  private dpadAt(x: number, y: number): Button[] {
    const dx = x - this.dpad.x
    const dy = y - this.dpad.y
    if (Math.hypot(dx, dy) < this.dpad.r * DPAD_DEADZONE) return []
    const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360
    const sector = Math.round(angle / 45) % 8
    if (sector % 2 === 0) return SECTORS[sector]
    // diagonals get a narrower arc than the cardinals, so a thumb resting on
    // "right" doesn't keep slipping into "down-right"
    const offset = angle - sector * 45
    if (Math.abs(offset) <= DIAGONAL_ARC / 2) return SECTORS[sector]
    return SECTORS[(sector + (offset > 0 ? 1 : 7)) % 8]
  }

  private buttonsAt(x: number, y: number): Button[] {
    const rect = this.rectAt(x, y)
    if (rect) return [rect]
    const hits = this.faceAt(x, y)
    // between two neighbours (B and Y, say) one thumb presses both
    if (hits.length >= 2 && OPPOSITE[hits[0]] !== hits[1]) return hits.slice(0, 2)
    return hits.slice(0, 1)
  }

  /** Face buttons within reach of the point, nearest first. */
  private faceAt(x: number, y: number) {
    return this.face
      .map(({ button, x: bx, y: by, reach }) => ({ button, reach, distance: Math.hypot(x - bx, y - by) }))
      .filter(({ distance, reach }) => distance <= reach)
      .sort((a, b) => a.distance - b.distance)
      .map(({ button }) => button)
  }

  private rectAt(x: number, y: number) {
    return this.rects.find(
      ({ rect }) =>
        x >= rect.left - RECT_SLOP && x <= rect.right + RECT_SLOP && y >= rect.top - RECT_SLOP && y <= rect.bottom + RECT_SLOP,
    )?.button
  }
}
