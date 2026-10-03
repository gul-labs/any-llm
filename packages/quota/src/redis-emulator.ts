/**
 * A test double for the Redis the Upstash store talks to: in-memory counters and
 * a faithful JS port of the two EVAL scripts' logic. Each EVAL runs as one
 * uninterrupted step, like Redis. Used by tests only; not part of the package.
 *
 * @module
 */

import type { UpstashPipelineCommand } from './index.js'

/** In-memory Redis counters + a faithful JS port of the EVAL script's logic. */
export function makeRedisEmulator() {
  const counters = new Map<string, number>()
  const commands: UpstashPipelineCommand[] = []

  async function invoke(cmds: readonly UpstashPipelineCommand[]) {
    await Promise.resolve() // yield: callers interleave, each EVAL stays atomic
    return cmds.map((cmd) => {
      commands.push(cmd)
      const [name, script, numKeys, ...rest] = cmd
      if (name !== 'EVAL') throw new Error(`unexpected command ${String(name)}`)
      const n = Number(numKeys)
      const keys = rest.slice(0, n).map(String)
      const argv = rest.slice(n).map(Number)
      const arg = (i: number): number => argv[i] ?? 0
      if (!String(script).includes('PEXPIRE')) {
        // The token-reconciliation script: add the signed delta to a live counter,
        // never below 0; a counter that is gone is left alone.
        const key = keys[0] ?? ''
        const current = counters.get(key)
        if (current === undefined) return { result: 0 }
        const next = Math.max(current + arg(0), 0)
        counters.set(key, next)
        return { result: next }
      }
      const counts = keys.map((k) => counters.get(k) ?? 0)
      // limit, ttl, cost per key: a window refuses at its limit, or when the cost
      // would cross it and the counter is not empty.
      const ok = counts.every((c, i) => {
        const limit = arg(3 * i)
        const cost = arg(3 * i + 2)
        return !(c >= limit || (c > 0 && c + cost > limit))
      })
      if (ok) {
        keys.forEach((k, i) => {
          const next = (counts[i] ?? 0) + arg(3 * i + 2)
          counters.set(k, next)
          counts[i] = next
        })
      }
      return { result: [ok ? 1 : 0, ...counts] }
    })
  }

  return { counters, commands, invoke }
}
