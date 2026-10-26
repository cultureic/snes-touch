let enabled = true
let iosSwitch: HTMLLabelElement | undefined

export function setHapticsEnabled(on: boolean) {
  enabled = on
}

// A short tick when a button goes down. Android has the Vibration API; iOS has none,
// but Safari 18+ plays the system haptic when an <input switch> toggles, so fall back
// to clicking a hidden one. Older iOS versions just stay silent.
export function hapticTick() {
  if (!enabled) return
  if (typeof navigator.vibrate === 'function') {
    navigator.vibrate(12)
    return
  }
  if (!iosSwitch) {
    iosSwitch = document.createElement('label')
    iosSwitch.setAttribute('aria-hidden', 'true')
    iosSwitch.style.display = 'none'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.setAttribute('switch', '')
    iosSwitch.append(input)
    document.head.append(iosSwitch)
  }
  iosSwitch.click()
}
