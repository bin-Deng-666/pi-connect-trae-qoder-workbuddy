/**
 * Shared, dependency-free helpers.
 *
 * Kept in one file because every module that can also be run directly needs the
 * same main-module check, and a hand-rolled comparison of `process.argv[1]`
 * against `import.meta.url` gets it subtly wrong: paths arrive URL-encoded,
 * may be relative, and on macOS `argv[1]` can carry a resolved symlink while
 * `import.meta.url` carries the real path.
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Whether this module is the process entry point.
 *
 * Both sides are resolved through `realpathSync` before comparing, so a module
 * invoked through a symlink (an npm `bin` shim, `npx`, a linked checkout) is
 * still recognised as the entry point. A missing file is not an error: when
 * `argv[1]` is absent (an embedder, a test runner) the answer is simply `false`.
 */
export function isMainModule(metaUrl) {
  const entry = process.argv[1]
  if (entry === undefined || entry === '') return false
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(entry)
  } catch {
    return false
  }
}
