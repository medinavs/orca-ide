import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { findExecutableOnPath } from './language-server-executable'
import { resolveWindowsCmdShim } from '../../shared/child-process/windows-cmd-shim-resolution'

/** TypeScript 7 ships its own LSP instead of the tsserver.js used by older wrappers. */
export function findNativeTypeScriptServer(
  rootPath: string,
  env: NodeJS.ProcessEnv
): string | null {
  const anchors = [join(rootPath, 'package.json')]
  const tsc = findExecutableOnPath('tsc', { env })
  if (tsc) {
    const script =
      process.platform === 'win32' ? resolveWindowsCmdShim(tsc, env)?.prefixArgs[0] : tsc
    if (script) {
      try {
        anchors.push(realpathSync(script))
      } catch {
        /* compiler was removed during discovery */
      }
    }
  }
  for (const anchor of anchors) {
    try {
      const packagePath = createRequire(anchor).resolve('typescript/package.json')
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: string }
      // A workspace's older TypeScript must keep using the tsserver wrapper.
      if (!pkg.version || Number(pkg.version.split('.')[0]) < 7) {
        return null
      }
      const nativePackage = createRequire(packagePath).resolve(
        `@typescript/typescript-${process.platform}-${process.arch}/package.json`
      )
      return findExecutableOnPath(
        join(dirname(nativePackage), 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc'),
        { env }
      )
    } catch {
      // No workspace installation: try the compiler the user's PATH exposes.
    }
  }
  return null
}
