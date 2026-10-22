/**
 * Terminal sanitisation. Anything a device, a cloud API or a log line returns is *data*; if we print its escape
 * sequences, it becomes control of the operator's terminal (title changes, clipboard writes, cursor games, and in
 * some terminals worse). So every captured stream is stripped of escape sequences before it is shown or stored.
 *
 * Text is kept — newlines, tabs, and printable characters including non-ASCII. Only the control layer goes.
 */
export function sanitizeTerminal(input) {
  if (input == null) return input
  return String(input)
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '') // OSC (titles, clipboard)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI (colours, cursor)
    .replace(/\u001b[@-Z\\-_]/g, '') // other two-byte escapes
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '') // C0 controls except tab/newline
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

/** A cheaper check used by doctor and tests: does this text still contain an escape sequence? */
export function hasEscapes(text) {
  return /\u001b/.test(String(text ?? ''))
}
