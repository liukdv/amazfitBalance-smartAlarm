// STUB @zos/utils: capture device console logs without writing to disk.
export const log = {
  getLogger(name) {
    const record = (level, args) => {
      const state = globalThis.__stub || (globalThis.__stub = {})
      ;(state.deviceLogs || (state.deviceLogs = [])).push({ name, level, args })
    }
    return {
      log: (...args) => record('log', args),
      error: (...args) => record('error', args),
    }
  },
}
