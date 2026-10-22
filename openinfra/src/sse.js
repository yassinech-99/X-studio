/** Server-sent events: enough to parse `data: {...}` frames from four providers without a dependency. */
export async function* sseFrames(body, signal) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('aborted')
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const frame = parseFrame(raw)
        if (frame) yield frame
      }
    }
    if (buffer.trim()) {
      const frame = parseFrame(buffer)
      if (frame) yield frame
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* stream already closed */
    }
  }
}

function parseFrame(raw) {
  const lines = raw.split('\n')
  let event = null
  const data = []
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  const payload = data.join('\n')
  if (!payload) return event ? { event, data: null } : null
  if (payload === '[DONE]') return { event: event || 'done', data: null, done: true }
  try {
    return { event, data: JSON.parse(payload) }
  } catch {
    return { event, data: null, raw: payload }
  }
}
