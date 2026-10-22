/**
 * A deterministic provider for tests, demos and CI. It is not a mock of an HTTP server: it is a real provider
 * implementation that happens to answer from a script, so the agent loop, tool execution, redaction and
 * transcript writing are all exercised exactly as they are in production.
 *
 * Script format: a queue of turns. A turn is either `{ text: "..." }` or `{ tool: "bash", input: {...} }`.
 * With no script it follows a simple rule: if the last user message starts with "RUN:" it calls bash with the
 * rest, otherwise it echoes what it was asked.
 */
export function fakeProvider({ id = 'fake', script = null, model = 'fake-1', echo = true } = {}) {
  const queue = script ? [...script] : []
  let step = 0
  const nextTurn = (req) => {
    if (queue.length) return queue.shift()
    step++
    if (step > 6 || !echo) return { text: '[fake provider: no script left]' }
    const lastUserIndex = req.messages.map((m) => m.role).lastIndexOf('user')
    const last = req.messages[lastUserIndex]
    const text = (last?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ')
    // a tool result after the user's ask means the loop already ran something: answer instead of looping
    const alreadyRan = req.messages.slice(lastUserIndex + 1).some((m) => m.role === 'tool' || m.content?.some((c) => c.type === 'tool_result'))
    const run = /^RUN:\s*([\s\S]+)$/.exec(text.trim())
    if (run && !alreadyRan) return { tool: 'bash', input: { command: run[1].trim() } }
    if (alreadyRan) {
      const toolMsg = [...req.messages].reverse().find((m) => m.role === 'tool')
      const out = toolMsg?.content?.map((c) => c.content).join('\n') || ''
      return { text: `done. tool said: ${out.slice(0, 200)}` }
    }
    return { text: `fake: ${text.slice(0, 400)}` }
  }
  const answer = (req) => {
    const turn = nextTurn(req)
    const usage = { input: 10, output: 5, cost: 0 }
    if (turn.tool) {
      return {
        text: '',
        toolCalls: [{ id: `call_${step}`, name: turn.tool, input: turn.input }],
        stopReason: 'tool_use',
        servedModel: model,
        usage,
      }
    }
    return { text: turn.text ?? '', toolCalls: [], stopReason: 'end_turn', servedModel: model, usage }
  }
  return {
    id,
    kind: 'fake',
    baseUrl: 'fake://',
    async complete(req) {
      return answer(req)
    },
    async stream(req, onDelta = () => {}) {
      const r = answer(req)
      if (r.text) onDelta(r.text)
      return r
    },
    async models() {
      return [{ id: model, display: model }]
    },
  }
}
