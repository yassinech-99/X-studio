/**
 * A small structural check, so the repo has a "lint" that means something without pulling in a toolchain:
 * every source file parses, no unowned markers in code, and the invariant suite is still there.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const problems = []
const MARKER = /\bT[O]DO\b(?!\()/

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full)
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) {
      const check = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' })
      if (check.status !== 0) problems.push(`${path.relative(root, full)}: syntax error\n${check.stderr}`)
      const text = fs.readFileSync(full, 'utf8')
      if (MARKER.test(text)) problems.push(`${path.relative(root, full)}: unowned marker`)
    }
  }
}

for (const dir of ['src', 'bin', 'test']) walk(path.join(root, dir))
const self = fs.readFileSync(new URL(import.meta.url), 'utf8')
if (MARKER.test(self.replace(/const MARKER[^\n]*/, ''))) problems.push('scripts/check.mjs: unowned marker')
if (!fs.existsSync(path.join(root, 'test', 'invariants.test.mjs'))) problems.push('test/invariants.test.mjs is missing')

if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log('ok: syntax, markers, invariants present')
