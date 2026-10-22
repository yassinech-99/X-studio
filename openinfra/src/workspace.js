/**
 * Workspaces: a named, git-tracked folder with its own config, intent, schedules and history.
 *
 * The id (`ws_…`) is stable and is what gets written into findings, runs and approvals — so renaming the folder
 * or moving it does not orphan the audit trail. The path is a convenience, the id is the identity.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { workspacePaths, paths } from './paths.js'
import { readJson, writeAtomicSync, mkdirpSync, networkFilesystem } from './fsutil.js'
import { parseToml, stringifyToml } from './toml.js'
import { OiError, EXIT, workspaceError } from './exit.js'

export const TEMPLATES = {
  'network-core': {
    description: 'network devices: inventory, intent, drift and compliance schedules',
    dirs: ['intent', 'inventory', 'ansible', 'rules', 'scripts'],
  },
  'cloud-iac': {
    description: 'Terraform/OpenTofu environments with a nightly plan',
    dirs: ['terraform/envs/prod', 'terraform/modules', 'rules', 'scripts'],
  },
  'k8s-ops': {
    description: 'read-only Kubernetes operations and drift on cluster objects',
    dirs: ['k8s', 'rules', 'scripts'],
  },
  lab: {
    description: 'a small mixed environment to learn the harness on',
    dirs: ['intent', 'inventory', 'scripts', 'ansible'],
  },
  empty: { description: 'nothing but the config', dirs: [] },
}

export const WORKSPACE_ID = /^ws_[a-z0-9]{8,32}$/
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/

export function registryFile(home = paths.home) {
  return path.join(home, 'workspaces.json')
}

export function readRegistry(home = paths.home) {
  return readJson(registryFile(home), { workspaces: [] })
}

export function registerWorkspace(entry, home = paths.home) {
  const reg = readRegistry(home)
  const existing = reg.workspaces.findIndex((w) => w.id === entry.id)
  if (existing >= 0) reg.workspaces[existing] = { ...reg.workspaces[existing], ...entry }
  else reg.workspaces.push(entry)
  writeAtomicSync(registryFile(home), JSON.stringify(reg, null, 2) + '\n')
  return entry
}

export function listWorkspaces(home = paths.home) {
  const reg = readRegistry(home)
  return reg.workspaces.map((w) => ({ ...w, exists: fs.existsSync(path.join(w.path, '.openinfra', 'config.toml')) }))
}

export function findWorkspace(start = process.cwd()) {
  let dir = path.resolve(start)
  for (let i = 0; i < 40; i++) {
    const cfg = path.join(dir, '.openinfra', 'config.toml')
    if (fs.existsSync(cfg)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export function requireWorkspace(start = process.cwd()) {
  const root = findWorkspace(start)
  if (!root) {
    throw workspaceError(`not inside an OpenInfra workspace (looking for .openinfra/config.toml from ${start}). Run \`oi workspace new <name>\` or \`oi init\`.`)
  }
  const net = networkFilesystem(root)
  if (net) throw workspaceError(`workspace lives on a network filesystem (${net.fstype} at ${net.mount}); SQLite locking and git are unsafe there`)
  return root
}

export function workspaceConfig(root) {
  const cfgFile = workspacePaths(root).config
  if (!fs.existsSync(cfgFile)) return null
  return parseToml(fs.readFileSync(cfgFile, 'utf8'))
}

export function workspaceIdOf(root) {
  try {
    return workspaceConfig(root)?.workspace?.id || null
  } catch {
    return null
  }
}

const SCHEDULE_BY_TEMPLATE = {
  'network-core': `[defaults]
timezone = "${Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'}"
overlap = "skip"
missed = "skip"
timeout = "30m"

[[job]]
name = "drift-devices"
kind = "drift"
cron = "17,47 * * * *"
fail_on = "high"
`,
  'cloud-iac': `[defaults]
timezone = "${Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'}"
overlap = "skip"
timeout = "45m"

[[job]]
name = "tofu-nightly-plan"
kind = "tofu"
cron = "23 2 * * *"
dir = "terraform/envs/prod"
command = "plan -refresh=false -detailed-exitcode -lock=false -no-color"
fail_on = "any"
`,
  'k8s-ops': `[defaults]
timezone = "${Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'}"

[[job]]
name = "k8s-drift"
kind = "drift"
cron = "11 * * * *"
`,
  lab: `[defaults]
timezone = "${Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'}"
overlap = "skip"
timeout = "5m"

[[job]]
name = "lab-smoke"
kind = "bash"
cron = "*/15 * * * *"
command = "echo lab ok && date -u +%FT%TZ"
`,
  empty: `[defaults]
timezone = "${Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'}"
`,
}

const INTENT_BY_TEMPLATE = {
  'network-core': `# Desired state. Keys are compared leaf-by-leaf against what the devices actually report.
[devices.sw-core-01]
hostname = "sw-core-01"
site = "bldg-c"
ntp = ["10.0.0.1", "10.0.0.2"]
"interfaces.Gi1/0/1.description" = "uplink-core"
"interfaces.Gi1/0/1.mtu" = 9000

[devices.sw-edge-01]
hostname = "sw-edge-01"
site = "bldg-c"
`,
  lab: `[devices.lab-sw-01]
hostname = "lab-sw-01"
site = "lab"
"interfaces.Gi0/1.description" = "uplink"
`,
}

export function createWorkspace({ name, dir = null, template = 'lab', home = paths.home, git = true, now = new Date() } = {}) {
  if (!name) throw new OiError('workspace name is required', EXIT.USAGE)
  if (!NAME.test(name)) throw new OiError(`workspace name "${name}" must match ${NAME} (lowercase, dots/dashes ok)`, EXIT.USAGE)
  if (!TEMPLATES[template]) throw new OiError(`unknown template "${template}"; use ${Object.keys(TEMPLATES).join(', ')}`, EXIT.USAGE)
  const root = path.resolve(dir || path.join(process.cwd(), name))
  if (fs.existsSync(path.join(root, '.openinfra', 'config.toml'))) {
    throw workspaceError(`${root} is already an OpenInfra workspace`)
  }
  const net = networkFilesystem(path.dirname(root))
  if (net && net.fstype !== 'overlay' && net.fstype !== 'tmpfs') {
    throw workspaceError(`${path.dirname(root)} is on ${net.fstype}; workspaces cannot live on network filesystems`)
  }
  mkdirpSync(root)
  const ws = workspacePaths(root)
  mkdirpSync(ws.meta)
  for (const d of TEMPLATES[template].dirs) mkdirpSync(path.join(root, d))

  const id = `ws_${crypto.randomBytes(8).toString('hex')}`
  const cfg = {
    workspace: { id, name, template, created: now.toISOString() },
    agent: { mode: 'explore', max_steps: 40, sandbox: 'allow-workspace' },
    change: { require_signed_approval: true, allow_model_fallback: false },
  }
  writeAtomicSync(ws.config, `# OpenInfra workspace config. See docs/OPENINFRA_PLAN.md §6.\n${stringifyToml(cfg)}\n`)
  writeAtomicSync(ws.schedule, SCHEDULE_BY_TEMPLATE[template] || SCHEDULE_BY_TEMPLATE.empty)
  writeAtomicSync(
    path.join(root, 'openinfra.lock'),
    `# Pinned toolchain. Written by \`oi tools lock\`; changing it changes the plan hash.\n`,
  )
  if (INTENT_BY_TEMPLATE[template]) writeAtomicSync(path.join(root, 'intent', 'state.toml'), INTENT_BY_TEMPLATE[template])
  writeAtomicSync(
    path.join(root, '.gitignore'),
    ['node_modules/', '.openinfra/cache/', '.openinfra/runs/', '.openinfra/sessions/', '.openinfra/tick.log', '*.log', '.terraform/', '*.tfstate', '*.tfstate.backup', ''].join('\n'),
  )
  writeAtomicSync(
    path.join(root, 'AGENTS.md'),
    `# ${name}\n\nThis is an OpenInfra workspace (${template}).\n\n- \`oi doctor\` — check what this workspace can reach\n- \`oi drift check\` — compare intent/ with the observed state\n- \`oi schedule list\` — what runs when\n- \`oi change\` — propose, review and approve a change\n\nThe agent reads this file. Keep it short and factual: what the environment is, what is never to be changed\nwithout a human, and where the runbooks are.\n`,
  )

  let gitState = 'skipped'
  if (git) {
    const g = spawnSync('git', ['init', '-q', '-b', 'main', root], { encoding: 'utf8' })
    if (g.status === 0) {
      spawnSync('git', ['-C', root, 'add', '.'], { encoding: 'utf8' })
      const commit = spawnSync(
        'git',
        ['-C', root, '-c', 'user.name=openinfra', '-c', 'user.email=openinfra@localhost', 'commit', '-q', '-m', `workspace: ${name} (${template})`],
        { encoding: 'utf8' },
      )
      gitState = commit.status === 0 ? 'initial commit' : 'init only'
    } else {
      gitState = 'git unavailable'
    }
  }

  const entry = { id, name, path: root, template, created: now.toISOString(), git: gitState }
  registerWorkspace(entry, home)
  return { ...entry, config: ws.config, schedule: ws.schedule, files: listFiles(root) }
}

export function listFiles(root, limit = 200) {
  const out = []
  const walk = (dir, depth = 0) => {
    if (out.length >= limit || depth > 4) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === '.git' || e.name === 'node_modules') continue
      const rel = path.relative(root, path.join(dir, e.name))
      if (e.isDirectory()) {
        out.push(rel + '/')
        walk(path.join(dir, e.name), depth + 1)
      } else out.push(rel)
    }
  }
  walk(root)
  return out
}

export function removeWorkspace({ nameOrId, home = paths.home, deleteFiles = false }) {
  const reg = readRegistry(home)
  const entry = reg.workspaces.find((w) => w.id === nameOrId || w.name === nameOrId || w.path === path.resolve(nameOrId))
  if (!entry) throw new OiError(`no workspace ${nameOrId}`, EXIT.NOTFOUND)
  const reg2 = { workspaces: reg.workspaces.filter((w) => w.id !== entry.id) }
  writeAtomicSync(registryFile(home), JSON.stringify(reg2, null, 2) + '\n')
  if (deleteFiles) fs.rmSync(entry.path, { recursive: true, force: true })
  return entry
}
