export const KEY_HOME = 1
export function onDigitalCrown({ callback }) {
  globalThis.__stub.crownCallback = callback
}
export function offDigitalCrown() {
  globalThis.__stub.crownCallback = null
}

export const GESTURE_UP = 1
export const GESTURE_DOWN = 2
export const GESTURE_LEFT = 3
export const GESTURE_RIGHT = 4
export function onGesture({ callback }) {
  // Zepp keeps the first listener if another is registered without removing it.
  if (!globalThis.__stub.gestureCallback) globalThis.__stub.gestureCallback = callback
}
export function offGesture() {
  globalThis.__stub.gestureCallback = null
}
