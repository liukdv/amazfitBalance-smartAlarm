import * as hmUI from '@zos/ui'
import { BasePage } from '@zeppos/zml/base-page'
import { push } from '@zos/router'
import { getDeviceInfo } from '@zos/device'
import { onGesture, offGesture, GESTURE_LEFT } from '@zos/interaction'
import { log } from '@zos/utils'
import { logEvent } from '../utils/log'
import { initAlarms, listAlarms, saveAlarm, alarmContext, alarmEnabled } from '../utils/alarms'
import { askPermissions } from '../utils/perm'
import { fmtTime, fmtDays } from '../utils/schedule'

const startupLog = log.getLogger('SmartAlarm.startup')

const definition = BasePage({
    build() {
      this.widgets = []
      this.rows = null
      askPermissions(null)
      this.refresh()
      this.bindGesture()
    },

    onResume() {
      if (this.widgets) {
        this.refresh()
        this.bindGesture()
      }
    },

    onPause() {
      offGesture()
    },

    onDestroy() {
      offGesture()
    },

    /** Keep diagnostics navigation on the alarm list, preserving other gestures. */
    bindGesture() {
      // Zepp permits only one listener, including when this page resumes.
      offGesture()
      onGesture({
        callback: (event) => {
          if (event !== GESTURE_LEFT) return false
          try { push({ url: 'page/debug' }) } catch (e) { this.showError(e) }
          return true
        },
      })
    },

    /** Reread shared alarm state, keeping widgets when the row layout is unchanged. */
    refresh() {
      try { this.refreshRows() } catch (e) {
        this.rows = null
        this.showError(e)
      }
    },

    refreshRows() {
      let values = [], readError
      try {
        initAlarms()
        values = listAlarms()
      } catch (e) { readError = e }
      let w = 480
      try { w = getDeviceInfo().width || w } catch (e) {}
      if (!readError && this.width === w && this.rows && this.rows.length === values.length &&
          this.rows.every((row, index) => row.alarm.id === values[index].id)) {
        this.rows.forEach((row, index) => this.updateRow(row, values[index]))
        if (this.errorMessage) {
          this.errorText.setProperty(hmUI.prop.TEXT, '')
          this.errorMessage = ''
        }
        return
      }
      this.widgets.forEach((widget) => hmUI.deleteWidget(widget))
      this.widgets = []
      this.rows = []
      this.width = w
      const x = Math.round(w * 0.12)
      const width = w - 2 * x
      this.text(30, 'Smart alarms', 30)
      this.button(x, 80, width, '+ ADD ALARM', () => this.edit(null))
      this.errorText = this.text(136, '', 16, 0xff8888)
      this.errorMessage = ''
      let y = 176
      values.forEach((alarm) => {
        const row = { alarm, y, time: fmtTime(alarm.alarmH, alarm.alarmM), label: this.rowLabel(alarm) }
        row.timeButton = this.button(x, y, width - 100, row.time,
          () => this.edit(row.alarm.id), 0x25252d, 36)
        row.detailText = this.text(y + 57, row.label, 16, 0xaaaaaa)
        this.updateRow(row, alarm)
        this.rows.push(row)
        y += 98
      })
      if (readError) {
        this.rows = null
        this.showError(readError)
      } else if (!values.length) {
        this.text(y, 'No alarms', 22, 0xaaaaaa)
        y += 70
      }
      // Bottom padding lets the last row scroll into the usable round area.
      this.text(y + 60, ' ', 14)
    },

    rowLabel(alarm) {
      let label = 'Off'
      if (alarm.mode === 'ringing') label = 'Ringing'
      else if (alarmEnabled(alarm)) {
        const minutes = Math.max(0, Math.ceil((alarm.targetUnix - Date.now() / 1000) / 60))
        label = 'In ' + Math.floor(minutes / 60) + 'h ' + minutes % 60 +
          'm · window ' + Math.round(alarm.windowSec / 60) + ' min'
      }
      return fmtDays(alarm.weekdays) + '\n' + label
    },

    /** Update changed labels; API 3.7 requires a new button for a changed color. */
    updateRow(row, alarm) {
      row.alarm = alarm
      const time = fmtTime(alarm.alarmH, alarm.alarmM)
      const label = this.rowLabel(alarm)
      if (row.time !== time) row.timeButton.setProperty(hmUI.prop.TEXT, time)
      if (row.label !== label) row.detailText.setProperty(hmUI.prop.TEXT, label)
      row.time = time
      row.label = label
      const active = alarmEnabled(alarm)
      if (row.active === active) return
      if (row.toggle) {
        hmUI.deleteWidget(row.toggle)
        this.widgets.splice(this.widgets.indexOf(row.toggle), 1)
      }
      row.active = active
      const x = Math.round(this.width * 0.12)
      row.toggle = this.button(this.width - x - 90, row.y, 90, active ? 'ON' : 'OFF', () => {
        const current = row.alarm
        if (alarmEnabled(current)) alarmContext(current).stop()
        else saveAlarm(current.id, current.alarmH, current.alarmM, true)
        this.refresh()
      }, active ? 0x22664a : 0x33333b)
    },

    edit(id) {
      push({ url: 'page/edit', params: JSON.stringify({ id }) })
    },

    text(y, text, size, color = 0xffffff) {
      const widget = hmUI.createWidget(hmUI.widget.TEXT, {
        x: this.width * 0.1, y, w: this.width * 0.8, h: 40,
        text, text_size: size, color,
        align_h: hmUI.align.CENTER_H, text_style: hmUI.text_style.WRAP,
      })
      this.widgets.push(widget)
      return widget
    },

    button(x, y, w, text, callback, color = 0x285fa5, size = 22) {
      const widget = hmUI.createWidget(hmUI.widget.BUTTON, {
        x, y, w, h: 56, radius: 24, text, text_size: size,
        color: 0xffffff, normal_color: color, press_color: 0x555566,
        click_func: () => {
          try { callback() } catch (e) { this.showError(e) }
        },
      })
      this.widgets.push(widget)
      return widget
    },

    showError(error) {
      startupLog.error('alarm UI failed: ' + String(error), String(error && error.stack || ''))
      logEvent('ALARM UI ERROR', { error: String(error), stack: error && error.stack })
      this.errorMessage = error.message || String(error)
      if (this.errorText) this.errorText.setProperty(hmUI.prop.TEXT, this.errorMessage)
    },
})

// Include ZML initialization, which runs before the page's build callback.
for (const name of ['onInit', 'build', 'onResume', 'onDestroy']) {
  const callback = definition[name]
  if (typeof callback !== 'function') continue
  definition[name] = function (...args) {
    try {
      return callback.apply(this, args)
    } catch (error) {
      startupLog.error('page/index ' + name + ' failed: ' + String(error),
        String(error && error.stack || ''))
      throw error
    }
  }
}
Page(definition)
