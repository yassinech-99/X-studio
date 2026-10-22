/**
 * A small, strict TOML reader. It covers exactly what OpenInfra's own files use — tables, arrays of tables,
 * dotted keys, basic/literal strings, integers, floats, booleans, arrays (multi-line) and inline tables — and
 * throws on anything it does not understand rather than guessing.
 *
 * Deliberately not a general TOML implementation: no date objects (dates stay strings), no multi-line strings.
 * Those are refused with a line number, because a config file that half-parses is worse than one that fails.
 */

export class TomlError extends Error {
  constructor(message, line) {
    super(line == null ? message : `line ${line}: ${message}`)
    this.name = 'TomlError'
    this.line = line
  }
}

/** Remove a trailing comment, respecting quotes. */
function stripComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '#') {
      return line.slice(0, i)
    }
  }
  return line
}

function depthOf(text) {
  let depth = 0
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') depth--
  }
  return depth
}

const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }

function parseBasicString(text, start) {
  let out = ''
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i]
    if (c === '"') return [out, i + 1]
    if (c === '\\') {
      const n = text[i + 1]
      if (n === 'u' || n === 'U') {
        const len = n === 'u' ? 4 : 8
        const hex = text.slice(i + 2, i + 2 + len)
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) throw new Error('bad unicode escape')
        out += String.fromCodePoint(parseInt(hex, 16))
        i += 1 + len
      } else if (n in ESCAPES) {
        out += ESCAPES[n]
        i++
      } else {
        throw new Error(`bad escape \\${n}`)
      }
    } else out += c
  }
  throw new Error('unterminated string')
}

function skipWs(text, i) {
  while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++
  return i
}

function parseValue(text, i) {
  i = skipWs(text, i)
  const c = text[i]
  if (c === '"') return parseBasicString(text, i)
  if (c === "'") {
    const end = text.indexOf("'", i + 1)
    if (end < 0) throw new Error('unterminated literal string')
    return [text.slice(i + 1, end), end + 1]
  }
  if (c === '[') {
    const arr = []
    i++
    for (;;) {
      i = skipWs(text, i)
      if (text[i] === ']') return [arr, i + 1]
      const [v, next] = parseValue(text, i)
      arr.push(v)
      i = skipWs(text, next)
      if (text[i] === ',') i++
      else if (text[i] !== ']') throw new Error('expected , or ] in array')
    }
  }
  if (c === '{') {
    const obj = {}
    i++
    for (;;) {
      i = skipWs(text, i)
      if (text[i] === '}') return [obj, i + 1]
      const [keyPath, afterKey] = parseKey(text, i)
      i = skipWs(text, afterKey)
      if (text[i] !== '=') throw new Error('expected = in inline table')
      const [v, next] = parseValue(text, i + 1)
      assignPath(obj, keyPath, v)
      i = skipWs(text, next)
      if (text[i] === ',') i++
      else if (text[i] !== '}') throw new Error('expected , or } in inline table')
    }
  }
  // bare token
  const start = i
  while (i < text.length && !',]}'.includes(text[i]) && text[i] !== '\n') i++
  const raw = text.slice(start, i).trim()
  if (raw === '') throw new Error('missing value')
  if (raw === 'true') return [true, i]
  if (raw === 'false') return [false, i]
  if (/^[+-]?\d[\d_]*$/.test(raw)) return [Number(raw.replace(/_/g, '')), i]
  if (/^[+-]?(\d[\d_]*)?\.\d[\d_]*([eE][+-]?\d+)?$/.test(raw) || /^[+-]?\d[\d_]*[eE][+-]?\d+$/.test(raw)) {
    return [Number(raw.replace(/_/g, '')), i]
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return [raw, i] // dates stay strings
  throw new Error(`unrecognised value: ${raw}`)
}

function parseKey(text, i) {
  const parts = []
  let cur = ''
  let any = false
  for (; i < text.length; i++) {
    const c = text[i]
    if (c === ' ' || c === '\t') {
      if (any) {
        // look ahead: a space before a dot is allowed
        let j = i
        while (text[j] === ' ' || text[j] === '\t') j++
        if (text[j] === '.') { i = j - 1; continue }
        break
      }
      continue
    }
    if (c === '.') {
      if (!any) throw new Error('empty key segment')
      parts.push(cur)
      cur = ''
      any = false
      continue
    }
    if (c === '=' || c === ']' || c === '}' || c === ',') break
    cur += c
    any = true
  }
  if (any) parts.push(cur)
  if (!parts.length) throw new Error('empty key')
  return [parts.map((p) => p.replace(/^["']|["']$/g, '')), i]
}

function assignPath(root, keyPath, value) {
  let node = root
  for (let i = 0; i < keyPath.length - 1; i++) {
    const k = keyPath[i]
    if (!(k in node)) node[k] = {}
    else if (typeof node[k] !== 'object' || Array.isArray(node[k])) throw new Error(`key ${k} is not a table`)
    node = node[k]
  }
  const last = keyPath[keyPath.length - 1]
  if (last in node) throw new Error(`duplicate key: ${keyPath.join('.')}`)
  node[last] = value
}

function descend(root, tablePath) {
  let node = root
  for (const k of tablePath) {
    if (!(k in node)) node[k] = {}
    node = node[k]
    if (Array.isArray(node)) node = node[node.length - 1]
    if (typeof node !== 'object' || node === null) throw new Error(`key ${k} is not a table`)
  }
  return node
}

export function parseToml(text) {
  const root = {}
  let current = root
  const lines = String(text).split(/\r?\n/)
  for (let n = 0; n < lines.length; n++) {
    let line = stripComment(lines[n])
    if (!line.trim()) continue
    // accumulate multi-line arrays / inline tables
    let depth = depthOf(line)
    while (depth > 0) {
      n++
      if (n >= lines.length) throw new TomlError('unterminated multi-line value', n)
      const more = stripComment(lines[n])
      line += '\n' + more
      depth += depthOf(more)
    }
    const trimmed = line.trim()
    try {
      if (trimmed.startsWith('[[')) {
        if (!trimmed.endsWith(']]')) throw new Error('unterminated array-of-tables header')
        const [, pathStr] = [trimmed, trimmed.slice(2, -2)]
        const keyPath = parseKey(pathStr.trim(), 0)[0]
        const parentPath = keyPath.slice(0, -1)
        const parent = descend(root, parentPath)
        const last = keyPath[keyPath.length - 1]
        if (last in parent && !Array.isArray(parent[last])) throw new Error(`${last} is not an array of tables`)
        if (!(last in parent)) parent[last] = []
        const obj = {}
        parent[last].push(obj)
        current = obj
      } else if (trimmed.startsWith('[')) {
        if (!trimmed.endsWith(']')) throw new Error('unterminated table header')
        const keyPath = parseKey(trimmed.slice(1, -1).trim(), 0)[0]
        current = descend(root, keyPath)
      } else {
        const [keyPath, afterKey] = parseKey(line, 0)
        let i = afterKey
        while (i < line.length && /\s/.test(line[i])) i++
        if (line[i] !== '=') throw new Error('expected =')
        const [value] = parseValue(line, i + 1)
        assignPath(current, keyPath, value)
      }
    } catch (err) {
      throw new TomlError(err.message, n + 1)
    }
  }
  return root
}

/** Minimal emitter for the files we write (config, schedule, lock). Full paths, stable order, no surprises. */
export function stringifyToml(value, indent = '', prefix = '') {
  const out = []
  const scalars = []
  const tables = []
  for (const [k, v] of Object.entries(value)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) tables.push([k, v])
    else if (Array.isArray(v) && v.length && v.every((x) => x !== null && typeof x === 'object')) tables.push([k, v])
    else scalars.push([k, v])
  }
  for (const [k, v] of scalars) out.push(`${indent}${k} = ${formatValue(v)}`)
  for (const [k, v] of tables) {
    const full = prefix ? `${prefix}.${k}` : k
    if (Array.isArray(v)) {
      for (const item of v) {
        out.push('', `${indent}[[${full}]]`)
        out.push(stringifyToml(item, indent, full))
      }
    } else {
      out.push('', `${indent}[${full}]`)
      out.push(stringifyToml(v, indent, full))
    }
  }
  return out.filter((l, i, a) => !(l === '' && (a[i - 1] === '' || i === 0))).join('\n')
}

function formatValue(v) {
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.map(formatValue).join(', ')}]`
  if (v === null) throw new Error('null is not representable in TOML')
  return `{ ${Object.entries(v).map(([k, x]) => `${k} = ${formatValue(x)}`).join(', ')} }`
}
