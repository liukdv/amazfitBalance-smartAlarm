// App entry point and shared alarm launch context.
import { BaseApp } from '@zeppos/zml/base-app'
import { log } from '@zos/utils'

const startupLog = log.getLogger('SmartAlarm.startup')

const definition = BaseApp({
  globalData: {},
  onCreate(params) {
    this.globalData.alarmLaunch = params
  },
  onDestroy() {},
})

// Wrap the ZML hooks too: a failure in a mixin precedes our own callback.
for (const name of ['onCreate', 'onDestroy']) {
  const callback = definition[name]
  if (typeof callback !== 'function') continue
  definition[name] = function (...args) {
    try {
      return callback.apply(this, args)
    } catch (error) {
      startupLog.error('app ' + name + ' failed: ' + String(error),
        String(error && error.stack || ''))
      throw error
    }
  }
}
App(definition)
