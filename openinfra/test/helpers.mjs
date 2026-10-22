import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { main } from '../src/cli.js'
import { createWorkspace } from '../src/workspace.js'

export function tmpHome(label = 'oi') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`))
  process.env.OPENINFRA_HOME = dir
  return dir
}

export function tmpDir(label = 'ows') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`))
}

/** A workspace in a temp folder with an isolated OPENINFRA_HOME. No network, no git config needed. */
export function makeWorkspace({ template = 'lab', name = 'test-ws', git = false } = {}) {
  tmpHome()
  const dir = tmpDir()
  const root = path.join(dir, 'ws')
  const ws = createWorkspace({ name, template, dir: root, git })
  return { ...ws, dir, root }
}

/** Run the CLI with captured output. Returns { code, stdout, stderr, json }. */
export async function runCli(args, { cwd = process.cwd(), env = {} } = {}) {
  const out = []
  const err = []
  const prev = process.cwd()
  const savedEnv = { ...process.env }
  Object.assign(process.env, env)
  process.chdir(cwd)
  let code
  try {
    code = await main(args, {
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      tty: false,
    })
  } finally {
    process.chdir(prev)
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]
    Object.assign(process.env, savedEnv)
  }
  const stdout = out.join('\n')
  let json = null
  try {
    json = JSON.parse(stdout)
  } catch {
    /* not json */
  }
  return { code, stdout, stderr: err.join('\n'), json }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

export function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
