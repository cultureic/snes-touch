// Mobile browsers start an AudioContext suspended unless it is created inside a tap,
// and the emulator creates its context after the core finishes loading. Track every
// context the page makes so a later tap can resume it.
const contexts = new Set<AudioContext>()
// Everything played into a tracked context is mirrored here, so the host can stream it.
const taps = new WeakMap<BaseAudioContext, MediaStreamAudioDestinationNode>()

export function trackAudioContexts() {
  const Native = window.AudioContext ?? window.webkitAudioContext
  if (!Native) return
  class TrackedAudioContext extends Native {
    constructor(options?: AudioContextOptions) {
      super(options)
      contexts.add(this)
      taps.set(this, this.createMediaStreamDestination())
    }
  }
  window.AudioContext = TrackedAudioContext
  window.webkitAudioContext = TrackedAudioContext

  const connect = AudioNode.prototype.connect as (this: AudioNode, ...args: unknown[]) => unknown
  AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
    const result = connect.apply(this, args)
    const tap = args[0] instanceof AudioDestinationNode ? taps.get(this.context) : undefined
    if (tap) connect.call(this, tap)
    return result
  } as unknown as typeof AudioNode.prototype.connect

  // iOS: play game sound even when the ring/silent switch is on.
  if (navigator.audioSession) navigator.audioSession.type = 'playback'
}

/** The running game's sound as a MediaStream (for multiplayer). */
export function gameAudioStream() {
  const context = [...contexts].at(-1)
  return context && taps.get(context)?.stream
}

export function unlockAudio() {
  for (const context of contexts) {
    // Safari uses "interrupted" after calls and app switches
    if (context.state !== 'running' && context.state !== 'closed') void context.resume().catch(() => undefined)
  }
}

export function closeAudio() {
  for (const context of contexts) void context.close().catch(() => undefined)
  contexts.clear()
}
