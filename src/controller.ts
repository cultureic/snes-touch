import { hapticTick } from './haptics'

export type Button = 'up' | 'down' | 'left' | 'right' | 'a' | 'b' | 'x' | 'y' | 'l' | 'r' | 'select' | 'start'

// A touch that starts near the d-pad steers it like a stick for as long as it stays
// down; any other touch presses whatever button is under it and can slide between them.
type Zone = 'dpad' | 'buttons'

interface Pointer {
  zone: Zone
  buttons: Button[]
}

const DPAD_GRAB = 1.45 // touches within this many d-pad radii of its center grab the d-pad
const DPAD_DEADZONE = 0.22 // fraction of the radius around the center that presses nothing
const DIAGONAL_ARC = 34 // degrees around each diagonal that press two directions
const FACE_REACH = 0.9 // a face button's hit radius, relative to its distance from the cluster center
const RECT_SLOP = 14 // px of forgiveness around L/R and Select/Start
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
  private readonly keys = new Map<Button, HTMLElement>()
  private held = new Set<Button>()
  private dpad = { x: 0, y: 0, r: 1 }
  private face: { button: Button; x: number; y: number; reach: number }[] = []
  private rects: { button: Button; rect: DOMRect }[] = []

  constructor(
    private readonly root: HTMLElement,
    private readonly onChange: (button: Button, down: boolean) => void,
  ) {
    for (const key of root.querySelectorAll<HTMLElement>('[data-btn]')) this.keys.set(key.dataset.btn as Button, key)
    root.addEventListener('pointerdown', this.down, { passive: false })
    root.addEventListener('pointermove', this.move, { passive: false })
    root.addEventListener('pointerup', this.up)
    root.addEventListener('pointercancel', this.up)
    root.addEventListener('lostpointercapture', this.up)
    root.addEventListener('contextmenu', (event) => event.preventDefault())
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
    pointer.buttons = pointer.zone === 'dpad' ? this.dpadAt(x, y) : this.buttonsAt(x, y)
    this.sync()
  }

  private sync() {
    const next = new Set<Button>()
    for (const pointer of this.pointers.values()) for (const button of pointer.buttons) next.add(button)
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

  private measure() {
    const center = (element: Element) => {
      const rect = element.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, r: rect.width / 2 }
    }
    const dpad = this.root.querySelector('.dpad')
    const cluster = this.root.querySelector('.face')
    if (!dpad || !cluster) return
    this.dpad = center(dpad)
    const hub = center(cluster)
    this.face = Array.from(this.root.querySelectorAll<HTMLElement>('.face-btn'), (element) => {
      const { x, y } = center(element)
      return { button: element.dataset.btn as Button, x, y, reach: Math.hypot(x - hub.x, y - hub.y) * FACE_REACH }
    })
    this.rects = Array.from(this.root.querySelectorAll<HTMLElement>('.shoulder, .meta-btn'), (element) => ({
      button: element.dataset.btn as Button,
      rect: element.getBoundingClientRect(),
    }))
  }

  private zoneAt(x: number, y: number): Zone {
    // on narrow phones the d-pad's grab radius reaches the Y button, so buttons win
    if (this.rectAt(x, y) || this.faceAt(x, y).length > 0) return 'buttons'
    return Math.hypot(x - this.dpad.x, y - this.dpad.y) <= this.dpad.r * DPAD_GRAB ? 'dpad' : 'buttons'
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
