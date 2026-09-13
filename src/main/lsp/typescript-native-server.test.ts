import { expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { findNativeTypeScriptServer } from './typescript-native-server'

it('resolves the workspace native compiler, preserves older TypeScript, and handles missing installs', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-ts-discovery-'))
  const env = { PATH: '', Path: '' }
  try {
    expect(findNativeTypeScriptServer(root, env)).toBeNull()
    const pkg = join(root, 'node_modules', 'typescript', 'package.json')
    mkdirSync(dirname(pkg), { recursive: true })
    const nativeDir = join(
      root,
      'node_modules',
      '@typescript',
      `typescript-${process.platform}-${process.arch}`
    )
    mkdirSync(join(nativeDir, 'lib'), { recursive: true })
    writeFileSync(join(nativeDir, 'package.json'), '{}')
    const executable = join(nativeDir, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc')
    writeFileSync(executable, '', { mode: 0o755 })
    writeFileSync(pkg, '{"version":"7.0.2"}')
    expect(findNativeTypeScriptServer(root, env)).toBe(executable)
    writeFileSync(pkg, '{"version":"6.0.3"}')
    expect(findNativeTypeScriptServer(root, env)).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
