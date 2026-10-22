import * as hmUI from '@zos/ui'
import { BasePage } from '@zeppos/zml/base-page'
import { back } from '@zos/router'
import { getDeviceInfo } from '@zos/device'
import { onDigitalCrown, offDigitalCrown, KEY_HOME } from '@zos/interaction'
import { getAlarm, saveAlarm, deleteAlarm, alarmEnabled } from '../utils/alarms'
import { load } from '../utils/store'
import { logEvent } from '../utils/log'
import { WEEKDAYS, fmtDays, fmtTime, normalizeDays } from '../utils/schedule'

const wrap = (value, size) => (value % size + size) % size
const twoDigits = (value) => (value < 10 ? '0' : '') + value

Page(
  BasePage({
    onInit(params) {
      try {
        const data = typeof params === 'string' ? JSON.parse(params) : params
        this.id = data && data.id
      } catch (e) {
        this.id = null
      }
    },

    build() {
      this.timeWidgets = []
      this.dayWidgets = []
      this.bedtimeWidgets = []
      this.view = 'time'
      const alarm = getAlarm(this.id)
      const defaults = load()
      this.hour = alarm ? alarm.alarmH : defaults.alarmH
      this.minute = alarm ? alarm.alarmM : defaults.alarmM
      this.enabled = !alarm || alarmEnabled(alarm)
      this.days = normalizeDays(alarm ? alarm.weekdays : [])
      this.bedtimeMin = alarm ? (alarm.bedtimeMin || 0) : 0
      this.bedtimeEnabled = this.bedtimeMin > 0
      this.bedtimeHour = this.bedtimeEnabled ? Math.floor(this.bedtimeMin / 60) : 8
      this.bedtimeMinute = this.bedtimeMin % 60
      this.selected = 'hour'
      this.ready = false
      let w = 480, h = 480
      try {
        const device = getDeviceInfo()
        w = device.width || w
        h = device.height || h
      } catch (e) {}
      this.width = w
      this.height = h
      const left = Math.round(w * 0.18)
      const column = Math.round(w * 0.29)
      const right = w - left - column
      const label = (y, text, color = 0xffffff) => this.widget(hmUI.widget.TEXT, {
        x: w * 0.15, y, w: w * 0.7, h: 32, text,
        text_size: 22, color, align_h: hmUI.align.CENTER_H,
      })
      this.title = alarm ? 'Edit alarm' : 'New alarm'
      this.hintText = label(h * 0.06, this.title)
      this.hourButton = this.button(left, h * 0.14, column, 'HOUR',
        () => this.select('hour'))
      this.minuteButton = this.button(right, h * 0.14, column, 'MINUTE',
        () => this.select('minute'))
      const itemHeight = Math.round(h * 0.095)
      const makeWheel = (field, x, size) => this.widget(hmUI.widget.CYCLE_IMAGE_TEXT_LIST, {
        x, y: Math.round(h * 0.25), w: column, h: itemHeight * 3,
        item_height: itemHeight, item_bg_color: 0x16161d,
        item_image_x: 0, item_image_y: 0,
        item_text_x: 0, item_text_y: 0, item_text_width: column,
        item_text_height: itemHeight, item_text_size: Math.min(42, itemHeight - 4),
        item_text_color: 0x777788, item_text_align_h: hmUI.align.CENTER_H,
        item_text_align_v: hmUI.align.CENTER_V,
        data_array: Array.from({ length: size }, (_, i) => ({ text: twoDigits(i) })),
        data_size: size,
        item_focus_change_func: (list, _index, focused) => {
          if (!focused || !this.ready) return
          const center = wrap(list.getProperty(hmUI.prop.MORE, {}).index + 1, size)
          this[this.fieldFor(field)] = center
          this.highlightCenter(list, center, size)
          this.select(field)
        },
        item_click_func: (list, index) => {
          this[this.fieldFor(field)] = index
          this.select(field)
          this.position(field)
        },
      })
      this.hourWheel = makeWheel('hour', left, 24)
      this.minuteWheel = makeWheel('minute', right, 60)
      this.sharedWidgets = [this.hintText, this.hourButton, this.minuteButton, this.hourWheel, this.minuteWheel]
      this.position('hour')
      this.position('minute')
      this.ready = true
      this.select('hour')
      this.daysButton = this.button(w * 0.15, h * 0.56, w * 0.7,
        'DAYS: ' + fmtDays(this.days), () => this.showDays())
      this.bedtimeButton = this.button(w * 0.15, h * 0.68, w * 0.7,
        this.bedtimeLabel(), () => this.showBedtime())
      if (alarm) {
        this.bottomAction('left', 'DELETE', () => {
          deleteAlarm(this.id)
          back()
        }, 0x9a303a)
      }
      this.bottomAction('right', 'SAVE', () => this.save(), 0x238052)
      try {
        onDigitalCrown({
          callback: (key, degree) => {
            if (this.view === 'days' || key !== KEY_HOME || !degree) return
            const field = this.selected
            const draft = this.fieldFor(field)
            const step = Math.max(1, Math.min(5, Math.round(Math.abs(degree) / 12)))
            this[draft] = wrap(this[draft] + (degree < 0 ? step : -step), field === 'hour' ? 24 : 60)
            this.position(field)
          },
        })
      } catch (e) {
        logEvent('EDITOR crown unavailable', { error: String(e) })
      }
    },

    // All views share one unsaved draft; leaving the editor discards it.
    showDays() {
      this.timeWidgets.forEach((widget) => widget.setProperty(hmUI.prop.VISIBLE, false))
      this.view = 'days'
      if (this.dayWidgets.length) {
        this.dayWidgets.forEach((widget) => widget.setProperty(hmUI.prop.VISIBLE, true))
        return
      }
      const w = this.width, h = this.height
      this.daysTitle = this.widget(hmUI.widget.TEXT, {
        x: w * 0.15, y: h * 0.07, w: w * 0.7, h: 32,
        text: '', text_size: 24, color: 0xffffff, align_h: hmUI.align.CENTER_H,
      })
      this.dayButtons = []
      this.daySelection = []
      const presets = [
        { label: 'Weekdays', days: [1, 2, 3, 4, 5] },
        { label: 'Weekend', days: [6, 0] },
      ]
      presets.forEach(({ label, days }, index) => {
        this.button(w * (0.38 + 0.26 * index), h * 0.6, w * 0.24, label, () => {
          this.days = days.slice()
          this.refreshDays()
        }, 0x30303a, h * 0.13, 20)
      })
      this.bottomAction('full', 'DONE', () => {
        this.dayWidgets.forEach((widget) => widget.setProperty(hmUI.prop.VISIBLE, false))
        this.view = 'time'
        this.timeWidgets.forEach((widget) => widget.setProperty(hmUI.prop.VISIBLE, true))
        this.daysButton.setProperty(hmUI.prop.TEXT, 'DAYS: ' + fmtDays(this.days))
      }, 0x238052)
      this.refreshDays()
    },

    refreshDays() {
      // API 3.7 cannot update BUTTON colors; recreate only changed selections.
      const w = this.width, h = this.height
      this.daysTitle.setProperty(hmUI.prop.TEXT, this.days.length ? 'Repeat on' : 'Once')
      WEEKDAYS.forEach(({ day, label }, index) => {
        const selected = this.days.includes(day)
        const button = this.dayButtons[index]
        if (button && this.daySelection[index] === selected) return
        if (button) {
          hmUI.deleteWidget(button)
          this.dayWidgets.splice(this.dayWidgets.indexOf(button), 1)
        }
        const column = index % 3
        this.dayButtons[index] = this.button(w * (0.12 + 0.26 * column), h * (0.22 + 0.19 * Math.floor(index / 3)),
          w * 0.24, label, () => {
            this.days = normalizeDays(this.days.includes(day)
              ? this.days.filter((value) => value !== day) : this.days.concat(day))
            this.refreshDays()
          }, selected ? 0x285fa5 : 0x30303a, h * 0.13, 24)
        this.daySelection[index] = selected
      })
    },

    /** Reuse the time wheels for a duration while keeping the alarm time intact. */
    showBedtime() {
      this.timeWidgets.forEach((widget) => widget.setProperty(hmUI.prop.VISIBLE, false))
      this.view = 'bedtime'
      this.sharedWidgets.forEach((widget) => widget.setProperty(hmUI.prop.VISIBLE, true))
      this.hintText.setProperty(hmUI.prop.TEXT, 'Remind before alarm')
      this.hourButton.setProperty(hmUI.prop.TEXT, 'HOURS')
      this.minuteButton.setProperty(hmUI.prop.TEXT, 'MINUTES')
      this.ready = false
      this.position('hour')
      this.position('minute')
      this.ready = true
      this.select('hour')
      if (this.bedtimeWidgets.length) {
        this.bedtimeWidgets.forEach((widget) => widget.setProperty(hmUI.prop.VISIBLE, true))
        return
      }
      const w = this.width, h = this.height
      this.bedtimeToggle = this.button(w * 0.15, h * 0.61, w * 0.7,
        'REMINDER: ' + (this.bedtimeEnabled ? 'ON' : 'OFF'), () => {
          this.bedtimeEnabled = !this.bedtimeEnabled
          this.bedtimeToggle.setProperty(hmUI.prop.TEXT, 'REMINDER: ' + (this.bedtimeEnabled ? 'ON' : 'OFF'))
        })
      this.bottomAction('full', 'DONE', () => {
        const minutes = this.bedtimeHour * 60 + this.bedtimeMinute
        if (this.bedtimeEnabled && !minutes) {
          this.hintText.setProperty(hmUI.prop.TEXT, 'Choose at least 1 minute')
          return
        }
        this.bedtimeMin = this.bedtimeEnabled ? minutes : 0
        this.bedtimeWidgets.forEach((widget) => widget.setProperty(hmUI.prop.VISIBLE, false))
        this.view = 'time'
        this.timeWidgets.forEach((widget) => widget.setProperty(hmUI.prop.VISIBLE, true))
        this.ready = false
        this.position('hour')
        this.position('minute')
        this.ready = true
        this.hintText.setProperty(hmUI.prop.TEXT, this.title)
        this.hourButton.setProperty(hmUI.prop.TEXT, 'HOUR')
        this.minuteButton.setProperty(hmUI.prop.TEXT, 'MINUTE')
        this.bedtimeButton.setProperty(hmUI.prop.TEXT, this.bedtimeLabel())
      }, 0x238052)
    },

    /** Describe the saved draft duration, not a wall-clock bedtime. */
    bedtimeLabel() {
      return 'BEDTIME: ' + (this.bedtimeMin
        ? fmtTime(Math.floor(this.bedtimeMin / 60), this.bedtimeMin % 60) + ' before' : 'OFF')
    },

    /** Route shared wheel and crown input to the active draft fields. */
    fieldFor(field) {
      return this.view === 'bedtime' ? (field === 'hour' ? 'bedtimeHour' : 'bedtimeMinute') : field
    },

    widget(type, options) {
      const widget = hmUI.createWidget(type, options)
      ;(this.view === 'days' ? this.dayWidgets : this.view === 'bedtime' ? this.bedtimeWidgets : this.timeWidgets).push(widget)
      return widget
    },

    // LIST_TOP addresses the first row; the selected value is in the middle.
    position(field) {
      const wheel = field === 'hour' ? this.hourWheel : this.minuteWheel
      const size = field === 'hour' ? 24 : 60
      const center = this[this.fieldFor(field)]
      const ready = this.ready
      this.ready = false
      try {
        wheel.setProperty(hmUI.prop.LIST_TOP, { index: wrap(center - 1, size) })
        // Positioning may not emit a focus event, including on first opening.
        this.highlightCenter(wheel, center, size)
      } finally {
        this.ready = ready
      }
    },

    /** Highlight the middle row and dim its two visible neighbours. */
    highlightCenter(list, center, size) {
      for (const offset of [-1, 0, 1]) {
        list.setProperty(hmUI.prop.ITEM_MORE, {
          index: wrap(center + offset, size),
          item_text_color: offset === 0 ? 0xffffff : 0x777788,
        })
      }
    },

    select(field) {
      if (this.selected === field) return
      this.selected = field
      this.hourButton.setProperty(hmUI.prop.MORE, { normal_color: field === 'hour' ? 0x285fa5 : 0x30303a })
      this.minuteButton.setProperty(hmUI.prop.MORE, { normal_color: field === 'minute' ? 0x285fa5 : 0x30303a })
    },

    // The display clips these rectangles into a circular segment; labels stay inside its curve.
    bottomAction(side, text, callback, color) {
      const w = this.width, h = this.height
      const full = side === 'full', right = side === 'right'
      const y = Math.round(h * 0.8)
      const middle = Math.round(w / 2)
      const x = right ? middle + 1 : 0
      const width = full ? w : right ? w - x : middle - 1
      this.button(x, y, width, '', callback, color, h - y, 22, 0)
      const label = this.widget(hmUI.widget.TEXT, {
        x: Math.round(w * (full ? 0.39 : right ? 0.56 : 0.22)), y: Math.round(h * 0.84),
        w: Math.round(w * 0.22), h: 32, text, text_size: 22, color: 0xffffff,
        align_h: hmUI.align.CENTER_H, align_v: hmUI.align.CENTER_V,
      })
      // Touches on the label must reach the button underneath.
      label.setEnable(false)
    },

    button(x, y, w, text, callback, color = 0x30303a, height = 48, textSize = 20, radius = height / 2) {
      return this.widget(hmUI.widget.BUTTON, {
        x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(height),
        text, text_size: textSize, color: 0xffffff, radius: Math.round(radius),
        normal_color: color, press_color: 0x555566,
        click_func: () => {
          try { callback() } catch (e) {
            if (e.alarmId) this.id = e.alarmId
            logEvent('EDITOR ERROR', { id: this.id, error: String(e), stack: e && e.stack })
            if (this.hintText) this.hintText.setProperty(hmUI.prop.TEXT, e.message || String(e))
          }
        },
      })
    },

    save() {
      const value = saveAlarm(this.id, this.hour, this.minute, this.enabled, this.days, this.bedtimeMin)
      this.id = value.id
      if (value.bedtimeError) throw new Error(value.bedtimeError)
      back()
    },

    onDestroy() {
      offDigitalCrown()
    },
  })
)
