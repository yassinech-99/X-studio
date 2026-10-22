/**
 * The tool surface. Bash first — it is the primary tool, because OpenInfra is a CLI harness and every capability
 * the product has is a command. The file tools exist so the model does not have to shell out to `cat` and `sed`
 * (which is where Pi-style harnesses burn context and where edits go wrong), and every one of them goes through
 * the same permission gate as bash.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { runCommand, baseEnv, which } from './jobs.js'
import { evaluate } from './permissions.js'
import { classifyCommand } from './classify.js'
import { toolEnv } from './toolchain.js'
import { redact } from './redact.js'

const MAX_READ_LINES = 2000
const MAX_READ_BYTES = 256 * 1024
const MAX_MATCHES = 200

export class Denied extends Error {
  constructor(message, { rule = null, tier = null, verdict = 'deny' } = {}) {
    super(message)
    this.name = 'Denied'
    this.rule = rule
    this.tier = tier
    this.verdict = verdict
  }
}

function insideWorkspace(workspace, p) {
  if (!workspace) return true
  const resolved = path.resolve(workspace, p || '.')
  return resolved === workspace || resolved.startsWith(workspace + path.sep)
}

function resolvePath(ctx, p, { mustExist = false } = {}) {
  const resolved = path.resolve(ctx.workspace || process.cwd(), p)
  if (!insideWorkspace(ctx.workspace, resolved)) {
    throw new Denied(`${p} is outside the workspace (${ctx.workspace})`, { rule: 'workspace-boundary' })
  }
  if (mustExist && !fs.existsSync(resolved)) throw new Error(`no such file: ${p}`)
  return resolved
}

function gate(ctx, subject) {
  const decision = evaluate({
    ...subject,
    mode: ctx.mode || 'explore',
    rules: ctx.rules,
    workspace: ctx.workspace,
  })
  if (decision.verdict === 'deny') {
    throw new Denied(`${decision.reason}${decision.rule ? ` (${decision.rule})` : ''}`, {
      rule: decision.rule,
      tier: decision.tier,
      verdict: 'deny',
    })
  }
  if (decision.verdict === 'ask') {
    const approved = typeof ctx.approve === 'function' && ctx.approve(subject)
    if (!approved) {
      throw new Denied(`needs approval: ${decision.reason}${decision.rule ? ` (${decision.rule})` : ''}`, {
        rule: decision.rule,
        tier: decision.tier,
        verdict: 'ask',
      })
    }
  }
  return decision
}

export function toolSpecs() {
  return [
    {
      name: 'bash',
      description:
        'Run a shell command in the workspace. This is the primary tool: use it for git, kubectl get, tofu plan, ansible --check, jq, grep, curl (read-only) and anything else the CLI can do. Writes to infrastructure (tofu apply, ansible-playbook without --check, kubectl apply) are refused — use `oi change` instead. Long output is truncated and stored as an artifact.',
      readOnly: false,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'the command line to run' },
          cwd: { type: 'string', description: 'working directory, relative to the workspace' },
          timeout_s: { type: 'number', description: 'seconds before the process group is killed (default 30, max 600)' },
        },
        required: ['command'],
      },
    },
    {
      name: 'read',
      description: 'Read a text file from the workspace. Returns line numbers. Use before editing.',
      readOnly: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'number', description: 'first line (1-based)' },
          limit: { type: 'number', description: 'number of lines' },
        },
        required: ['path'],
      },
    },
    {
      name: 'write',
      description: 'Create or overwrite a file in the workspace. If the file exists you must read it first.',
      readOnly: false,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
    {
      name: 'edit',
      description:
        'Replace an exact string in a file. `old_string` must appear exactly once (or pass replace_all). If it does not match, the edit fails — that is deliberate.',
      readOnly: false,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
    {
      name: 'grep',
      description: 'Search file contents with a regular expression. Respects .gitignore-ish defaults (skips .git, node_modules).',
      readOnly: true,
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
          glob: { type: 'string', description: 'e.g. "*.yaml"' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'glob',
      description: 'List files matching a glob pattern (supports **).',
      readOnly: true,
      parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
    },
  ]
}

export const READ_ONLY_TOOLS = new Set(['read', 'grep', 'glob'])

export async function runTool(name, args, ctx) {
  const started = Date.now()
  try {
    const result = await IMPL[name]?.(args || {}, ctx)
    if (!result) throw new Error(`unknown tool: ${name}`)
    return { ...result, meta: { ...(result.meta || {}), tool: name, durationMs: Date.now() - started } }
  } catch (err) {
    if (err instanceof Denied) {
      return {
        ok: false,
        isError: true,
        content: `refused: ${err.message}`,
        meta: { tool: name, verdict: err.verdict, rule: err.rule, tier: err.tier, durationMs: Date.now() - started },
      }
    }
    return {
      ok: false,
      isError: true,
      content: `error: ${redact(err.message)}`,
      meta: { tool: name, durationMs: Date.now() - started },
    }
  }
}

const IMPL = {
  async bash(args, ctx) {
    const command = String(args.command || '').trim()
    if (!command) throw new Error('command is required')
    const timeoutS = Math.min(Math.max(Number(args.timeout_s) || 30, 1), 600)
    const cwd = resolvePath(ctx, args.cwd || '.')
    if (!fs.existsSync(cwd)) throw new Error(`no such directory: ${args.cwd}`)
    const decision = gate(ctx, { tool: 'Bash', command })
    const { path: extraPath } = toolEnv(ctx.workspace)
    const env = { ...baseEnv({ workspace: ctx.workspace, extraPath }), ...(ctx.env || {}) }
    const res = await runCommand({
      command,
      args: [],
      shell: '/bin/bash',
      cwd,
      env,
      timeoutMs: timeoutS * 1000,
      runId: ctx.runId || null,
      signal: ctx.signal,
    })
    if (res.missing) {
      return { ok: false, isError: true, content: `command not found: ${command.split(' ')[0]}` , meta: { tier: decision.tier } }
    }
    const body = [
      res.stdout.text ? res.stdout.text.trimEnd() : '',
      res.stderr.text ? `[stderr]\n${res.stderr.text.trimEnd()}` : '',
      res.timedOut ? `[timed out after ${timeoutS}s; process group killed]` : '',
      res.stdout.note || '',
      res.stderr.note || '',
    ]
      .filter(Boolean)
      .join('\n')
    return {
      ok: res.exitCode === 0,
      isError: res.exitCode !== 0,
      content: `${body || '(no output)'}\n\n[exit ${res.exitCode}${res.timedOut ? ', timed out' : ''} in ${res.durationMs}ms]`,
      meta: {
        exitCode: res.exitCode,
        durationMs: res.durationMs,
        timedOut: res.timedOut,
        tier: decision.tier,
        verdict: decision.verdict,
        truncated: res.stdout.truncated || res.stderr.truncated,
        artifacts: [res.stdout.artifact, res.stderr.artifact].filter(Boolean),
        classification: classifyCommand(command, { workspace: ctx.workspace }),
      },
    }
  },

  async read(args, ctx) {
    const file = resolvePath(ctx, args.path, { mustExist: true })
    gate(ctx, { tool: 'Read', path: file })
    const st = await fsp.stat(file)
    if (!st.isFile()) throw new Error(`not a file: ${args.path}`)
    if (st.size > 2 * 1024 * 1024) throw new Error(`file is ${st.size} bytes; use bash (head/tail) or grep`)
    const raw = await fsp.readFile(file, 'utf8')
    if (raw.includes('\u0000')) throw new Error('binary file')
    const all = raw.split('\n')
    const offset = Math.max(1, Number(args.offset) || 1)
    const limit = Math.min(Number(args.limit) || MAX_READ_LINES, MAX_READ_LINES)
    const slice = all.slice(offset - 1, offset - 1 + limit)
    let out = slice.map((l, i) => `${String(offset + i).padStart(6)}\t${l}`).join('\n')
    if (Buffer.byteLength(out) > MAX_READ_BYTES) out = out.slice(0, MAX_READ_BYTES)
    ctx.readFiles?.add(file)
    const more = offset - 1 + slice.length < all.length
    return {
      ok: true,
      content: out + (more ? `\n[${all.length - (offset - 1 + slice.length)} more lines]` : ''),
      meta: { path: file, lines: slice.length, totalLines: all.length },
    }
  },

  async write(args, ctx) {
    const file = resolvePath(ctx, args.path)
    gate(ctx, { tool: 'Write', path: file })
    const existed = fs.existsSync(file)
    if (existed && ctx.readFiles && !ctx.readFiles.has(file)) {
      return { ok: false, isError: true, content: `refused: read ${args.path} before overwriting it` }
    }
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, String(args.content ?? ''))
    ctx.readFiles?.add(file)
    return {
      ok: true,
      content: `${existed ? 'overwrote' : 'created'} ${args.path} (${Buffer.byteLength(String(args.content ?? ''))} bytes)`,
      meta: { path: file, bytes: Buffer.byteLength(String(args.content ?? '')) },
    }
  },

  async edit(args, ctx) {
    const file = resolvePath(ctx, args.path, { mustExist: true })
    gate(ctx, { tool: 'Edit', path: file })
    const before = await fsp.readFile(file, 'utf8')
    const needle = String(args.old_string ?? '')
    const replacement = String(args.new_string ?? '')
    if (!needle) throw new Error('old_string is required')
    const count = before.split(needle).length - 1
    if (count === 0) {
      return {
        ok: false,
        isError: true,
        content: `old_string not found in ${args.path}. Nothing was changed. Read the file and copy the exact text, including indentation.`,
      }
    }
    if (count > 1 && !args.replace_all) {
      return {
        ok: false,
        isError: true,
        content: `old_string appears ${count} times in ${args.path}. Add surrounding context to make it unique, or pass replace_all.`,
      }
    }
    const after = args.replace_all ? before.split(needle).join(replacement) : before.replace(needle, replacement)
    await fsp.writeFile(file, after)
    ctx.readFiles?.add(file)
    return {
      ok: true,
      content: `edited ${args.path}: ${args.replace_all ? count : 1} replacement(s)`,
      meta: { path: file, replacements: args.replace_all ? count : 1 },
    }
  },

  async grep(args, ctx) {
    const pattern = String(args.pattern || '')
    if (!pattern) throw new Error('pattern is required')
    const root = resolvePath(ctx, args.path || '.')
    gate(ctx, { tool: 'Grep', path: root })
    const rg = which('rg')
    if (rg) {
      const argv = ['--line-number', '--no-heading', '--color', 'never', '-m', String(MAX_MATCHES)]
      if (args.glob) argv.push('--glob', args.glob)
      argv.push(pattern, root)
      const res = await runCommand({ command: rg, args: argv, cwd: ctx.workspace || root, timeoutMs: 20_000 })
      const text = res.stdout.text.trim()
      return { ok: res.exitCode === 0, content: text || 'no matches', meta: { matches: text ? text.split('\n').length : 0 } }
    }
    const hits = []
    const walk = (dir, depth = 0) => {
      if (depth > 8 || hits.length >= MAX_MATCHES) return
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.name === '.git' || e.name === 'node_modules' || e.name === '.openinfra') continue
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full, depth + 1)
        else if (e.isFile() && (!args.glob || e.name.endsWith(args.glob.replace(/^\*/, '')))) {
          let text
          try {
            text = fs.readFileSync(full, 'utf8')
          } catch {
            continue
          }
          if (text.includes('\u0000')) continue
          const re = new RegExp(pattern)
          text.split('\n').forEach((line, i) => {
            if (hits.length < MAX_MATCHES && re.test(line)) hits.push(`${path.relative(ctx.workspace || root, full)}:${i + 1}:${line}`)
          })
        }
      }
    }
    walk(root)
    return { ok: true, content: hits.join('\n') || 'no matches', meta: { matches: hits.length } }
  },

  async glob(args, ctx) {
    const pattern = String(args.pattern || '')
    if (!pattern) throw new Error('pattern is required')
    const root = ctx.workspace || process.cwd()
    gate(ctx, { tool: 'Glob', path: root })
    const re = globToRegExp(pattern)
    const found = []
    const walk = (dir, depth) => {
      if (depth > 10 || found.length > 500) return
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === '.git' || e.name === 'node_modules') continue
        const full = path.join(dir, e.name)
        const rel = path.relative(root, full)
        if (e.isDirectory()) walk(full, depth + 1)
        else if (re.test(rel)) found.push(rel)
      }
    }
    walk(root, 0)
    return { ok: true, content: found.sort().join('\n') || 'no files', meta: { count: found.length } }
  },
}

export function globToRegExp(glob) {
  let out = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i++
        if (glob[i + 1] === '/') i++
      } else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(out + '$')
}
