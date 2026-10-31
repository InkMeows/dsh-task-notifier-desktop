// Run every offline suite and aggregate the exit codes.
//
// The previous `suiteA && suiteB && suiteC` npm script silently skipped the
// later suites whenever an earlier one failed — a failure in the middle looked
// like "isolation never ran" rather than "isolation failed". This runner always
// executes all of them and fails if any did.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SUITES = [
  'tests/compatibility.test.mjs',
  'tests/desktop-verify.mjs',
  'tests/isolation.test.mjs',
]

const failed = []
for (const suite of SUITES) {
  console.log(`\n===== ${suite} =====`)
  const result = spawnSync(process.execPath, [join(ROOT, suite)], { stdio: 'inherit', cwd: ROOT })
  if (result.status !== 0) failed.push(suite)
}

console.log('\n===== summary =====')
for (const suite of SUITES) console.log(`${failed.includes(suite) ? 'FAIL' : 'PASS'}  ${suite}`)
if (failed.length > 0) {
  console.error(`\n${failed.length}/${SUITES.length} suite(s) failed`)
  process.exitCode = 1
} else {
  console.log(`\nall ${SUITES.length} suites passed`)
}