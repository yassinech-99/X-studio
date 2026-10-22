import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { evaluate, loadRules, matchesRule, BUILTIN } from '../src/permissions.js'
import { tmpHome, tmpDir } from './helpers.mjs'

const ws = '/workspace/demo'

test('deny beats a broader allow — the whole point of the ordering', () => {
  const rules = { deny: ['Bash(git push:*)'], ask: [], allow: ['Bash(git:*)'] }
  const d = evaluate({ tool: 'Bash', command: 'git push origin main', mode: 'execute', rules, workspace: ws })
  assert.equal(d.verdict, 'deny')
  assert.equal(d.rule, 'Bash(git push:*)')
})

test('a broad allow still works when nothing denies it', () => {
  const rules = { deny: [], ask: [], allow: ['Bash(git status:*)'] }
  assert.equal(evaluate({ tool: 'Bash', command: 'git status', mode: 'explore', rules, workspace: ws }).verdict, 'allow')
})

test('secret files are denied even with an allow rule', () => {
  const rules = { deny: [], ask: [], allow: ['Read(**)'] }
  for (const f of ['/w/.env', '/w/id_rsa', '/home/u/.aws/credentials', '/w/.openinfra/secrets.json', '/w/key.pem']) {
    const d = evaluate({ tool: 'Read', path: f, mode: 'execute', rules, workspace: ws })
    assert.equal(d.verdict, 'deny', f)
  }
})

test('the builtin rules include the classics', () => {
  assert.ok(BUILTIN.deny.includes('Bash(sudo:*)'))
  assert.equal(evaluate({ tool: 'Bash', command: 'sudo ls', mode: 'execute', workspace: ws }).verdict, 'deny')
})

test('ask is a real answer, not an allow', () => {
  const d = evaluate({ tool: 'Bash', command: 'git push', mode: 'execute', rules: BUILTIN, workspace: ws })
  assert.equal(d.verdict, 'ask')
})

test('unknown tool calls are permitted only when they are reads', () => {
  assert.equal(evaluate({ tool: 'SomeReadTool', mode: 'explore' }).verdict, 'allow')
})

test('writes need a non-explore mode', () => {
  assert.equal(evaluate({ tool: 'Write', path: '/workspace/demo/a.txt', mode: 'explore', workspace: ws }).verdict, 'deny')
  assert.equal(evaluate({ tool: 'Write', path: '/workspace/demo/a.txt', mode: 'plan', workspace: ws }).verdict, 'allow')
})

test('rule matching accepts prefix and glob forms', () => {
  assert.ok(matchesRule('Bash(npm run:*)', { tool: 'Bash', command: 'npm run test' }))
  assert.ok(!matchesRule('Bash(npm run:*)', { tool: 'Bash', command: 'npm publish' }))
  assert.ok(matchesRule('Read(./secrets/*)', { tool: 'Read', path: '/w/secrets/a.txt' }))
})

test('workspace rules merge with builtin and the user file wins nothing — deny still wins', () => {
  const home = tmpHome()
  const root = tmpDir()
  fs.mkdirSync(path.join(root, '.openinfra'), { recursive: true })
  fs.writeFileSync(path.join(home, 'permissions.json'), JSON.stringify({ allow: ['Bash(rm -rf:*)'] }))
  fs.writeFileSync(path.join(root, '.openinfra', 'permissions.json'), JSON.stringify({ deny: ['Bash(rm -rf:*)'] }))
  const rules = loadRules({ home, workspaceRoot: root })
  const d = evaluate({ tool: 'Bash', command: 'rm -rf build', mode: 'execute', rules, workspace: root })
  assert.equal(d.verdict, 'deny')
})
