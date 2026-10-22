/**
 * The exit-code contract. One table, used by every verb, documented in OPENINFRA_CLI_FIRST.md.
 * CI depends on these, so they are constants and never inlined.
 */

export const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1, // unclassified failure
  DRIFT: 2, // drift found (check mode)
  PARTIAL: 3, // partial failure / target lease conflict
  UNAPPROVED: 4, // change exists but is not approved (or approval could not be verified)
  NOTFOUND: 5, // selector resolved to nothing
  USAGE: 6, // bad arguments / config
  HASH_MISMATCH: 7, // plan or lockfile changed since approval
  TOOLCHAIN: 8, // tool missing / version mismatch / unverified install
  WORKSPACE: 9, // workspace missing, ambiguous or unsafe (eg. network filesystem)
})

export const EXIT_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(EXIT).map(([name, code]) => [code, name.toLowerCase()])),
)

export class OiError extends Error {
  constructor(message, code = EXIT.ERROR, extra = {}) {
    super(message)
    this.name = 'OiError'
    this.exitCode = code
    Object.assign(this, extra)
  }
  toJSON() {
    return { error: this.message, code: this.exitCode, ...(this.detail ? { detail: this.detail } : {}) }
  }
}

export const usage = (msg, detail) => new OiError(msg, EXIT.USAGE, detail ? { detail } : {})
export const notFound = (msg) => new OiError(msg, EXIT.NOTFOUND)
export const workspaceError = (msg) => new OiError(msg, EXIT.WORKSPACE)
export const toolchainError = (msg) => new OiError(msg, EXIT.TOOLCHAIN)
