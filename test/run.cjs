/**
 * The whole suite in one command: `node test/run.cjs`.
 *
 * `lib/` ships as-is and has no build step, so there is nothing to compile before
 * running this. Each suite drives the real artifact — the Host half as an ES module
 * and the browser half through its `__ModuleLoader__` factory — against small
 * hand-written doubles for the Cordis context, the DOM and the clock. No DSH
 * installation is needed, and nothing touches a profile.
 */

const { spawnSync } = require('node:child_process')
const { readdirSync } = require('node:fs')
const { join } = require('node:path')

const here = __dirname
const root = join(here, '..')

const suites = [
  { file: 'bundle.test.cjs', target: join(root, 'lib/client.js') },
  { file: 'guard.test.cjs', target: join(root, 'lib/index.js') },
  { file: 'host.test.cjs', target: join(root, 'lib/index.js') },
  { file: 'continue-button.test.cjs', target: join(root, 'lib/client.js') },
  { file: 'stop-ring.test.cjs', target: join(root, 'lib/client.js') },
]

const present = new Set(readdirSync(here))
let failed = 0

for (const suite of suites) {
  if (!present.has(suite.file)) {
    console.log('MISSING  ' + suite.file)
    failed += 1
    continue
  }
  const result = spawnSync(process.execPath, [join(here, suite.file), suite.target], { encoding: 'utf8' })
  const output = (result.stdout || '') + (result.stderr || '')
  const ok = result.status === 0
  console.log((ok ? 'PASS  ' : 'FAIL  ') + suite.file)
  if (!ok) {
    failed += 1
    for (const line of output.trim().split(/\r?\n/)) console.log('      ' + line)
  }
}

console.log('')
console.log(failed === 0 ? 'ALL SUITES PASSED' : failed + ' SUITE(S) FAILED')
process.exit(failed === 0 ? 0 : 1)
