import { isBuiltin } from 'node:module'

/**
 * Module-resolution hook (runs on a separate thread, so it may use built-ins itself):
 * any import of a Node built-in from the code under test fails, the way it does on a
 * runtime that has none.
 */
export async function resolve(specifier, context, nextResolve) {
  if (isBuiltin(specifier)) {
    throw new Error(`runtime-smoke: the code imported the Node built-in "${specifier}"`)
  }
  return nextResolve(specifier, context)
}
