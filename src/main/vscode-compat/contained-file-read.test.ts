import { describe, expect, it } from 'vitest'
import { join, resolve, sep } from 'node:path'
import { resolveContainedPath } from './contained-file-read'

/**
 * The containment decision, tested against an injected symlink resolver.
 *
 * The reader's on-disk tests cover the ordinary cases, but the case that
 * actually matters — a symlink inside the extension pointing outside it —
 * cannot be set up on unprivileged Windows, where `symlink` fails with EPERM.
 * Injecting `realpath` makes the decision testable on every platform, which is
 * the point: this is the check that stands between an untrusted extension and
 * the user's home directory.
 */

const ROOT = resolve('/ext')
// The runtime's own separator: `resolve` and `join` below use it, so a
// hard-coded '/' would disagree with them on Windows.
const HOST = { separator: sep }
const OUTSIDE = resolve('/outside/secret')
const SIBLING = `${ROOT}-evil${sep}x.json`

function withLinks(links: Record<string, string>): { realpath: (path: string) => string } {
  return {
    realpath: (path: string) => {
      const mapped = links[path]
      if (mapped === undefined) {
        return path
      }
      if (mapped === '__missing__') {
        throw new Error('ENOENT')
      }
      return mapped
    }
  }
}

describe('resolveContainedPath', () => {
  it('accepts a path that really resolves inside the root', () => {
    const result = resolveContainedPath(ROOT, 'themes/dark.json', {
      ...HOST,
      ...withLinks({})
    })
    expect(result.ok).toBe(true)
  })

  it('refuses a symlink resolving outside the root', () => {
    const target = resolve(ROOT, 'link.json')
    const result = resolveContainedPath(ROOT, 'link.json', {
      ...HOST,
      ...withLinks({ [target]: OUTSIDE })
    })
    expect(result).toEqual({ ok: false, error: 'path escapes the extension directory' })
  })

  it('refuses a symlink resolving into a sibling with a shared prefix', () => {
    // `/ext-evil` starts with `/ext`, so a prefix check without the separator
    // would call this contained.
    const target = resolve(ROOT, 'link.json')
    const result = resolveContainedPath(ROOT, 'link.json', {
      ...HOST,
      ...withLinks({ [target]: SIBLING })
    })
    expect(result.ok).toBe(false)
  })

  it('accepts a symlink that resolves back inside the root', () => {
    const target = resolve(ROOT, 'link.json')
    const result = resolveContainedPath(ROOT, 'link.json', {
      ...HOST,
      ...withLinks({ [target]: join(ROOT, 'themes', 'real.json') })
    })
    expect(result).toEqual({ ok: true, realPath: join(ROOT, 'themes', 'real.json') })
  })

  it('accepts the root itself', () => {
    const result = resolveContainedPath(ROOT, '.', { ...HOST, ...withLinks({}) })
    expect(result.ok).toBe(true)
  })

  it('follows a symlinked root without rejecting everything under it', () => {
    // A root that is itself a symlink is normal (a versioned install dir);
    // comparing the real target against the unresolved root would reject all.
    const result = resolveContainedPath(ROOT, 'a.json', {
      ...HOST,
      ...withLinks({
        [ROOT]: resolve('/real/ext'),
        [resolve(ROOT, 'a.json')]: join(resolve('/real/ext'), 'a.json')
      })
    })
    expect(result).toEqual({ ok: true, realPath: join(resolve('/real/ext'), 'a.json') })
  })

  it('refuses a traversal path even before symlinks', () => {
    expect(resolveContainedPath(ROOT, '../outside/secret', { ...HOST, ...withLinks({}) }).ok).toBe(
      false
    )
  })

  it('refuses an absolute path outright', () => {
    expect(resolveContainedPath(ROOT, resolve('/etc/passwd'), HOST)).toEqual({
      ok: false,
      error: 'path must be relative to the extension directory'
    })
  })

  it('reports a missing file when realpath throws', () => {
    const target = resolve(ROOT, 'gone.json')
    expect(
      resolveContainedPath(ROOT, 'gone.json', {
        ...HOST,
        ...withLinks({ [target]: '__missing__' })
      })
    ).toEqual({ ok: false, error: 'file not found' })
  })

  it('refuses when the root itself cannot be resolved', () => {
    expect(
      resolveContainedPath(ROOT, 'a.json', { ...HOST, ...withLinks({ [ROOT]: '__missing__' }) })
    ).toEqual({ ok: false, error: 'file not found' })
  })

  it('applies the same rule with Windows separators', () => {
    const windowsRoot = 'C:\\ext'
    const result = resolveContainedPath(windowsRoot, 'link.json', {
      separator: '\\',
      realpath: (path) =>
        path.endsWith('link.json') ? 'C:\\Users\\me\\.ssh\\id_rsa' : windowsRoot
    })
    expect(result.ok).toBe(false)
  })
})
