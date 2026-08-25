// Resolves the '@zos/*' imports towards the stubs in test/stubs/.
//
// Why a loader and not node_modules/@zos: any `npm install` deletes packages
// that are not in package.json ("removed 5 packages") and the tests stop working
// for no apparent reason. It has happened.
import { fileURLToPath } from 'node:url'

const STUBS = new URL('./stubs/', import.meta.url)

export async function resolve(specifier, context, next) {
  // The messaging library: in the tests it talks to no phone at all.
  if (specifier.startsWith('@zeppos/zml/')) {
    const name = specifier.slice('@zeppos/zml/'.length)
    return { url: new URL(name + '.js', STUBS).href, shortCircuit: true, format: 'module' }
  }

  if (specifier.startsWith('@zos/')) {
    const name = specifier.slice('@zos/'.length)
    const url = new URL(name + '.js', STUBS)
    try {
      fileURLToPath(url)
      return { url: url.href, shortCircuit: true, format: 'module' }
    } catch (e) {
      throw new Error('missing stub for ' + specifier + ' — create it in test/stubs/' + name + '.js')
    }
  }

  // The zeus bundler accepts relative imports without an extension
  // ('../utils/log'), Node does not: here we add .js so the tests run against
  // the real sources, not against copies.
  if (specifier.startsWith('.') && !/\.[mc]?js$/.test(specifier)) {
    try {
      return await next(specifier + '.js', context)
    } catch (e) {
      return next(specifier, context)
    }
  }

  return next(specifier, context)
}
