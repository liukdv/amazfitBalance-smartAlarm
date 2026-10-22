// STUB @zos/ui — records the widgets that get created and can fail on demand,
// to reproduce the "black screen" scenario under Node.
export const widget = {
  TEXT: 'TEXT',
  BUTTON: 'BUTTON',
  FILL_RECT: 'FILL_RECT',
  IMG: 'IMG',
  CYCLE_IMAGE_TEXT_LIST: 'CYCLE_IMAGE_TEXT_LIST',
}
export const align = { CENTER_H: 'CENTER_H', CENTER_V: 'CENTER_V', LEFT: 'LEFT' }
export const text_style = { WRAP: 'WRAP', ELLIPSIS: 'ELLIPSIS', NONE: 'NONE' }
export const prop = {
  TEXT: 'TEXT', MORE: 'MORE', VISIBLE: 'VISIBLE', LIST_TOP: 'LIST_TOP', ITEM_MORE: 'ITEM_MORE',
}

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
    itemStyles: {},
    topIndex: 0,
    enabled: true,
    setEnable(value) {
      this.enabled = value
    },
    setProperty(k, v) {
      this.props[k] = v
      if (k === prop.MORE) {
        const properties = { ...v }
        // BUTTON background colors cannot be changed with setProperty on API 3.7.
        if (type === widget.BUTTON) {
          delete properties.normal_color
          delete properties.press_color
        }
        Object.assign(this.props, properties)
      }
      if (k === prop.ITEM_MORE) this.itemStyles[v.index] = { ...this.itemStyles[v.index], ...v }
      if (k === prop.LIST_TOP) {
        this.topIndex = v.index
        if (!s.silentWheelPosition && this.opts.item_focus_change_func) {
          this.opts.item_focus_change_func(this, v.index, true)
        }
      }
    },
    getProperty(k) {
      if (type === widget.CYCLE_IMAGE_TEXT_LIST && k === prop.MORE) return { index: this.topIndex }
      return this.props[k]
    },
  }
  __created.push(w)
  return w
}

export function deleteWidget(widget) {
  const index = __created.indexOf(widget)
  if (index >= 0) __created.splice(index, 1)
}

// Scroll independently of LIST_TOP; the callback index need not be the middle row.
export function __scrollTo(list, topIndex, focusIndex = topIndex) {
  list.topIndex = topIndex
  list.opts.item_focus_change_func(list, focusIndex, true)
}
