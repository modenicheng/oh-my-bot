import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import { spawnSync } from 'node:child_process'

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-balance-'))
try {
  const source = fs.readFileSync(new URL('../bots/oracle.ts', import.meta.url), 'utf8')
  const compiled = stripTypeScriptTypes(source, { mode: 'transform' })
  const filename = path.join(temporary, 'oracle.js')
  fs.writeFileSync(filename, compiled)
  const result = spawnSync('go', ['run', './cmd/omb-balance', '-oracle', filename, ...process.argv.slice(2)], { cwd: new URL('../server/', import.meta.url), stdio: 'inherit' })
  process.exitCode = result.status ?? 1
  if (result.error) throw result.error
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
