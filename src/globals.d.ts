interface Navigator {
  /** iOS Safari: true when launched from the home screen */
  readonly standalone?: boolean
  /** Safari 16.4+: how the page's audio mixes with other apps and the silent switch */
  readonly audioSession?: { type: string }
}

interface Window {
  webkitAudioContext?: typeof AudioContext
}
