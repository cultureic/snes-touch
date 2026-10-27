// Xbox One and Series controllers on USB, read over WebUSB (Chrome and Edge on desktop).
// macOS has no driver for third-party ones (a Hyperkin X91, say), so the browser's Gamepad API
// never sees them. They speak Microsoft's GIP protocol: send "power on" and they stream input
// packets. The layout below is the one Linux's xpad driver documents.

const GIP_INPUT = 0x20
const GIP_GUIDE = 0x07 // the Xbox button has packets of its own
const GIP_ACK_REQUESTED = 0x10
const POWER_ON = [0x05, 0x20, 0x00, 0x01, 0x00]
const XBOX_ONE = { classCode: 0xff, subclassCode: 0x47, protocolCode: 0xd0 }

// Minimal WebUSB types (not in TypeScript's DOM library).
interface UsbEndpoint {
  endpointNumber: number
  direction: 'in' | 'out'
}
interface UsbInterface {
  interfaceNumber: number
  alternates: { interfaceClass: number; interfaceSubclass: number; interfaceProtocol: number; endpoints: UsbEndpoint[] }[]
}
interface UsbDevice {
  productName?: string
  opened: boolean
  configuration: { interfaces: UsbInterface[] } | null
  open(): Promise<void>
  close(): Promise<void>
  selectConfiguration(value: number): Promise<void>
  claimInterface(number: number): Promise<void>
  transferIn(endpoint: number, length: number): Promise<{ data?: DataView; status: string }>
  transferOut(endpoint: number, data: Uint8Array<ArrayBuffer>): Promise<unknown>
}
interface Usb extends EventTarget {
  getDevices(): Promise<UsbDevice[]>
  requestDevice(options: { filters: object[] }): Promise<UsbDevice>
}

const usb = () => (navigator as Navigator & { usb?: Usb }).usb

/** A pad in the shape the app reads from the Gamepad API's "standard" layout. */
export interface PadReading {
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[]
  readonly axes: readonly number[]
}

class UsbPad implements PadReading {
  buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }))
  axes = [0, 0, 0, 0]
  connected = true
  private sequence = 1

  constructor(
    readonly device: UsbDevice,
    private readonly inEndpoint: number,
    private readonly outEndpoint: number,
  ) {}

  async run(onChange: () => void) {
    await this.send(POWER_ON)
    try {
      while (this.connected) {
        const { data } = await this.device.transferIn(this.inEndpoint, 64)
        if (data && this.receive(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))) onChange()
      }
    } catch {
      // unplugged
    }
    this.connected = false
    onChange()
  }

  private receive(data: Uint8Array) {
    if (data.length >= 4 && data[1] & GIP_ACK_REQUESTED) void this.ack(data)
    if (data[0] === GIP_GUIDE && data.length >= 5) {
      this.set(16, data[4] & 0x01)
      return true
    }
    if (data[0] !== GIP_INPUT || data.length < 18) return false
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const [face, rest] = [data[4], data[5]]
    // standard layout: 0 A, 1 B, 2 X, 3 Y, 4/5 bumpers, 6/7 triggers, 8 back, 9 start,
    // 10/11 stick clicks, 12-15 d-pad up/down/left/right
    this.set(0, face & 0x10)
    this.set(1, face & 0x20)
    this.set(2, face & 0x40)
    this.set(3, face & 0x80)
    this.set(4, rest & 0x10)
    this.set(5, rest & 0x20)
    this.set(6, view.getUint16(6, true) / 1023)
    this.set(7, view.getUint16(8, true) / 1023)
    this.set(8, face & 0x08)
    this.set(9, face & 0x04)
    this.set(10, rest & 0x40)
    this.set(11, rest & 0x80)
    this.set(12, rest & 0x01)
    this.set(13, rest & 0x02)
    this.set(14, rest & 0x04)
    this.set(15, rest & 0x08)
    // GIP's y axes point up; the Gamepad API's point down
    this.axes = [
      view.getInt16(10, true) / 32767,
      -view.getInt16(12, true) / 32767,
      view.getInt16(14, true) / 32767,
      -view.getInt16(16, true) / 32767,
    ].map((value) => Math.max(-1, Math.min(1, value)))
    return true
  }

  private set(index: number, value: number) {
    const amount = value > 1 ? 1 : value > 0 && value < 1 ? value : value ? 1 : 0
    this.buttons[index] = { pressed: amount > 0.5, value: amount }
  }

  private ack(data: Uint8Array) {
    return this.send([0x01, 0x20, data[2], 0x09, 0x00, data[0], 0x20, data[3], 0x00, 0x00, 0x00, 0x00, 0x00])
  }

  private send(bytes: number[]) {
    const packet = [...bytes]
    if (packet[0] !== 0x01) packet[2] = this.sequence++ & 0xff
    return this.device.transferOut(this.outEndpoint, new Uint8Array(packet)).catch(() => undefined)
  }
}

export class UsbPads {
  private readonly pads: UsbPad[] = []

  constructor(private readonly onChange: () => void) {
    const api = usb()
    if (!api) return
    // pads allowed on an earlier visit come back without asking again
    api.addEventListener('connect', (event) => void this.attach((event as Event & { device: UsbDevice }).device))
    void api.getDevices().then((devices) => devices.forEach((device) => void this.attach(device)))
  }

  static get supported() {
    return !!usb()
  }

  /** Connected pads, in the order they were plugged in. */
  get list(): PadReading[] {
    return this.pads.filter((pad) => pad.connected)
  }

  /** Asks the browser for a controller; call it from a tap or click. */
  async request() {
    const api = usb()
    if (!api) throw new Error('this browser has no USB access')
    const device = await api.requestDevice({ filters: [XBOX_ONE, { vendorId: 0x2e24 }] })
    await this.attach(device)
    return device.productName ?? 'Controller'
  }

  private async attach(device: UsbDevice) {
    if (this.pads.some((pad) => pad.device === device && pad.connected)) return
    if (!device.opened) await device.open()
    if (!device.configuration) await device.selectConfiguration(1)
    const iface = device.configuration?.interfaces.find(({ alternates: [setting] }) =>
      setting.interfaceClass === XBOX_ONE.classCode && setting.interfaceSubclass === XBOX_ONE.subclassCode,
    )
    const endpoints = iface?.alternates[0].endpoints ?? []
    const inEndpoint = endpoints.find(({ direction }) => direction === 'in')
    const outEndpoint = endpoints.find(({ direction }) => direction === 'out')
    if (!iface || !inEndpoint || !outEndpoint) throw new Error(`${device.productName ?? 'That device'} isn't an Xbox One controller`)
    await device.claimInterface(iface.interfaceNumber)
    const pad = new UsbPad(device, inEndpoint.endpointNumber, outEndpoint.endpointNumber)
    this.pads.push(pad)
    void pad.run(this.onChange)
    this.onChange()
  }
}
