/**
 * Command classification for the bash tool.
 *
 * This is *not* a model and must never be one: a model that decides whether a command is safe is a model that
 * can be talked out of it. It is a shell splitter plus verb tables, and it is deliberately conservative — an
 * unknown command is `unknown`, never `read`.
 *
 * Tiers, strongest first: dangerous > infra-write > workspace-write > read. A compound command takes the max
 * tier of its parts, including command substitutions and pipelines.
 */
import path from 'node:path'

export const TIERS = ['read', 'workspace-write', 'infra-write', 'dangerous', 'unknown']
const RANK = { read: 0, 'workspace-write': 1, unknown: 2, 'infra-write': 3, dangerous: 4 }

export function higherTier(a, b) {
  return (RANK[a] ?? 2) >= (RANK[b] ?? 2) ? a : b
}

const READ_VERBS = new Set([
  'ls', 'll', 'cat', 'head', 'tail', 'less', 'more', 'bat', 'grep', 'egrep', 'rg', 'ag', 'wc', 'sort', 'uniq',
  'cut', 'tr', 'diff', 'cmp', 'comm', 'stat', 'file', 'du', 'df', 'tree', 'echo', 'printf', 'date', 'whoami',
  'hostname', 'id', 'uname', 'uptime', 'pwd', 'env', 'printenv', 'which', 'type', 'basename', 'dirname', 'realpath',
  'readlink', 'md5sum', 'sha256sum', 'shasum', 'cksum', 'jq', 'yq', 'column', 'xxd', 'hexdump', 'strings', 'nl',
  'tac', 'seq', 'true', 'false', 'test', 'expr', 'sleep', 'man', 'help', 'cal', 'free', 'nproc', 'lscpu',
  'ping', 'ping6', 'dig', 'nslookup', 'host', 'traceroute', 'mtr', 'ss', 'netstat', 'ip', 'ifconfig', 'arp',
  'open', 'pbcopy', 'getent', 'dig',
])

const WORKSPACE_WRITE_VERBS = new Set([
  'touch', 'mkdir', 'cp', 'mv', 'rm', 'rmdir', 'ln', 'tee', 'chmod', 'patch', 'truncate', 'install', 'shred',
  'sed', 'awk', 'perl', 'python', 'python3', 'node', 'npm', 'pnpm', 'yarn',
])

const DANGEROUS_BINARIES = new Set([
  'sudo', 'su', 'doas', 'mkfs', 'mkfs.ext4', 'mkfs.xfs', 'fdisk', 'parted', 'dd', 'mount', 'umount', 'shutdown',
  'reboot', 'halt', 'poweroff', 'init', 'systemctl', 'service', 'launchctl', 'crontab', 'vi', 'vim', 'nano', 'emacs',
  'nc', 'ncat', 'netcat', 'telnet', 'socat', 'iptables', 'nft', 'ufw', 'useradd', 'userdel', 'passwd', 'visudo',
  'kill', 'pkill', 'killall', 'chown', 'chgrp', 'setcap', 'chattr', 'debugfs', 'losetup', 'mkswap', 'swapon',
])

const WRAPPER = new Set(['env', 'command', 'builtin', 'time', 'nice', 'nohup', 'stdbuf', 'timeout', 'xargs', 'chronic', 'ionice'])

/** Split a command line into simple commands, keeping the operator that preceded each one. */
export function splitSegments(cmd) {
  const segments = []
  let tokens = []
  let cur = ''
  let quote = null
  let op = null
  let i = 0
  const pushToken = () => {
    if (cur !== '') {
      tokens.push(cur)
      cur = ''
    }
  }
  const pushSegment = () => {
    pushToken()
    if (tokens.length) segments.push({ op, tokens, text: tokens.join(' ') })
    tokens = []
    op = null
  }
  while (i < cmd.length) {
    const c = cmd[i]
    if (quote) {
      if (c === '\\' && quote === '"') {
        cur += cmd[i + 1] ?? ''
        i += 2
        continue
      }
      if (c === quote) {
        quote = null
        i++
        continue
      }
      cur += c
      i++
      continue
    }
    if (c === '\\') {
      cur += cmd[i + 1] ?? ''
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      i++
      continue
    }
    if (c === '$' && cmd[i + 1] === '(') {
      const { inner, end } = captureBalanced(cmd, i + 2, '(', ')')
      cur += `$(${inner})`
      i = end
      continue
    }
    if (c === '`') {
      const end = cmd.indexOf('`', i + 1)
      const inner = end < 0 ? cmd.slice(i + 1) : cmd.slice(i + 1, end)
      cur += '`' + inner + '`'
      i = end < 0 ? cmd.length : end + 1
      continue
    }
    if (c === ';' || c === '\n') {
      pushSegment()
      op = ';'
      i++
      continue
    }
    if (c === '&' && cmd[i + 1] === '&') {
      pushSegment()
      op = '&&'
      i += 2
      continue
    }
    if (c === '|' && cmd[i + 1] === '|') {
      pushSegment()
      op = '||'
      i += 2
      continue
    }
    if (c === '|') {
      pushSegment()
      op = '|'
      i++
      continue
    }
    if (c === '&' && cmd[i + 1] !== '&') {
      // background operator: splits like ; but flags background
      pushSegment()
      op = '&'
      i++
      continue
    }
    if (/\s/.test(c)) {
      pushToken()
      i++
      continue
    }
    cur += c
    i++
  }
  pushSegment()
  return segments
}

function captureBalanced(text, start, open, close) {
  let depth = 1
  let i = start
  let quote = null
  while (i < text.length) {
    const c = text[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = null
    } else if (c === "'" || c === '"') quote = c
    else if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return { inner: text.slice(start, i), end: i + 1 }
    }
    i++
  }
  return { inner: text.slice(start), end: text.length }
}

function substitutions(segmentText) {
  const found = []
  let i = 0
  while (i < segmentText.length) {
    if (segmentText[i] === '$' && segmentText[i + 1] === '(') {
      const { inner, end } = captureBalanced(segmentText, i + 2, '(', ')')
      found.push(inner)
      i = end
      continue
    }
    if (segmentText[i] === '`') {
      const end = segmentText.indexOf('`', i + 1)
      found.push(segmentText.slice(i + 1, end < 0 ? segmentText.length : end))
      i = end < 0 ? segmentText.length : end + 1
      continue
    }
    i++
  }
  return found
}

function stripWrappers(tokens) {
  const out = [...tokens]
  for (;;) {
    if (!out.length) return { tokens: out, wrapper: null }
    const head = path.basename(out[0])
    // leading VAR=value assignments
    while (out.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0])) out.shift()
    if (!out.length) return { tokens: out, wrapper: null }
    if (WRAPPER.has(path.basename(out[0]))) {
      out.shift()
      while (out.length && out[0].startsWith('-')) {
        const flag = out.shift()
        if (['-u', '-g', '-n', '-s', '-k'].includes(flag) && out.length && !out[0].startsWith('-')) out.shift()
      }
      continue
    }
    if (head === 'sudo' || head === 'doas') return { tokens: out, wrapper: head }
    return { tokens: out, wrapper: null }
  }
}

const PIPED_TO_SHELL = /(\|\s*(sudo\s+)?(ba|z|k|da)?sh\b|\|\s*python[0-9.]*\s*$)/

/** Command substitution that hides a dangerous verb (`$(echo rm) -rf /` is not catchable in general; this
 *  catches the common shapes and the tier is already `unknown` for anything unrecognised). */
function nestedTier(text, ctx) {
  let tier = 'read'
  for (const inner of substitutions(text)) {
    const r = classifyCommand(inner, ctx)
    tier = higherTier(tier, r.tier)
  }
  return tier
}

function redirectionTier(segmentText, ctx) {
  let tier = 'read'
  const re = /(^|\s)(>>?)(\s*)([^\s;|&]+)/g
  let m
  while ((m = re.exec(segmentText))) {
    const target = m[4].replace(/^["']|["']$/g, '')
    if (target === '/dev/null' || target === '&1' || target === '&2' || /^&[12]$/.test(target)) continue
    tier = higherTier(tier, pathTier(target, ctx))
  }
  const teeRe = /\|\s*tee\s+(-a\s+)?([^\s;|&]+)/
  const tm = segmentText.match(teeRe)
  if (tm) tier = higherTier(tier, pathTier(tm[2], ctx))
  return tier
}

function pathTier(target, ctx) {
  if (/^\/dev\/(null|stdout|stderr|tty)$/.test(target)) return 'read'
  if (target.startsWith('/etc/') || target.startsWith('/boot/') || target.startsWith('/var/') || target.startsWith('/usr/') || target.startsWith('/bin/') || target.startsWith('/sbin/')) {
    return 'dangerous'
  }
  if (target === '~' || target === '$HOME' || target.startsWith('../')) return 'dangerous'
  const ws = ctx.workspace || process.cwd()
  const resolved = path.resolve(ws, target.replace(/^\$\{?HOME\}?/, process.env.HOME || '~'))
  if (resolved === ws || resolved.startsWith(ws + path.sep)) return 'workspace-write'
  return 'dangerous'
}

function rmTier(args, ctx) {
  const flags = args.filter((a) => a.startsWith('-')).join('')
  const targets = args.filter((a) => !a.startsWith('-'))
  const recursive = /[rR]/.test(flags) || args.some((a) => a === '--recursive')
  const rootish = new Set(['/', '/*', '~', '$HOME', '..', '../', '.', './', '*', '/etc', '/usr', '/var', '/bin', '/home', '/opt', '/srv'])
  const dangerousTarget = targets.some((t) => {
    const trimmed = t.replace(/(.)\/+$/, '$1')
    if (rootish.has(trimmed) || rootish.has(t)) return true
    // a bare top-level absolute path (rm -rf /usr) is never a workspace edit
    if (trimmed.startsWith('/') && trimmed.split('/').filter(Boolean).length === 1) return true
    const ws = ctx.workspace || process.cwd()
    const resolved = path.resolve(ws, trimmed)
    return !(resolved === ws || resolved.startsWith(ws + path.sep))
  })
  if (dangerousTarget) return 'dangerous'
  return recursive ? 'workspace-write' : 'workspace-write'
}

function kubectlTier(args) {
  const readSub = new Set(['get', 'describe', 'logs', 'top', 'explain', 'api-resources', 'api-versions', 'version', 'cluster-info', 'config', 'auth', 'diff', 'events', 'wait', 'completion', 'options'])
  const writeSub = new Set(['apply', 'create', 'delete', 'patch', 'edit', 'scale', 'cordon', 'uncordon', 'drain', 'taint', 'exec', 'port-forward', 'rollout', 'set', 'label', 'annotate', 'replace', 'run', 'expose', 'debug', 'proxy', 'cp', 'attach', 'certificate', 'kustomize'])
  const sub = args.find((a) => !a.startsWith('-')) || ''
  if (writeSub.has(sub)) return 'infra-write'
  if (readSub.has(sub)) return 'read'
  return 'unknown'
}

function tofuTier(args) {
  const readSub = new Set(['plan', 'validate', 'fmt', 'output', 'show', 'version', 'providers', 'graph', 'console', 'state', 'workspace', 'login', 'init'])
  const writeSub = new Set(['apply', 'destroy', 'import', 'taint', 'untaint', 'force-unlock', 'refresh', 'test'])
  const sub = args.find((a) => !a.startsWith('-')) || ''
  if (writeSub.has(sub)) {
    // `tofu init` is harmless; `tofu state push` is not
    if (sub === 'state' || sub === 'workspace') return 'workspace-write'
    return 'infra-write'
  }
  if (readSub.has(sub)) {
    if (sub === 'state' || sub === 'workspace') return 'workspace-write'
    if (sub === 'plan') {
      const allArgs = args.join(' ')
      if (/-destroy\b/.test(allArgs)) return 'infra-write'
      return 'read'
    }
    return 'read'
  }
  return 'unknown'
}

function ansibleTier(binary, args) {
  const joined = args.join(' ')
  if (binary === 'ansible-playbook') {
    if (/--check\b|--syntax-check\b|--list-tasks\b|--list-hosts\b|--list-tags\b|--list-tags\b/.test(joined)) return 'read'
    return 'infra-write'
  }
  if (binary === 'ansible') return args.includes('-m') || args.includes('--module-name') ? 'infra-write' : 'read'
  if (['ansible-inventory', 'ansible-doc', 'ansible-config', 'ansible-galaxy', 'ansible-lint'].includes(binary)) return 'read'
  return 'unknown'
}

function cloudTier(binary, args) {
  const readVerb = new Set(['get', 'list', 'describe', 'show', 'ls', 'view', 'read', 'query', 'whoami', 'sts', 'assume-role', 'configure', 'help'])
  const writeVerb = new Set(['create', 'delete', 'update', 'put', 'patch', 'apply', 'set', 'deploy', 'start', 'stop', 'terminate', 'run', 'attach', 'detach', 'enable', 'disable', 'invoke', 'publish', 'rm', 'mv', 'cp', 'sync', 'restore'])
  const verb = args.find((a) => !a.startsWith('-')) || ''
  if (writeVerb.has(verb)) return 'infra-write'
  if (readVerb.has(verb) || verb === '') return 'read'
  return 'unknown'
}

function gitTier(args) {
  const sub = args.find((a) => !a.startsWith('-')) || ''
  const joined = args.join(' ')
  if (sub === 'push') return /--force|-f\b/.test(joined) ? 'dangerous' : 'infra-write'
  if (['reset', 'clean', 'restore', 'revert'].includes(sub)) return 'workspace-write'
  if (['clone', 'fetch', 'pull'].includes(sub)) return 'workspace-write'
  if (['add', 'commit', 'checkout', 'switch', 'branch', 'merge', 'rebase', 'stash', 'mv', 'rm', 'init', 'tag', 'apply', 'cherry-pick', 'am'].includes(sub)) return 'workspace-write'
  return 'read'
}

/**
 * Classify one command line.
 * ctx: { workspace, mode } — workspace bounds workspace-write; mode is not used for tiering.
 * Returns { tier, segments: [{command, args, tier, reason}], reasons: [{rule, tier, detail}] }
 */
export function classifyCommand(cmd, ctx = {}) {
  const text = String(cmd || '').trim()
  if (!text) return { tier: 'read', command: text, segments: [], reasons: [] }
  const reasons = []
  const segments = []
  let tier = 'read'

  const segs = splitSegments(text)
  for (const seg of segs) {
    const { tokens, wrapper } = stripWrappers(seg.tokens)
    if (!tokens.length) continue
    const binary = path.basename(tokens[0])
    const args = tokens.slice(1)
    let segTier = 'unknown'
    let note = ''

    if (wrapper === 'sudo' || wrapper === 'doas' || DANGEROUS_BINARIES.has(binary)) {
      segTier = 'dangerous'
      note = `${binary} is a privileged or destructive command`
    } else if (binary === 'rm') {
      segTier = rmTier(args, ctx)
    } else if (binary === 'kubectl' || binary === 'oc') {
      segTier = kubectlTier(args)
    } else if (binary === 'tofu' || binary === 'terraform') {
      segTier = tofuTier(args)
    } else if (binary.startsWith('ansible')) {
      segTier = ansibleTier(binary, args)
    } else if (['aws', 'gcloud', 'az', 'doctl', 'ibmcloud', 'heroku'].includes(binary)) {
      segTier = cloudTier(binary, args)
    } else if (binary === 'git') {
      segTier = gitTier(args)
    } else if (binary === 'helm') {
      const sub = args.find((a) => !a.startsWith('-')) || ''
      segTier = ['list', 'get', 'show', 'status', 'history', 'search', 'version', 'template', 'lint'].includes(sub) ? 'read' : 'infra-write'
    } else if (binary === 'curl' || binary === 'wget') {
      const joined = args.join(' ')
      const writey = /(-X|--request)\s*(POST|PUT|PATCH|DELETE)|(^|\s)(-d|--data|--data-binary|--data-raw|-F|--form|-T|--upload-file)\b/.test(joined)
      segTier = writey ? 'infra-write' : 'read'
      if (binary === 'curl' && /-o\s|--output\s/.test(joined)) segTier = higherTier(segTier, 'workspace-write')
    } else if (binary === 'ssh' || binary === 'scp' || binary === 'sftp' || binary === 'rsync') {
      // Cannot tell a `show` from a `configure terminal`; the device adapter is the sanctioned path.
      segTier = 'unknown'
      note = 'ssh/rsync are not a sanctioned change path; use `oi device read` or `oi change`'
    } else if (binary === 'docker' || binary === 'podman') {
      const sub = args.find((a) => !a.startsWith('-')) || ''
      segTier = ['ps', 'images', 'logs', 'inspect', 'version', 'top', 'stats', 'image', 'container'].includes(sub) ? 'read' : 'infra-write'
    } else if (binary === 'oi' || binary === 'openinfra') {
      const verb = args.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ')
      segTier = /^change (run|apply|approve)|^schedule (run|enable|disable)|^tools install|^workspace (new|rm)/.test(verb)
        ? 'infra-write'
        : 'read'
    } else if (binary === 'chmod' || binary === 'chown') {
      segTier = 'dangerous'
    } else if (READ_VERBS.has(binary)) {
      segTier = 'read'
      if (binary === 'sed' && /(^|\s)-i/.test(' ' + args.join(' '))) segTier = 'workspace-write'
      if (binary === 'find' && /(-delete|-exec|-execdir|-ok)/.test(' ' + args.join(' '))) segTier = 'workspace-write'
    } else if (WORKSPACE_WRITE_VERBS.has(binary)) {
      segTier = 'workspace-write'
      if (binary === 'shred') segTier = 'dangerous'
    } else if (['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'].includes(binary)) {
      const script = args.join(' ')
      if (args.includes('-c') || script) {
        const inner = args.slice(args.indexOf('-c') + 1).join(' ')
        segTier = inner ? classifyCommand(inner, ctx).tier : 'unknown'
      } else segTier = 'unknown'
    } else if (['node', 'python', 'python3', 'ruby', 'perl'].includes(binary) && args.includes('-e')) {
      segTier = 'unknown'
    } else {
      segTier = 'unknown'
    }

    const nested = nestedTier(seg.text, ctx)
    const redirect = redirectionTier(seg.text, ctx)
    const segFinal = [segTier, nested, redirect].reduce((a, b) => higherTier(a, b), 'read')

    if (segFinal !== 'read') {
      reasons.push({ command: seg.text, tier: segFinal, rule: note || `${binary} ${args[0] || ''}`.trim() })
    }
    segments.push({ command: binary, args, tier: segFinal, op: seg.op })
    tier = higherTier(tier, segFinal)
  }

  // patterns that span the whole line
  if (/(^|\s)(sudo)\s/.test(text)) {
    tier = 'dangerous'
    reasons.push({ rule: 'sudo', tier: 'dangerous', detail: 'privilege escalation' })
  }
  if (PIPED_TO_SHELL.test(text) || /(curl|wget)[^|]*\|\s*(ba)?sh/.test(text)) {
    tier = 'dangerous'
    reasons.push({ rule: 'pipe-to-shell', tier: 'dangerous', detail: 'downloads and executes code' })
  }
  if (/:\(\)\s*\{.*\|.*&.*\}/.test(text)) {
    tier = 'dangerous'
    reasons.push({ rule: 'fork-bomb', tier: 'dangerous' })
  }
  if (/\b(base64|xxd|openssl)\b[^|]*\|\s*(ba)?sh/.test(text)) {
    tier = 'dangerous'
    reasons.push({ rule: 'decoded-payload', tier: 'dangerous' })
  }
  return { tier, command: text, segments, reasons }
}

/** Policy: mode × tier → allow | ask | deny, with the rule that decided it. */
export function decide(tier, ctx = {}) {
  const mode = ctx.mode || 'explore'
  const matrix = {
    explore: { read: 'allow', 'workspace-write': 'deny', 'infra-write': 'deny', dangerous: 'deny', unknown: 'ask' },
    plan: { read: 'allow', 'workspace-write': 'allow', 'infra-write': 'deny', dangerous: 'deny', unknown: 'ask' },
    execute: { read: 'allow', 'workspace-write': 'allow', 'infra-write': 'deny', dangerous: 'deny', unknown: 'allow' },
    incident: { read: 'allow', 'workspace-write': 'deny', 'infra-write': 'allow', dangerous: 'deny', unknown: 'ask' },
  }
  const row = matrix[mode] || matrix.explore
  const verdict = row[tier] || 'ask'
  const reason =
    verdict === 'allow'
      ? `${tier} is allowed in ${mode} mode`
      : verdict === 'ask'
        ? `${tier} needs confirmation in ${mode} mode`
        : `${tier} is not allowed in ${mode} mode${tier === 'infra-write' ? ' (use `oi change`)' : ''}`
  return { verdict, reason, mode, tier }
}
