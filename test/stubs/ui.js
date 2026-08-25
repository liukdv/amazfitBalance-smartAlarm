// STUB @zos/ui — records the widgets that get created and can fail on demand,
// to reproduce the "black screen" scenario under Node.
export const widget = {
  TEXT: 'TEXT',
  BUTTON: 'BUTTON',
  FILL_RECT: 'FILL_RECT',
  IMG: 'IMG',
}
export const align = { CENTER_H: 'CENTER_H', CENTER_V: 'CENTER_V', LEFT: 'LEFT' }
export const text_style = { WRAP: 'WRAP', ELLIPSIS: 'ELLIPSIS', NONE: 'NONE' }
export const prop = { TEXT: 'TEXT', MORE: 'MORE', VISIBLE: 'VISIBLE' }

export const __created = []
export function __reset() {
  __created.length = 0
}
export function __byType(t) {
  return __created.filter((w) => w.type === t)
}

export function createWidget(type, opts) {
  const s = globalThis.__stub || {}
  if (s.throwOnWidget && s.throwOnWidget === type)
    throw new Error('createWidget ' + type + ' not supported')
  const w = {
    type,
    opts,
    props: { ...opts },
    setProperty(k, v) {
      this.props[k] = v
    },
    getProperty(k) {
      return this.props[k]
    },
  }
  __created.push(w)
  return w
}

export function deleteWidget() {}
