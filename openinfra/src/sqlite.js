/**
 * `node:sqlite` is still flagged experimental in Node 22 and prints an ExperimentalWarning on first import.
 * A CLI cannot put that on stderr every time it runs, so we suppress only that warning and pass every other
 * one through untouched.
 */
const original = process.emitWarning.bind(process)
process.emitWarning = (warning, ...rest) => {
  const message = typeof warning === 'string' ? warning : warning?.message || ''
  if (/SQLite is an experimental feature/i.test(message)) return
  return original(warning, ...rest)
}

const sqlite = await import('node:sqlite')
export const { DatabaseSync, StatementSync } = sqlite
export default sqlite
