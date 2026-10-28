import type { Button } from './controller'
import type { System } from './systems'
import { type PadReading, UsbPads } from './usbpads'

// USB and Bluetooth controllers through the browser's Gamepad API, read by the app rather than
// the emulator: the N64 cores don't poll gamepads themselves, and this way both systems map the
// same way. Pads in the browser's "standard" layout (Xbox, PlayStation, Switch Pro and most
// others) are matched by position, so the bottom face button is always the same one.

const STICK_DEADZONE = 0.18
const DIGITAL_THRESHOLD = 0.5 // a stick or trigger counts as a press past this

// standard-mapping button indices
const FACE_BOTTOM = 0
const FACE_RIGHT = 1
const FACE_LEFT = 2
const FACE_TOP = 3
const BUMPER_LEFT = 4
const BUMPER_RIGHT = 5
const TRIGGER_LEFT = 6
const TRIGGER_RIGHT = 7
const BACK = 8
const START = 9
const DPAD: [number, Button][] = [
  [12, 'up'],
  [13, 'down'],
  [14, 'left'],
  [15, 'right'],
]
const STICK_LEFT = 10
const STICK_RIGHT = 11
const HOME = 16

// Laid out like the original pads: SNES B is the bottom face button, A the right one.
const SNES_BUTTONS: [number, Button][] = [
  [FACE_BOTTOM, 'b'],
  [FACE_RIGHT, 'a'],
  [FACE_LEFT, 'y'],
  [FACE_TOP, 'x'],
  [BUMPER_LEFT, 'l'],
  [BUMPER_RIGHT, 'r'],
  [TRIGGER_LEFT, 'l'],
  [TRIGGER_RIGHT, 'r'],
  [BACK, 'select'],
  [START, 'start'],
]
// N64: A bottom, B left (as on the N64 pad, B sits up and left of A), Z on the left trigger,
// the right stick is the C buttons.
const N64_BUTTONS: [number, Button][] = [
  [FACE_BOTTOM, 'a'],
  [FACE_LEFT, 'b'],
  [FACE_RIGHT, 'b'],
  [FACE_TOP, 'cu'],
  [TRIGGER_LEFT, 'z'],
  [TRIGGER_RIGHT, 'z'],
  [BUMPER_LEFT, 'l'],
  [BUMPER_RIGHT, 'r'],
  [START, 'start'],
]

// PS2 by position like the SNES (cross is the bottom button), with L2/R2 on the triggers.
const PS2_BUTTONS: [number, Button][] = [
  [FACE_BOTTOM, 'b'],
  [FACE_RIGHT, 'a'],
  [FACE_LEFT, 'y'],
  [FACE_TOP, 'x'],
  [BUMPER_LEFT, 'l'],
  [BUMPER_RIGHT, 'r'],
  [TRIGGER_LEFT, 'l2'],
  [TRIGGER_RIGHT, 'r2'],
  [STICK_LEFT, 'l3'],
  [STICK_RIGHT, 'r3'],
  [BACK, 'select'],
  [START, 'start'],
]
// GameCube: A bottom, B left, X right, Y top (as on its pad, around a big A), L/R on the
// triggers, Z on the right bumper. The right stick is the C-stick.
const GC_BUTTONS: [number, Button][] = [
  [FACE_BOTTOM, 'a'],
  [FACE_LEFT, 'b'],
  [FACE_RIGHT, 'x'],
  [FACE_TOP, 'y'],
  [TRIGGER_LEFT, 'l'],
  [TRIGGER_RIGHT, 'r'],
  [BUMPER_RIGHT, 'z'],
  [BUMPER_LEFT, 'z'],
  [START, 'start'],
]
const BUTTONS: Record<System, [number, Button][]> = { snes: SNES_BUTTONS, n64: N64_BUTTONS, ps2: PS2_BUTTONS, gc: GC_BUTTONS }

export interface GamepadEvents {
  /** Which system's mapping to use, or undefined while input shouldn't reach a game. */
  system(): System | undefined
  press(player: number, button: Button, down: boolean): void
  stick(player: number, x: number, y: number, stick: 0 | 1): void
  /** The pad's home or back+start: open the pause menu. */
  menu(): void
}

interface PadState {
  buttons: Set<Button>
  x: number
  y: number
  /** the right stick, on systems that have one */
  x2: number
  y2: number
  menu: boolean
}

const IDLE: PadState = { buttons: new Set(), x: 0, y: 0, x2: 0, y2: 0, menu: false }

export class Gamepads {
  private readonly pads = new Map<number, PadState>() // by player
  private frame = 0
  /** Xbox One pads the Gamepad API can't see, read over WebUSB; they come after the others. */
  readonly usb = new UsbPads(() => this.start())

  constructor(private readonly events: GamepadEvents) {
    // browsers only report pads after a button press, so polling starts with the first one
    window.addEventListener('gamepadconnected', () => this.start())
    window.addEventListener('gamepaddisconnected', () => this.start())
  }

  /** Lets go of everything held, e.g. when the menu opens. */
  releaseAll() {
    for (const player of this.pads.keys()) this.apply(player, IDLE)
  }

  private start() {
    if (!this.frame) this.frame = requestAnimationFrame(this.poll)
  }

  private readonly poll = () => {
    this.frame = 0
    const browserPads: PadReading[] = navigator.getGamepads?.().filter((pad): pad is Gamepad => !!pad?.connected) ?? []
    const pads = [...browserPads, ...this.usb.list]
    const system = this.events.system()
    // the first connected pad is player 1, the next player 2, and so on
    const seen = new Set<number>()
    if (system) {
      pads.forEach((pad, i) => {
        seen.add(i + 1)
        this.apply(i + 1, read(pad, system))
      })
    }
    for (const player of this.pads.keys()) if (!seen.has(player)) this.apply(player, IDLE)
    if (pads.length) this.frame = requestAnimationFrame(this.poll)
  }

  private apply(player: number, next: PadState) {
    const previous = this.pads.get(player) ?? IDLE
    for (const button of previous.buttons) if (!next.buttons.has(button)) this.events.press(player, button, false)
    for (const button of next.buttons) if (!previous.buttons.has(button)) this.events.press(player, button, true)
    if (next.x !== previous.x || next.y !== previous.y) this.events.stick(player, next.x, next.y, 0)
    if (next.x2 !== previous.x2 || next.y2 !== previous.y2) this.events.stick(player, next.x2, next.y2, 1)
    if (next.menu && !previous.menu) this.events.menu()
    this.pads.set(player, next)
  }
}

function read(pad: PadReading, system: System): PadState {
  const pressed = (index: number) => {
    const button = pad.buttons[index]
    return !!button && (button.pressed || button.value > DIGITAL_THRESHOLD)
  }
  const axis = (index: number) => pad.axes[index] ?? 0
  const buttons = new Set<Button>()
  for (const [index, button] of BUTTONS[system]) if (pressed(index)) buttons.add(button)
  for (const [index, button] of DPAD) if (pressed(index)) buttons.add(button)
  let [x, y] = deadzone(axis(0), axis(1))
  let [x2, y2] = [0, 0]
  if (system === 'ps2' || system === 'gc') [x2, y2] = deadzone(axis(2), axis(3))
  else if (system === 'n64') {
    const [cx, cy] = [axis(2), axis(3)]
    if (cx < -DIGITAL_THRESHOLD) buttons.add('cl')
    if (cx > DIGITAL_THRESHOLD) buttons.add('cr')
    if (cy < -DIGITAL_THRESHOLD) buttons.add('cu')
    if (cy > DIGITAL_THRESHOLD) buttons.add('cd')
  } else if (system === 'snes') {
    // the SNES has no stick: the left stick works the d-pad
    if (x < -DIGITAL_THRESHOLD) buttons.add('left')
    if (x > DIGITAL_THRESHOLD) buttons.add('right')
    if (y < -DIGITAL_THRESHOLD) buttons.add('up')
    if (y > DIGITAL_THRESHOLD) buttons.add('down')
    x = y = 0
  }
  return { buttons, x, y, x2, y2, menu: pressed(HOME) || (pressed(BACK) && pressed(START)) }
}

/** A round dead zone, with the push rescaled to start from zero at its edge. */
function deadzone(x: number, y: number): [number, number] {
  const length = Math.hypot(x, y)
  if (length < STICK_DEADZONE) return [0, 0]
  const push = Math.min((length - STICK_DEADZONE) / (1 - STICK_DEADZONE), 1)
  return [(x / length) * push, (y / length) * push]
}
