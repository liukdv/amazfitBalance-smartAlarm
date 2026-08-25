// STUB @zos/app
export function getPackageInfo() {
  const s = globalThis.__stub || {}
  if (s.throwPackageInfo) throw new Error('packageInfo boom')
  return { appId: 1043001, appName: 'SmartAlarm' }
}

export function queryPermission({ permissions }) {
  const s = globalThis.__stub || {}
  if (s.throwQueryPermission) throw new Error('queryPermission not supported')
  return permissions.map(() => (s.permGranted === false ? 0 : 2))
}

export function requestPermission({ permissions, callback }) {
  const s = globalThis.__stub || {}
  s.permissionAsked = (s.permissionAsked || []).concat(permissions)
  if (s.throwRequestPermission) throw new Error('requestPermission boom')
  if (callback) callback(permissions.map(() => (s.permGranted === false ? 0 : 2)))
  return s.permGranted === false ? 0 : 2
}
