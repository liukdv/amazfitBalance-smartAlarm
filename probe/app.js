// Entry point.
//
// BaseApp is not decorative: it is what initialises the message channel towards
// the phone. Without it, `this.request` inside the pages is undefined and the
// log upload fails with "cannot read property 'request' of undefined".
import { BaseApp } from '@zeppos/zml/base-app'

App(
  BaseApp({
    globalData: {},
    onCreate() {},
    onDestroy() {},
  })
)
