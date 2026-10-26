// Mobile browsers start an AudioContext suspended unless it is created inside a tap,
// and the emulator creates its context after the core finishes loading. Track every
// context the page makes so a later tap can resume it.
const contexts = new Set<AudioContext>()

export function trackAudioContexts() {
  const Native = window.AudioContext ?? window.webkitAudioContext
  if (!Native) return
  class TrackedAudioContext extends Native {
    constructor(options?: AudioContextOptions) {
      super(options)
      contexts.add(this)
    }
  }
  window.AudioContext = TrackedAudioContext
  window.webkitAudioContext = TrackedAudioContext

  // iOS: play game sound even when the ring/silent switch is on.
  if (navigator.audioSession) navigator.audioSession.type = 'playback'
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
