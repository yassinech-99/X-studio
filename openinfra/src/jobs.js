/**
 * Process jobs: the only place in OpenInfra that spawns something with a shell.
 *
 * Everything that can turn into "a process we lost track of" is handled here — own process group, timeout that
 * kills the group, output caps with artifact offload, and a journal line before and after.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { defaultArtifacts } from './artifacts.js'
import { redact } from './redact.js'
import { sanitizeTerminal } from './sanitize.js'

export const MAX_INLINE = 64 * 1024
export const MAX_CAPTURE = 8 * 1024 * 1024

export function baseEnv({ workspace = null, extraPath = [], tz = null } = {}) {
  // Deliberately NOT the full parent environment: an agent's bash must not inherit provider keys or cloud
  // credentials it was never granted.
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'SYSTEMROOT']
  const env = {}
  for (const k of keep) if (process.env[k] != null) env[k] = process.env[k]
  if (extraPath.length) env.PATH = [...extraPath, env.PATH || '/usr/local/bin:/usr/bin:/bin'].join(':')
  if (workspace) {
    env.OPENINFRA_WORKSPACE = workspace
    env.ANSIBLE_CONFIG = `${workspace}/ansible/ansible.cfg`
    env.TF_CLI_CONFIG_FILE = `${workspace}/.openinfra/tofu.rc`
    env.TF_IN_AUTOMATION = '1'
    env.TF_INPUT = '0'
    env.KUBECONFIG = process.env.KUBECONFIG || `${workspace}/.openinfra/kubeconfig`
  }
  if (tz) env.TZ = tz
  return env
}

function cap(text, stream, { runId = null, label = null } = {}) {
  const bytes = Buffer.byteLength(text)
  if (bytes <= MAX_INLINE) return { text, bytes, truncated: false }
  const cut = Buffer.from(text).subarray(0, MAX_INLINE).toString('utf8')
  const desc = defaultArtifacts().putSync(text, { kind: 'output', label: label || `${stream} of ${runId || 'command'}` })
  return {
    text: cut,
    bytes,
    truncated: true,
    note: `[truncated: full ${stream} is artifact ${desc.sha256}]`,
    artifact: desc,
  }
}

/**
 * Run a command and return a structured result. Never throws for a non-zero exit — the caller decides what a
 * code means. Throws only for programmer errors (bad arguments).
 */
export function runCommand({
  command,
  args = [],
  cwd = process.cwd(),
  env = null,
  timeoutMs = 30_000,
  shell = false,
  input = null,
  runId = null,
  onSpawn = null,
  signal = null,
  windowsHide = true,
} = {}) {
  if (!command) throw new Error('runCommand: command is required')
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const child = spawn(command, args, {
      cwd,
      env: env || baseEnv(),
      shell,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide,
    })
    let stdout = ''
    let stderr = ''
    let captured = 0
    let timedOut = false
    let killedFor = null
    let settled = false

    const onData = (which) => (chunk) => {
      const s = chunk.toString('utf8')
      captured += Buffer.byteLength(s)
      if (which === 'out') {
        if (stdout.length < MAX_CAPTURE) stdout += s
      } else if (stderr.length < MAX_CAPTURE) stderr += s
    }
    child.stdout.on('data', onData('out'))
    child.stderr.on('data', onData('err'))

    const killGroup = (reason) => {
      killedFor = killedFor || reason
      try {
        if (process.platform === 'win32') child.kill('SIGKILL')
        else process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          killGroup('timeout')
        }, timeoutMs)
      : null

    const onAbort = () => killGroup('cancelled')
    if (signal) signal.addEventListener('abort', onAbort, { once: true })

    if (onSpawn) onSpawn({ pid: child.pid })

    if (input != null) {
      child.stdin.end(input)
    } else {
      child.stdin.end()
    }

    const finish = (code, sig, err) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      const durationMs = Math.round(performance.now() - started)
      if (err && !code && !sig) {
        return reject(err)
      }
      resolve({
        command,
        args,
        cwd,
        exitCode: code == null ? 124 : code,
        signal: sig || null,
        durationMs,
        timedOut,
        cancelled: killedFor === 'cancelled',
        stdout: cap(sanitizeTerminal(redact(stdout)), 'stdout', { runId, label: `${command} stdout` }),
        stderr: cap(sanitizeTerminal(redact(stderr)), 'stderr', { runId, label: `${command} stderr` }),
        executed_here: !shell,
        truncated_any: captured > MAX_INLINE,
        platform: os.platform(),
      })
    }

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        settled = true
        if (timer) clearTimeout(timer)
        return resolve({
          command,
          args,
          cwd,
          exitCode: 127,
          signal: null,
          durationMs: Math.round(performance.now() - started),
          timedOut: false,
          missing: true,
          stdout: { text: '', bytes: 0, truncated: false },
          stderr: { text: `command not found: ${command}`, bytes: 0, truncated: false },
        })
      }
      finish(null, null, err)
    })
    child.on('close', (code, sig) => finish(code, sig))
  })
}

/** Check that a binary resolves on PATH without running it. */
export function which(binary, env = process.env) {
  const p = (env.PATH || '').split(':').filter(Boolean)
  for (const dir of p) {
    const candidate = `${dir}/${binary}`
    try {
      const st = fs.statSync(candidate)
      if (st.isFile() && (st.mode & 0o111) !== 0) return candidate
    } catch {
      /* keep looking */
    }
  }
  return null
}
