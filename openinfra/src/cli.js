/**
 * The CLI. Every command here is also the CLI twin of a TUI action, and every one of them has a JSON form with
 * real exit codes, because CI and cron are first-class users of this product.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { EXIT, EXIT_NAMES, OiError, usage, notFound } from './exit.js'
import { ensureHome, paths, workspacePaths } from './paths.js'
import { Store, nowIso } from './store.js'
import { ArtifactStore } from './artifacts.js'
import { doctor, renderDoctor } from './doctor.js'
import { createWorkspace, listWorkspaces, requireWorkspace, findWorkspace, removeWorkspace, readRegistry, TEMPLATES } from './workspace.js'
import { loadConfig, readTomlFile, writeTomlFile, PROVIDER_KINDS, modeSelection } from './config.js'
import { PROVIDER_PRESETS, createProvider, probeProvider, selectProvider, estimateCost } from './providers/index.js'
import { resolveSecret, storeSecret } from './secrets.js'
import { runAgent } from './agent.js'
import { runTool } from './tools.js'
import { loadRules } from './permissions.js'
import { classifyCommand, decide } from './classify.js'
import { runCommand } from './jobs.js'
import { readLock, verifyLock, toolEnv } from './toolchain.js'
import { checkDrift, loadIntent, loadPolicy, summarize } from './drift.js'
import { loadSchedule, tick, runJob, exportSchedule, nextRuns, validateSchedule, approvalFile, newRunId } from './scheduler.js'
import { nextRun, parseCron, isValidTimezone } from './cron.js'
import { redact } from './redact.js'
import { readJournal } from './journal.js'

const VERSION = '0.1.0'

const HELP = `openinfra ${VERSION} — infrastructure harness, CLI first

  oi doctor [--json]                  what can this machine do right now
  oi workspace new <name> [--template network-core|cloud-iac|k8s-ops|lab|empty] [--dir <path>]
  oi workspace list|show|path|rm
  oi config validate|show
  oi providers add <anthropic|openai|nvidia|openrouter|compatible|fake> [--key K] [--base-url U] [--model M] [--as id]
  oi providers list|test|remove
  oi models list [--provider <id>] | oi models probe <provider>/<model>
  oi chat -p "ask something" [--provider P] [--model M] [--mode explore|plan|execute|incident]
  oi bash -c "command" [--mode explore]   run one command through the same gate the agent uses
  oi drift check [--observed <file|dir>] [--json] | oi drift show | oi drift transitions
  oi schedule list|show <job>|tick|run <job>|history|status|export --format systemd|cron|launchd|k8s
  oi run list|show <id>
  oi artifact show <sha256>
  oi cost [--workspace]

Exit codes: 0 ok · 1 error · 2 drift · 3 partial · 4 unapproved · 5 not found · 6 usage · 7 hash mismatch
            8 toolchain · 9 workspace`

export async function main(argv = process.argv.slice(2), io = {}) {
  const ctx = {
    cwd: process.cwd(),
    json: false,
    color: process.stdout.isTTY !== false && !process.env.NO_COLOR,
    yes: false,
    stdout: io.stdout || ((s) => process.stdout.write(s + '\n')),
    stderr: io.stderr || ((s) => process.stderr.write(s + '\n')),
    write: io.write || io.stdout || ((s) => process.stdout.write(s)),
    stdin: io.stdin || process.stdin,
    tty: io.tty ?? Boolean(process.stdin.isTTY),
  }
  let store = null
  try {
    const args = [...argv]
    // flags may appear anywhere, including after the verb: `oi drift check --json`
    if (args.includes('--json')) ctx.json = true
    if (args.includes('--no-color') || process.env.NO_COLOR) ctx.color = false
    if (args.includes('--yes') || args.includes('-y')) ctx.yes = true
    // global flags, anywhere before the verb
    while (args.length && args[0].startsWith('-')) {
      const f = args.shift()
      if (f === '--json') ctx.json = true
      else if (f === '--no-color') ctx.color = false
      else if (f === '--yes' || f === '-y') ctx.yes = true
      else if (f === '--version' || f === '-v') {
        ctx.stdout(VERSION)
        return EXIT.OK
      } else if (f === '--help' || f === '-h') {
        ctx.stdout(HELP)
        return EXIT.OK
      } else if (f === '--workspace') ctx.cwd = path.resolve(args.shift())
      else throw usage(`unknown flag ${f}`)
    }
    const [verb, sub, ...rest] = args
    if (!verb || verb === 'help') {
      ctx.stdout(HELP)
      return EXIT.OK
    }

    const flagsFor = (list) => parseFlags(list, ctx)
    const need = () => {
      const root = ctx.cwd ? findWorkspace(ctx.cwd) : null
      if (!root) throw new OiError('not inside a workspace (no .openinfra/config.toml found)', EXIT.WORKSPACE)
      return root
    }
    const needStore = () => (store ||= new Store())

    switch (verb) {
      case 'version':
        ctx.stdout(VERSION)
        return EXIT.OK

      case 'init': {
        const flags = flagsFor(args.slice(1))
        const root = process.cwd()
        const res = createWorkspace({ name: flags.name || path.basename(root), dir: root, template: flags.template || 'lab' })
        return report(ctx, res, `workspace ${res.name} ready at ${res.path}\nnext: oi doctor`)
      }

      case 'workspace': {
        const flags = flagsFor(args.slice(2))
        if (sub === 'new' || sub === undefined) {
          const name = args[2] && !args[2].startsWith('-') ? args[2] : flags.name
          if (!name) throw usage('workspace new needs a name')
          const res = createWorkspace({ name, template: flags.template || 'lab', dir: flags.dir || null })
          return report(ctx, res, `created ${res.name} (${res.template}) at ${res.path}\n  id ${res.id}, git: ${res.git}\nnext: cd ${res.path} && oi doctor`)
        }
        if (sub === 'list' || sub === 'ls') {
          const all = listWorkspaces()
          return report(ctx, { workspaces: all }, all.length ? all.map((w) => `${w.exists ? ' ' : '!'} ${w.id}  ${w.name.padEnd(20)} ${w.path}`).join('\n') : 'no workspaces yet; `oi workspace new demo`')
        }
        if (sub === 'show') {
          const root = need()
          const cfg = loadConfig({ workspaceRoot: root }).config
          const sched = loadSchedule(root)
          const intent = loadIntent(root)
          return report(ctx, { root, config: cfg, schedule: sched.jobs.map((j) => ({ name: j.name, kind: j.kind, cron: j.cron })), intent: Object.keys(intent.objects) }, [
            `${cfg.workspace?.name || path.basename(root)}  (${cfg.workspace?.id || 'unregistered'})`,
            `  path     ${root}`,
            `  template ${cfg.workspace?.template || 'custom'}`,
            `  agent    ${cfg.agent.mode}, provider ${modeSelection(cfg).provider || 'none'}`,
            `  intent   ${Object.keys(intent.objects).length} object(s)`,
            `  schedule ${sched.jobs.length} job(s)`,
          ].join('\n'))
        }
        if (sub === 'path') {
          ctx.stdout(need())
          return EXIT.OK
        }
        if (sub === 'rm' || sub === 'remove') {
          const target = args[2] && !args[2].startsWith('-') ? args[2] : flags.name
          const res = removeWorkspace({ nameOrId: target || need(), deleteFiles: Boolean(flags['delete-files']) })
          return report(ctx, res, `removed ${res.name} from the registry${flags['delete-files'] ? ' and deleted the folder' : ` (files kept at ${res.path})`}`)
        }
        throw usage(`unknown workspace command: ${sub}`)
      }

      case 'doctor': {
        const flags = flagsFor(args.slice(1))
        if (flags['no-color'] || process.env.NO_COLOR) ctx.color = false
        const root = findWorkspace(ctx.cwd)
        const reportObj = doctor({ root, store: needStore() })
        if (ctx.json) {
          ctx.stdout(JSON.stringify(reportObj, null, 2))
        } else {
          ctx.stdout(renderDoctor(reportObj, { color: ctx.color }))
          if (flags.env) ctx.stdout(`\nPATH additions:\n${reportObj.env.path.join('\n') || '(none)'}`)
        }
        return reportObj.exitCode
      }

      case 'config': {
        const flags = flagsFor(args.slice(2))
        const root = flags.workspace ? findWorkspace(flags.workspace) : findWorkspace(ctx.cwd)
        if (sub === 'validate' || sub === undefined) {
          const loaded = loadConfig({ workspaceRoot: root })
          return report(ctx, { ok: true, sources: loaded.sources }, `config ok (${loaded.sources.length} file(s))`)
        }
        if (sub === 'show') {
          const loaded = loadConfig({ workspaceRoot: root })
          if (ctx.json) ctx.stdout(JSON.stringify(loaded.config, null, 2))
          else ctx.stdout(JSON.stringify(loaded.config, null, 2))
          return EXIT.OK
        }
        throw usage(`unknown config command: ${sub}`)
      }

      case 'providers':
        return await providersCommand(args.slice(1), ctx, { flags: flagsFor });

      case 'models':
        return await modelsCommand(args.slice(1), ctx, { flags: flagsFor })

      case 'chat':
      case 'agent':
        return await chatCommand(args.slice(1), ctx, { need, needStore })

      case 'bash': {
        const flags = flagsFor(args.slice(1))
        const command = flags.c || flags.command || args.find((a, i) => i > 0 && !a.startsWith('-') && args[i - 1] !== '-c')
        if (!command) throw usage('bash needs -c "command"')
        const root = findWorkspace(ctx.cwd)
        const mode = flags.mode || 'explore'
        const res = await runTool('bash', { command, timeout_s: Number(flags.timeout || 30) }, {
          workspace: root || ctx.cwd,
          mode,
          rules: loadRules({ workspaceRoot: root }),
        })
        if (ctx.json) ctx.stdout(JSON.stringify(res, null, 2))
        else ctx.stdout(res.content)
        return res.isError ? (res.meta?.verdict === 'deny' ? EXIT.UNAPPROVED : EXIT.ERROR) : EXIT.OK
      }

      case 'classify': {
        const flags = flagsFor(args.slice(1))
        const command = flags.c || args.slice(1).join(' ')
        if (!command) throw usage('classify needs a command')
        const c = classifyCommand(command, { workspace: findWorkspace(ctx.cwd) })
        const d = decide(c.tier, { mode: flags.mode || 'explore' })
        return report(ctx, { ...c, verdict: d.verdict, reason: d.reason }, `${c.tier} → ${d.verdict} (${d.reason})\n${c.reasons.map((r) => `  ${r.tier}: ${r.rule}${r.detail ? ` — ${r.detail}` : ''}`).join('\n')}`)
      }

      case 'drift':
        return await driftCommand(args.slice(1), ctx, { need, needStore, flags: flagsFor })

      case 'schedule':
        return await scheduleCommand(args.slice(1), ctx, { need, needStore, flags: flagsFor })

      case 'run': {
        const flags = flagsFor(args.slice(2))
        const root = findWorkspace(ctx.cwd)
        if (sub === 'list' || sub === undefined) {
          const runs = needStore().listRuns({ workspace: root ? root : null, limit: Number(flags.limit || 20) })
          return report(ctx, { runs }, runs.length ? runs.map((r) => `${r.id}  ${String(r.status).padEnd(9)} ${String(r.kind).padEnd(8)} ${r.name || ''}  ${r.started_at}`).join('\n') : 'no runs yet')
        }
        if (sub === 'show') {
          const id = args[2]
          if (!id) throw usage('run show needs a run id')
          const run = needStore().getRun(id)
          const journalFile = root ? path.join(workspacePaths(root).runs, id, 'journal.ndjson') : null
          const entries = journalFile && fs.existsSync(journalFile) ? readJournal(journalFile) : []
          const view = { run, journal: entries }
          if (ctx.json) ctx.stdout(JSON.stringify(view, null, 2))
          else {
            ctx.stdout(`${id}  ${run?.status || 'unknown'}  exit ${run?.exit_code ?? '?'}  ${run?.started_at || ''} → ${run?.ended_at || '…'}`)
            for (const e of entries) ctx.stdout(`  ${e.ts} ${String(e.type).padEnd(16)} ${JSON.stringify(e.payload)?.slice(0, 200) || ''}`)
          }
          return run ? (run.exit_code ? Math.min(run.exit_code, 9) : EXIT.OK) : EXIT.NOTFOUND
        }
        throw usage(`unknown run command: ${sub}`)
      }

      case 'artifact': {
        if (sub === 'show') {
          const sha = args[2]
          if (!sha) throw usage('artifact show needs a sha256')
          const as = new ArtifactStore()
          if (!as.has(sha)) throw notFound(`no artifact ${sha}`)
          ctx.stdout(as.getTextSync(sha))
          return EXIT.OK
        }
        throw usage(`unknown artifact command: ${sub}`)
      }

      case 'cost': {
        const root = findWorkspace(ctx.cwd)
        const rows = needStore().costSummary({ workspace: root })
        const total = rows.reduce((s, r) => s + Number(r.cost_usd || 0), 0)
        return report(ctx, { rows, total_usd: total }, rows.length ? rows.map((r) => `${r.provider}/${r.model}: ${r.turns} turn(s), ${r.input_tokens} in / ${r.output_tokens} out, $${Number(r.cost_usd || 0).toFixed(4)}`).join('\n') + `\ntotal $${total.toFixed(4)}` : 'no model usage recorded')
      }

      case 'tui':
        throw usage('the TUI is phase P8 and is not in this build. Use the CLI; every action it would take has a verb here.')

      default:
        throw usage(`unknown command: ${verb}\n\n${HELP}`)
    }
  } catch (err) {
    const code = err.exitCode || EXIT.ERROR
    if (ctx.json) ctx.stdout(JSON.stringify({ error: redact(err.message), code, name: EXIT_NAMES[code] || 'error' }))
    else ctx.stderr(`error: ${redact(err.message)}`)
    if (process.env.OPENINFRA_DEBUG && err.stack) ctx.stderr(err.stack)
    return code
  } finally {
    store?.close()
  }
}

function parseFlags(list, ctx = null) {
  const flags = {}
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    if (!a.startsWith('-')) continue
    if (a === '-c') {
      flags.c = list[++i]
      continue
    }
    const key = a.replace(/^--?/, '')
    const next = list[i + 1]
    if (next != null && !next.startsWith('-')) {
      flags[key] = next
      i++
    } else flags[key] = true
    if (ctx) {
      if (key === 'json') ctx.json = true
      if (key === 'no-color') ctx.color = false
      if (key === 'yes') ctx.yes = true
    }
  }
  return flags
}

function report(ctx, obj, text) {
  if (ctx.json) ctx.stdout(JSON.stringify(obj, null, 2))
  else ctx.stdout(text)
  return EXIT.OK
}

async function providersCommand(args, ctx, { flags }) {
  const [sub, ...rest] = args
  const f = parseFlags(rest, ctx)
  const file = paths.providers
  const tree = readTomlFile(file) || { providers: {} }
  tree.providers ||= {}
  ensureHome()

  if (sub === 'add') {
    const kindArg = rest.find((r) => !r.startsWith('-')) || f.kind
    if (!kindArg) throw usage(`providers add <${Object.keys(PROVIDER_PRESETS).join('|')}|compatible|fake>`)
    const preset = PROVIDER_PRESETS[kindArg]
    const kind = preset?.kind || (kindArg === 'fake' ? 'fake' : kindArg === 'compatible' ? 'openai-compatible' : null)
    if (!kind) throw usage(`unknown provider kind "${kindArg}". Use ${Object.keys(PROVIDER_PRESETS).join(', ')}, compatible or fake.`)
    const id = f.as || kindArg
    const entry = { kind }
    if (preset?.base_url || f['base-url']) entry.base_url = f['base-url'] || preset.base_url
    if (f.model) entry.models = [f.model]
    if (kind === 'openrouter') entry.attribution = { referer: 'https://openinfra.dev', title: 'OpenInfra' }
    if (kind !== 'fake') {
      const key = typeof f.key === 'string' ? f.key : null
      const fromEnv = resolveSecret(`keychain:openinfra/${id}`)
      if (key) {
        const stored = await storeSecret(`keychain:openinfra/${id}`, key)
        entry.api_key_ref = `keychain:openinfra/${id}`
        ctx.stderr(stored.stored === 'keychain' ? 'key stored in the OS keychain' : `key stored in ${stored.file} (mode 0600)`)
      } else if (fromEnv) {
        entry.api_key_ref = `keychain:openinfra/${id}`
        ctx.stderr('using the key already stored for this provider')
      } else {
        entry.api_key_ref = `env:OPENINFRA_KEY_${id.toUpperCase()}`
        ctx.stderr(`no --key given: expecting OPENINFRA_KEY_${id.toUpperCase()} in the environment (never written to disk)`)
      }
    }
    tree.providers[id] = entry
    if (!tree.default_provider) tree.default_provider = id
    tree.agent ||= {}
    tree.agent.explore ||= { provider: id, ...(f.model ? { model: f.model } : {}) }
    tree.agent.execute ||= { provider: id, ...(f.model ? { model: f.model } : {}) }
    writeTomlFile(file, tree)
    return report(ctx, { ok: true, id, provider: entry, file }, `provider ${id} added (${entry.kind}${entry.base_url ? `, ${entry.base_url}` : ''})\n  next: oi providers test ${id}`)
  }

  if (sub === 'list' || sub === undefined) {
    const ids = Object.keys(tree.providers)
    const rows = ids.map((id) => {
      const p = tree.providers[id]
      const key = p.kind === 'fake' ? 'n/a' : resolveSecret(p.api_key_ref) ? 'key ok' : 'NO KEY'
      return { id, kind: p.kind, base_url: p.base_url || null, key, models: p.models || [] }
    })
    return report(ctx, { providers: rows, default: tree.default_provider || null }, rows.length ? rows.map((r) => `${r.id.padEnd(14)} ${r.kind.padEnd(18)} ${r.key.padEnd(7)} ${(r.models[0] || '').padEnd(32)} ${r.base_url || ''}`).join('\n') : 'no providers. `oi providers add nvidia --key nvapi-…`')
  }

  if (sub === 'test') {
    const id = rest.find((r) => !r.startsWith('-')) || tree.default_provider
    if (!id) throw usage('no provider to test')
    const p = tree.providers[id]
    if (!p) throw notFound(`no provider ${id}`)
    const provider = createProvider(id, p)
    const model = f.model || p.models?.[0] || (await provider.models().catch(() => []))[0]?.id
    if (!model) throw new OiError(`provider ${id} has no models; pass --model`, EXIT.USAGE)
    const probe = await probeProvider(provider, model)
    if (probe.reachable) {
      const store = new Store()
      try {
        store.saveProbe(id, model, probe)
      } finally {
        store.close()
      }
    }
    const text = [
      `${id} (${p.kind}) model ${model}`,
      `  reachable  ${probe.reachable ? 'yes' : 'NO'}${probe.error ? ` — ${probe.error}` : ''}`,
      `  tools      ${probe.tools ? 'yes' : 'no (the agent cannot run commands on this model)'}`,
      `  streaming  ${probe.streaming ? 'yes' : 'no'}`,
      `  latency    ${probe.latency_ms}ms`,
      probe.served_model && probe.served_model !== model ? `  served as  ${probe.served_model} (requested ${model})` : null,
    ]
      .filter(Boolean)
      .join('\n')
    if (ctx.json) ctx.stdout(JSON.stringify(probe, null, 2))
    else ctx.stdout(text)
    return probe.reachable && probe.tools ? EXIT.OK : EXIT.ERROR
  }

  if (sub === 'remove' || sub === 'rm') {
    const id = rest.find((r) => !r.startsWith('-'))
    if (!id || !tree.providers[id]) throw notFound(`no provider ${id}`)
    delete tree.providers[id]
    if (tree.default_provider === id) tree.default_provider = Object.keys(tree.providers)[0] || null
    writeTomlFile(file, tree)
    return report(ctx, { removed: id }, `removed ${id}`)
  }
  throw usage(`unknown providers command: ${sub}`)
}

async function modelsCommand(args, ctx) {
  const [sub, ...rest] = args
  const f = parseFlags(rest, ctx)
  const tree = readTomlFile(paths.providers) || { providers: {} }
  if (sub === 'probe') {
    const target = rest.find((r) => !r.startsWith('-'))
    if (!target?.includes('/')) throw usage('models probe <provider>/<model>')
    const [pid, ...modelParts] = target.split('/')
    const p = tree.providers?.[pid]
    if (!p) throw notFound(`no provider ${pid}`)
    const provider = createProvider(pid, p)
    const probe = await probeProvider(provider, modelParts.join('/'))
    const store = new Store()
    try {
      store.saveProbe(pid, modelParts.join('/'), probe)
    } finally {
      store.close()
    }
    if (ctx.json) ctx.stdout(JSON.stringify(probe, null, 2))
    else ctx.stdout(`${pid}/${probe.model}: reachable=${probe.reachable} tools=${probe.tools} streaming=${probe.streaming} ${probe.latency_ms}ms${probe.error ? ` error=${probe.error}` : ''}`)
    return probe.reachable ? EXIT.OK : EXIT.ERROR
  }
  const only = f.provider
  const ids = Object.keys(tree.providers || {}).filter((id) => !only || id === only)
  const out = []
  for (const id of ids) {
    const p = tree.providers[id]
    if (p.kind === 'fake') {
      out.push({ provider: id, models: [{ id: 'fake-1' }] })
      continue
    }
    try {
      const provider = createProvider(id, p)
      const models = await provider.models()
      out.push({ provider: id, models })
    } catch (err) {
      out.push({ provider: id, error: redact(err.message), models: (p.models || []).map((m) => ({ id: m })) })
    }
  }
  if (ctx.json) ctx.stdout(JSON.stringify({ providers: out }, null, 2))
  else {
    for (const p of out) {
      ctx.stdout(`${p.provider}:`)
      if (p.error) ctx.stdout(`  ! ${p.error}`)
      for (const m of p.models.slice(0, 40)) ctx.stdout(`  ${m.id}${m.context ? `  (${m.context} ctx)` : ''}`)
    }
  }
  return EXIT.OK
}

async function chatCommand(args, ctx, { need, needStore }) {
  const f = parseFlags(args, ctx)
  const prompt = typeof f.p === 'string' ? f.p : typeof f.prompt === 'string' ? f.prompt : args.filter((a) => !a.startsWith('-')).join(' ')
  if (!prompt) throw usage('chat needs -p "your question"')
  const root = need()
  const loaded = loadConfig({ workspaceRoot: root })
  const { provider, providerId, model, mode } = selectProvider(loaded.config, {
    mode: f.mode || null,
    providerId: f.provider || null,
    model: f.model || null,
    script: f.script ? JSON.parse(fs.readFileSync(f.script, 'utf8')) : null,
  })
  const store = needStore()
  const rules = loadRules({ workspaceRoot: root })
  const runId = newRunId()
  store.createRun({ id: runId, workspace: root, name: 'chat', kind: 'agent', status: 'running', meta: { provider: providerId, model } })

  const approve = async (subject) => {
    if (ctx.yes) return true
    if (!ctx.tty) return false
    const rl = createInterface({ input: ctx.stdin, output: process.stdout })
    try {
      const answer = await rl.question(`\nallow ${subject.tool}: ${String(subject.command || subject.path).slice(0, 120)}? [y/N] `)
      return /^y(es)?$/i.test(answer.trim())
    } finally {
      rl.close()
    }
  }

  const result = await runAgent({
    provider,
    providerId,
    model,
    mode,
    workspace: root,
    prompt,
    rules,
    store,
    runId,
    maxSteps: Number(f['max-steps'] || loaded.config.agent.max_steps || 40),
    budgetUsd: f.budget != null ? Number(f.budget) : loaded.config.agent.budget_usd ?? null,
    onEvent: (ev) => {
      if (ctx.json) return
      if (ev.type === 'assistant.delta') ctx.write(ev.text)
      if (ev.type === 'tool.start') ctx.write(`\n\n${ctx.color ? '\x1b[2m' : ''}▸ ${ev.name} ${String(JSON.stringify(ev.input)).slice(0, 160)}${ctx.color ? '\x1b[0m' : ''}\n`)
      if (ev.type === 'tool.result' && ev.verdict === 'deny') ctx.stderr(`  (refused: ${ev.name})`)
      if (ev.type === 'provider.retry') ctx.stderr(`  retrying (${ev.error})…`)
      if (ev.type === 'compaction') ctx.stderr(`  compacted context ${ev.before}→${ev.after} tokens`)
    },
  })
  store.updateSession(result.sessionId, { provider: providerId, model, mode, steps: result.steps })
  store.finishRun(runId, { status: result.stopped === 'end_turn' ? 'success' : result.stopped || 'failed', exitCode: result.stopped === 'end_turn' ? 0 : EXIT.ERROR })
  if (!ctx.json) ctx.write('\n')
  if (!ctx.json) ctx.stderr(`\n— ${result.steps} step(s), ${result.usage.input} in / ${result.usage.output} out, $${Number(result.usage.cost || 0).toFixed(4)} — session ${result.sessionId}`)
  else ctx.stdout(JSON.stringify({ session: result.sessionId, steps: result.steps, stopped: result.stopped, usage: result.usage, transcript: result.transcript }, null, 2))
  return result.stopped === 'end_turn' ? EXIT.OK : EXIT.ERROR
}

async function driftCommand(args, ctx, { need, needStore, flags }) {
  const [sub, ...rest] = args
  const f = parseFlags(rest, ctx)
  const root = need()
  const store = needStore()
  if (sub === 'check' || sub === undefined) {
    const runId = newRunId()
    store.createRun({ id: runId, workspace: root, name: 'drift', kind: 'drift', status: 'running' })
    let report
    try {
      report = checkDrift({ root, store, runId, observed: typeof f.observed === 'string' ? path.resolve(root, f.observed) : null })
    } catch (err) {
      store.finishRun(runId, { status: 'failed', exitCode: EXIT.ERROR, reason: redact(err.message) })
      throw err
    }
    store.finishRun(runId, { status: report.ok ? (report.drift ? 'drift' : 'success') : 'failed', exitCode: report.ok ? (report.drift ? EXIT.DRIFT : EXIT.OK) : EXIT.NOTFOUND })
    if (!report.ok) throw new OiError(report.reason + (report.hint ? `\n${report.hint}` : ''), EXIT.NOTFOUND)
    if (ctx.json) {
      ctx.stdout(JSON.stringify({ ...report, run_id: runId }, null, 2))
    } else {
      const s = report.summary
      ctx.stdout(`${s.total} finding(s) — high ${s.bySeverity.high || 0}, medium ${s.bySeverity.medium || 0}, low ${s.bySeverity.low || 0}`)
      ctx.stdout(`coverage: ${report.coverage.compared}/${report.coverage.objects} object(s) observed${report.coverage.unobserved.length ? `, ${report.coverage.unobserved.length} unreadable` : ''}`)
      ctx.stdout(`transitions: ${report.transitions.new} new, ${report.transitions.changed} changed, ${report.transitions.resolved} resolved`)
      for (const x of report.findings.slice(0, 30)) ctx.stdout(`  ${x.severity.padEnd(7)} ${x.title}`)
      ctx.stdout(`run ${runId}`)
    }
    return report.drift ? EXIT.DRIFT : EXIT.OK
  }
  if (sub === 'show') {
    const findings = store.listFindings({ workspace: root, status: f.all ? null : 'open', severity: f.severity || null, limit: Number(f.limit || 100) })
    return report(ctx, { findings }, findings.length ? findings.map((x) => `${x.severity.padEnd(7)} ${x.status.padEnd(8)} ${x.occurrences}× ${x.title}`).join('\n') : 'no open findings')
  }
  if (sub === 'transitions') {
    const rows = store.transitions({ workspace: root, limit: Number(f.limit || 50) })
    return report(ctx, { transitions: rows }, rows.length ? rows.map((t) => `${t.at}  ${t.kind.padEnd(9)} ${t.severity || ''}  ${t.fingerprint.slice(0, 10)}`).join('\n') : 'no transitions yet')
  }
  if (sub === 'coverage') {
    const intent = loadIntent(root)
    const policy = loadPolicy(root)
    const cov = { objects: Object.keys(intent.objects).length, files: intent.files, failOn: policy.failOn }
    return report(ctx, cov, `${cov.objects} object(s) declared in ${cov.files.length} file(s); fail on ${cov.failOn}`)
  }
  if (sub === 'mute') {
    const fp = rest.find((r) => !r.startsWith('-'))
    if (!fp) throw usage('drift mute <fingerprint> [--reason "..."]')
    const res = store.muteFinding({ workspace: root, fingerprint: fp, reason: f.reason || 'muted by operator' })
    return report(ctx, { muted: res }, res ? `muted ${fp}` : `no finding ${fp}`)
  }
  throw usage(`unknown drift command: ${sub}`)
}

async function scheduleCommand(args, ctx, { need, needStore, flags }) {
  const [sub, ...rest] = args
  const f = parseFlags(rest, ctx)
  const root = need()
  const store = needStore()
  const sched = loadSchedule(root)

  if (sub === 'list' || sub === undefined) {
    if (!sched.exists) throw new OiError(`no schedule at ${sched.file}`, EXIT.NOTFOUND)
    if (sched.errors.length) {
      for (const e of sched.errors) ctx.stderr(`error: ${e.message}`)
      return EXIT.USAGE
    }
    const next = nextRuns(sched, new Date())
    const state = new Map(store.allScheduleStates(root).map((s) => [s.job, s]))
    const rows = next.map((r) => {
      const st = state.get(r.job) || {}
      return { ...r, last: st.last_run || null, last_status: st.last_status || null, last_exit: st.last_exit ?? null }
    })
    return report(ctx, { timezone: sched.defaults.timezone || null, jobs: rows }, rows.length ? rows.map((r) => `${r.job.padEnd(22)} ${r.kind.padEnd(7)} ${r.cron.padEnd(18)} next ${r.human || 'never'}${r.last_status ? `  last ${r.last_status}` : ''}`).join('\n') : 'no jobs')
  }
  if (sub === 'show') {
    const name = rest.find((r) => !r.startsWith('-'))
    const job = sched.jobs.find((j) => j.name === name)
    if (!job) throw notFound(`no job ${name}`)
    const st = store.scheduleState(root, name) || {}
    const parsed = parseCron(job.cron)
    const next = nextRun(parsed, new Date(), job.timezone)
    const body = { ...job, next: next?.toISOString() || null, state: st }
    return report(ctx, body, [
      `${job.name} — ${job.kind}`,
      `  when      ${job.cron} (${job.timezone}) → next ${next?.toISOString() || 'never'}`,
      `  overlap   ${job.overlap}; missed ${job.missed}; timeout ${job.timeout}`,
      job.command ? `  command   ${job.command}` : null,
      job.script ? `  script    ${job.script}` : null,
      job.playbook ? `  playbook  ${job.playbook} (${job.mode})` : null,
      job.approval ? `  approval  ${job.approval}` : null,
      `  last      ${st.last_run || 'never'} ${st.last_status || ''} exit ${st.last_exit ?? '-'}`,
    ].filter(Boolean).join('\n'))
  }
  if (sub === 'tick') {
    const now = f.now ? new Date(f.now) : new Date()
    const res = await tick({ root, store, now, dryRun: Boolean(f['dry-run']) })
    if (!res.ok) throw new OiError(res.reason, EXIT.USAGE, { detail: res.errors })
    if (ctx.json) ctx.stdout(JSON.stringify(res, null, 2))
    else {
      if (!res.ran) ctx.stdout(`tick: nothing due (${res.jobs} job(s) checked)`)
      for (const r of res.runs) ctx.stdout(`${r.job}: ${r.status} (exit ${r.exitCode}) ${r.summary || ''}`)
      for (const s of res.skipped) if (s.reason !== 'not due') ctx.stdout(`skip ${s.job}: ${s.reason}`)
    }
    const failed = res.runs.filter((r) => r.exitCode !== 0)
    return failed.length ? (failed[0].exitCode || EXIT.ERROR) : EXIT.OK
  }
  if (sub === 'run') {
    const name = rest.find((r) => !r.startsWith('-'))
    const job = sched.jobs.find((j) => j.name === name)
    if (!job) throw notFound(`no job ${name}`)
    const res = await runJob({ job, root, store, dryRun: Boolean(f['dry-run']) })
    if (ctx.json) ctx.stdout(JSON.stringify(res, null, 2))
    else ctx.stdout(`${res.id} ${res.status} (exit ${res.exitCode}) ${res.summary || ''}${res.reason ? ` — ${res.reason}` : ''}`)
    return res.exitCode || EXIT.OK
  }
  if (sub === 'history') {
    const name = rest.find((r) => !r.startsWith('-'))
    const runs = store.listRuns({ workspace: root, kind: 'job', limit: Number(f.limit || 20) }).filter((r) => !name || r.name === name || r.job === name)
    const all = name ? store.listRuns({ workspace: root, limit: 200 }).filter((r) => r.job === name) : runs
    return report(ctx, { runs: all }, all.length ? all.map((r) => `${r.id}  ${String(r.status).padEnd(9)} ${String(r.job || r.name).padEnd(20)} ${r.started_at}${r.reason ? `  ${r.reason}` : ''}`).join('\n') : 'no history')
  }
  if (sub === 'status') {
    const states = store.allScheduleStates(root)
    const failing = states.filter((s) => s.last_status && !['success', 'idle'].includes(s.last_status))
    const body = { ok: failing.length === 0, jobs: sched.jobs.length, failing, states }
    if (ctx.json) ctx.stdout(JSON.stringify(body, null, 2))
    else ctx.stdout(failing.length ? `failing: ${failing.map((f2) => f2.job).join(', ')}` : `all ${sched.jobs.length} job(s) healthy`)
    return body.ok ? EXIT.OK : EXIT.ERROR
  }
  if (sub === 'export') {
    const format = f.format || 'systemd'
    const res = exportSchedule({ root, format, sched })
    if (f.out && typeof f.out === 'string') {
      fs.writeFileSync(f.out, res.content)
      ctx.stderr(`wrote ${f.out}`)
    } else ctx.stdout(res.content)
    return EXIT.OK
  }
  if (sub === 'validate') {
    const errors = validateSchedule(sched)
    return report(ctx, { ok: errors.length === 0, errors }, errors.length ? errors.map((e) => e.message).join('\n') : 'schedule ok')
  }
  if (sub === 'disable' || sub === 'enable') {
    // enable/disable is a source edit (git-tracked), not hidden state
    const name = rest.find((r) => !r.startsWith('-'))
    const job = sched.jobs.find((j) => j.name === name)
    if (!job) throw notFound(`no job ${name}`)
    const file = sched.file
    const text = fs.readFileSync(file, 'utf8')
    const want = sub === 'enable'
    const blockRe = new RegExp(`(\\[\\[job\\]\\](?:(?!\\[\\[job\\]\\])[\\s\\S])*?name\\s*=\\s*"${name}"[\\s\\S]*?)(?=\\[\\[job\\]\\]|$)`)
    const m = blockRe.exec(text)
    if (!m) throw notFound(`could not find job ${name} in ${file}`)
    let block = m[1]
    block = block.replace(/\nenabled\s*=\s*(true|false)/, '')
    if (!want) block = block.replace(/(name\s*=\s*"[^"]+")/, '$1\nenabled = false')
    fs.writeFileSync(file, text.slice(0, m.index) + block + text.slice(m.index + m[1].length))
    return report(ctx, { job: name, enabled: want }, `${name} ${want ? 'enabled' : 'disabled'} in ${file} (commit it)`)
  }
  if (sub === 'approve') {
    const name = rest.find((r) => !r.startsWith('-'))
    const planHash = typeof f['plan-hash'] === 'string' ? f['plan-hash'] : null
    if (!name || !planHash) throw usage('schedule approve <job> --plan-hash <sha256> [--expires 2026-11-21]')
    const id = f.id || `appr_${name}_${Date.now().toString(36)}`
    const file = approvalFile(root, id)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const record = {
      id,
      job: name,
      plan_hash: planHash,
      approved_by: f.by || process.env.USER || 'operator',
      approved_at: nowIso(),
      expires: f.expires || new Date(Date.now() + 30 * 86400_000).toISOString(),
      max_runs: Number(f['max-runs'] || 0) || null,
    }
    fs.writeFileSync(file, JSON.stringify(record, null, 2))
    return report(ctx, record, `standing approval ${id} written for ${name} until ${record.expires}\nset approval = "standing:${id}" in schedule.toml`)
  }
  throw usage(`unknown schedule command: ${sub}`)
}
