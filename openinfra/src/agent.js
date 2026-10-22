/**
 * The agent loop. Small on purpose — closer to Pi's 418 lines than to a framework.
 *
 * Differences from both Pi and Claude Code that matter here:
 *  - bash is the first tool in the list and the prompt says so; the typed tools are conveniences, not the API
 *  - read-only tools run in parallel, write tools run one at a time (same rule Claude Code uses)
 *  - every refusal is a *tool result*, not a thrown error, so the model can adapt instead of retrying blindly
 *  - compaction is deterministic and protects facts (targets, hashes, the user's ask) rather than summarising
 *  - nothing here knows which provider it is talking to
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { toolSpecs, runTool, READ_ONLY_TOOLS } from './tools.js'
import { withRetry } from './providers/index.js'
import { redact, redactDeep } from './redact.js'
import { appendLine, mkdirp } from './fsutil.js'
import { estimateCost } from './providers/index.js'
import { workspacePaths } from './paths.js'

export const SYSTEM_PROMPT = `You are OpenInfra, an infrastructure engineer's assistant running in their terminal.

You have one primary tool: bash. It runs real commands in the workspace with the project's pinned toolchain on
PATH. Everything the product can do is a command, so reach for bash first: git, kubectl, tofu, ansible, jq, grep,
curl. The file tools (read, write, edit, grep, glob) exist so you do not have to paste files through the shell —
use read before edit, and make edits by exact match.

Rules that are not negotiable:
- Never change infrastructure with bash. \`tofu apply\`, \`ansible-playbook\` without --check, \`kubectl apply\` and
  \`git push\` are refused. To change something, propose it with \`oi change\` and let the approval flow run.
- Read before you write. Do not guess a file's contents.
- When a command is refused, read the reason. It tells you which rule matched and what to do instead.
- Quote the numbers you observed and name the source (command, device, timestamp). If you did not read it, say so.
- Prefer a plan and a diff over a claim. If you are unsure, run the read-only check.
- Keep answers short. The human is at a terminal at 02:00.

You cannot install software. If a tool is missing, say which one and let the human run \`oi tools install\`.`

export function estimateTokens(messages) {
  // ~4 chars/token is close enough for a budget guard; this is not billing.
  let chars = 0
  for (const m of messages) {
    for (const c of m.content || []) {
      chars += (c.text || c.content || '').length + (c.input ? JSON.stringify(c.input).length : 0) + 8
    }
  }
  return Math.ceil(chars / 4)
}

/**
 * Deterministic compaction. Facts win: the first user message and the last `keepRecent` messages stay verbatim;
 * older tool results are replaced by a stub that keeps the exit code and the artifact reference.
 */
export function compactMessages(messages, { keepRecent = 6, maxTokens = 100_000 } = {}) {
  const before = estimateTokens(messages)
  if (before <= maxTokens) return { messages, compacted: false, before, after: before }
  const head = messages[0]
  const tail = messages.slice(-keepRecent)
  const middle = messages.slice(1, -keepRecent)
  const squashed = middle.map((m) => {
    if (m.role !== 'tool') return { ...m, content: m.content.filter((c) => c.type === 'tool_result').length ? m.content : m.content }
    return {
      role: 'tool',
      content: m.content.map((c) =>
        c.type === 'tool_result'
          ? {
              type: 'tool_result',
              id: c.id,
              is_error: c.is_error,
              content: `${String(c.content).slice(0, 240)}${String(c.content).length > 240 ? `\n[…compacted, ${c.meta?.tool || 'tool'} result truncated]` : ''}`,
            }
          : c,
      ),
    }
  })
  const out = [head, ...squashed, ...tail]
  return { messages: out, compacted: true, before, after: estimateTokens(out) }
}

export async function runAgent({
  provider,
  providerId,
  model,
  mode = 'explore',
  workspace,
  prompt,
  rules,
  store = null,
  artifacts = null,
  runId = null,
  sessionId = randomUUID(),
  approve = null,
  maxSteps = 40,
  budgetUsd = null,
  maxContext = 100_000,
  onEvent = () => {},
  signal = null,
  env = {},
  fetchImpl = null,
}) {
  const tools = toolSpecs()
  const ctx = {
    workspace,
    mode,
    rules,
    store,
    artifacts,
    runId,
    approve,
    readFiles: new Set(),
    env,
  }
  const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  const transcriptFile = workspace ? path.join(workspacePaths(workspace).sessions, `${sessionId}.jsonl`) : null
  if (transcriptFile) await mkdirp(path.dirname(transcriptFile))

  let spent = 0
  const record = async (entry) => {
    if (!transcriptFile) return
    await appendLine(transcriptFile, JSON.stringify(redactDeep({ ts: new Date().toISOString(), session: sessionId, ...entry })))
  }

  await record({ type: 'session.start', provider: providerId, model, mode, workspace })
  await record({ type: 'user', content: prompt })
  onEvent({ type: 'session.start', sessionId, provider: providerId, model, mode })

  const state = { steps: 0, sessionId, model, providerId, mode, stopped: null, usage: { input: 0, output: 0, cost: 0 } }

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) {
      state.stopped = 'cancelled'
      break
    }
    const compacted = compactMessages(messages, { maxTokens: Math.floor(maxContext * 0.75) })
    if (compacted.compacted) {
      messages.splice(0, messages.length, ...compacted.messages)
      await record({ type: 'compaction', before: compacted.before, after: compacted.after })
      onEvent({ type: 'compaction', before: compacted.before, after: compacted.after })
    }

    const req = {
      system: SYSTEM_PROMPT,
      messages,
      tools,
      maxTokens: 4096,
      model,
      signal,
    }
    let res
    try {
      res = await withRetry(() => provider.stream(req, (delta) => onEvent({ type: 'assistant.delta', text: delta })), {
        onRetry: (info) => onEvent({ type: 'provider.retry', ...info, error: redact(info.error.message) }),
      })
    } catch (err) {
      state.stopped = 'provider_error'
      state.error = redact(err.message)
      await record({ type: 'error', error: state.error })
      onEvent({ type: 'error', error: state.error })
      break
    }

    state.steps = step + 1
    const usage = res.usage || {}
    state.usage.input += usage.input || 0
    state.usage.output += usage.output || 0
    const cost = estimateCost(provider.cfg || {}, usage)
    if (cost) spent += cost
    state.usage.cost = spent
    if (store) {
      try {
        store.recordCost({
          workspace,
          runId,
          provider: providerId,
          model: res.servedModel || model,
          inputTokens: usage.input || 0,
          outputTokens: usage.output || 0,
          costUsd: cost,
        })
      } catch {
        /* cost ledger is best effort; never break a turn over it */
      }
    }

    const assistantContent = []
    if (res.text) assistantContent.push({ type: 'text', text: res.text })
    for (const call of res.toolCalls || []) assistantContent.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
    messages.push({ role: 'assistant', content: assistantContent.length ? assistantContent : [{ type: 'text', text: '' }] })
    await record({ type: 'assistant', content: assistantContent, served_model: res.servedModel || null, stop: res.stopReason })
    onEvent({ type: 'assistant.message', text: res.text || '', toolCalls: (res.toolCalls || []).map((c) => ({ id: c.id, name: c.name })), usage })

    if (budgetUsd != null && spent > budgetUsd) {
      state.stopped = 'budget_exceeded'
      const note = `stopped: budget of $${budgetUsd} exceeded (spent ~$${spent.toFixed(4)})`
      messages.push({ role: 'assistant', content: [{ type: 'text', text: note }] })
      await record({ type: 'budget', spent, budgetUsd })
      onEvent({ type: 'budget', spent, budgetUsd })
      break
    }

    const calls = res.toolCalls || []
    if (!calls.length) {
      state.stopped = 'end_turn'
      break
    }

    const results = []
    const readOnly = calls.filter((c) => READ_ONLY_TOOLS.has(c.name))
    const writes = calls.filter((c) => !READ_ONLY_TOOLS.has(c.name))
    const execAll = async (group) =>
      Promise.all(
        group.map(async (call) => {
          onEvent({ type: 'tool.start', id: call.id, name: call.name, input: call.input })
          const out = await runTool(call.name, call.input, ctx)
          onEvent({
            type: 'tool.result',
            id: call.id,
            name: call.name,
            ok: out.ok !== false && !out.isError,
            verdict: out.meta?.verdict || null,
            durationMs: out.meta?.durationMs,
          })
          return { call, out }
        }),
      )
    const started = await execAll(readOnly)
    const thenWrites = await execAll(writes)
    for (const { call, out } of [...started, ...thenWrites]) {
      results.push({ call, out })
      await record({
        type: 'tool',
        id: call.id,
        name: call.name,
        input: call.input,
        ok: out.ok !== false && !out.isError,
        content: String(out.content).slice(0, 8000),
        meta: out.meta,
      })
    }
    messages.push({
      role: 'tool',
      content: results.map(({ call, out }) => ({
        type: 'tool_result',
        id: call.id,
        is_error: Boolean(out.isError),
        content: String(out.content),
        meta: out.meta,
      })),
    })
  }

  if (state.steps >= maxSteps && !state.stopped) state.stopped = 'max_steps'
  await record({ type: 'session.end', ...state })
  onEvent({ type: 'session.end', ...state })
  return { sessionId, ...state, messages, transcript: transcriptFile }
}

export function summarizeToolResult(out) {
  const text = String(out.content || '')
  return text.length > 400 ? text.slice(0, 400) + '…' : text
}
