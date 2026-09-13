import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findExecutableOnPath } from './language-server-executable'

const WINDOWS = process.platform === 'win32'
// The cases below exercise the resolver for the platform the test runs on, so
// the filesystem it probes is real. A bare name is not executable on Windows.
const PLATFORM = process.platform
const SEPARATOR = WINDOWS ? ';' : ':'
const SUFFIX = WINDOWS ? '.cmd' : ''
const ENV_EXTRA = WINDOWS ? { PATHEXT: '.COM;.EXE;.CMD' } : {}

let root: string
let binDir: string
let otherDir: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-lsp-which-'))
  binDir = join(root, 'bin')
  otherDir = join(root, 'other')
  mkdirSync(binDir)
  mkdirSync(otherDir)
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

/** Writes an executable named for the host platform; returns its full path. */
function writeProgram(directory: string, baseName: string): string {
  const target = join(directory, `${baseName}${SUFFIX}`)
  writeFileSync(target, '#!/bin/sh\n')
  if (!WINDOWS) {
    chmodSync(target, 0o755)
  }
  return target
}

describe('findExecutableOnPath', () => {
  it('finds a program on PATH', () => {
    const target = writeProgram(binDir, 'gopls-found')
    expect(
      findExecutableOnPath('gopls-found', { env: { PATH: binDir, ...ENV_EXTRA }, platform: PLATFORM })
    ).toBe(target)
  })

  it('returns null when the program is absent', () => {
    expect(
      findExecutableOnPath('nope-nothing', { env: { PATH: binDir, ...ENV_EXTRA }, platform: PLATFORM })
    ).toBeNull()
  })

  it('returns null for an empty PATH instead of throwing', () => {
    expect(findExecutableOnPath('gopls', { env: {}, platform: PLATFORM })).toBeNull()
  })

  it('walks PATH in order', () => {
    writeProgram(binDir, 'dup')
    const expected = writeProgram(otherDir, 'dup')
    const env = { PATH: [otherDir, binDir].join(SEPARATOR), ...ENV_EXTRA }
    expect(findExecutableOnPath('dup', { env, platform: PLATFORM })).toBe(expected)
  })

  it('skips a relative PATH entry, which resolves against the child cwd', () => {
    const expected = writeProgram(binDir, 'relative-probe')
    const env = { PATH: ['./nope', binDir].join(SEPARATOR), ...ENV_EXTRA }
    expect(findExecutableOnPath('relative-probe', { env, platform: PLATFORM })).toBe(expected)
  })

  it('honours an explicit path and reports a missing one', () => {
    const explicit = writeProgram(binDir, 'explicit')
    expect(findExecutableOnPath(explicit, { env: {}, platform: PLATFORM })).toBe(explicit)
    expect(findExecutableOnPath(join(binDir, 'absent'), { env: {}, platform: PLATFORM })).toBeNull()
  })

  it('does not mistake a directory for a program', () => {
    mkdirSync(join(binDir, `a-directory${SUFFIX}`), { recursive: true })
    expect(
      findExecutableOnPath('a-directory', { env: { PATH: binDir, ...ENV_EXTRA }, platform: PLATFORM })
    ).toBeNull()
  })

  it('uses the target platform separator, not the runtime one', () => {
    // A POSIX target must split on ':' even when this test runs on Windows.
    const resolved = findExecutableOnPath('anything', {
      env: { PATH: '/usr/bin;/usr/local/bin' },
      platform: 'linux'
    })
    // The semicolon form is one (nonexistent) entry on POSIX, never two.
    expect(resolved).toBeNull()
  })
})

describe('findExecutableOnPath on Windows', () => {
  it.runIf(WINDOWS)('returns the .cmd npm shim as-is for spawnProcess to handle', () => {
    writeProgram(binDir, 'tsls')
    expect(
      findExecutableOnPath('tsls', { env: { Path: binDir, PATHEXT: '.COM;.EXE;.CMD' }, platform: 'win32' })
    ).toBe(join(binDir, 'tsls.cmd'))
  })

  it.runIf(WINDOWS)('prefers an earlier PATHEXT spelling in the same directory', () => {
    writeFileSync(join(binDir, 'both.cmd'), '')
    writeFileSync(join(binDir, 'both.exe'), '')
    expect(
      findExecutableOnPath('both', { env: { Path: binDir, PATHEXT: '.EXE;.CMD' }, platform: 'win32' })
    ).toBe(join(binDir, 'both.exe'))
  })

  it.runIf(WINDOWS)('reads PATH as well as Path', () => {
    writeFileSync(join(binDir, 'casing.exe'), '')
    expect(
      findExecutableOnPath('casing', { env: { PATH: binDir, PATHEXT: '.EXE' }, platform: 'win32' })
    ).toBe(join(binDir, 'casing.exe'))
  })

  it.runIf(WINDOWS)('lowercases the PATHEXT spelling it returns', () => {
    writeFileSync(join(binDir, 'shouty.exe'), '')
    expect(
      findExecutableOnPath('shouty', { env: { Path: binDir, PATHEXT: '.EXE' }, platform: 'win32' })
    ).not.toMatch(/\.EXE$/)
  })
})
