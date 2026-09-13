/**
 * Finds a language-server program on the execution host's PATH.
 *
 * Why this exists rather than spawning the bare name: `spawnProcess` requires
 * an absolute program on Windows (a bare name depends on the child's PATH,
 * which a stripped Electron environment may not have), and "is it installed?"
 * is a question Orca has to answer *before* spawning so it can show the
 * catalog's install hint instead of an ENOENT.
 *
 * On Windows the winning spelling is returned as-is, `.cmd` included:
 * `typescript-language-server` and `pyright-langserver` are npm shims, and
 * `spawnProcess` already knows how to launch those safely.
 */
import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** cmd's own default when PATHEXT is unset; `.COM` really does outrank `.EXE`. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

function isExecutableFile(candidate: string, requireExecuteBit: boolean): boolean {
  try {
    if (!statSync(candidate).isFile()) {
      return false
    }
    if (requireExecuteBit) {
      accessSync(candidate, constants.X_OK)
    }
    return true
  } catch {
    return false
  }
}

function pathExtensions(env: NodeJS.ProcessEnv): string[] {
  return (
    (env.PATHEXT || DEFAULT_PATHEXT)
      .split(';')
      // Lowercased because PATHEXT is conventionally uppercase and the joined
      // result is a path Orca shows the user; Windows itself does not care.
      .map((extension) => extension.trim().toLowerCase())
      .filter((extension) => extension.startsWith('.'))
  )
}

export type FindExecutableOptions = {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

export function findExecutableOnPath(
  command: string,
  options: FindExecutableOptions = {}
): string | null {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const windows = platform === 'win32'
  // An explicit path is the user's own choice; honour it or report it missing.
  if (/[\\/]/.test(command)) {
    return isExecutableFile(command, !windows) ? command : null
  }
  const pathValue = (windows ? env.Path ?? env.PATH : env.PATH) ?? ''
  // Not `path.delimiter`: that is the *runtime's* separator, and this function
  // answers for the target platform, which on a remote host is not this one.
  const separator = windows ? ';' : ':'
  const extensions = windows ? pathExtensions(env) : ['']
  for (const entry of pathValue.split(separator)) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1')
    // A relative PATH entry resolves against the child's cwd, which is not ours.
    if (directory === '' || !isAbsolute(directory)) {
      continue
    }
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`)
      if (isExecutableFile(candidate, !windows)) {
        return candidate
      }
    }
  }
  return null
}
