// TEMPORARY diagnostic, never merged: times PGlite startup on the CI runner.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { it } from 'vitest'

const install = readFileSync(fileURLToPath(new URL('../sql/install.sql', import.meta.url)), 'utf8')

it('DIAG pglite startup', { timeout: 300_000 }, async () => {
  const rows: string[] = []
  for (let i = 0; i < 8; i++) {
    const t0 = performance.now()
    const pg = new PGlite()
    await pg.waitReady
    const t1 = performance.now()
    await pg.exec(install)
    const t2 = performance.now()
    await pg.close()
    rows.push(`#${i} ready=${(t1 - t0).toFixed(0)}ms install=${(t2 - t1).toFixed(0)}ms`)
  }
  console.log(`DIAG node=${process.version} ${rows.join(' | ')}`)
})
