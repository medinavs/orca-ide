import { describe, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import type { PublishedDiagnostic } from '../../../../shared/lsp/workspace-diagnostics'
import {
  applyModelMarkers,
  clearModelMarkers,
  createModelMarkerOwners,
  type MarkerWriter
} from './apply-model-markers'

function fakeModel(disposed = false): editor.ITextModel {
  return { isDisposed: () => disposed } as unknown as editor.ITextModel
}

function writer(): MarkerWriter & { calls: { owner: string; count: number }[] } {
  const calls: { owner: string; count: number }[] = []
  return {
    calls,
    setModelMarkers: (_model, owner, markers) => calls.push({ owner, count: markers.length })
  }
}

function diagnostic(serverId: string, message: string): PublishedDiagnostic {
  return {
    serverId,
    message,
    severity: 1,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }
  }
}

describe('applyModelMarkers', () => {
  it('writes markers under the owner for each server', () => {
    const sink = writer()
    applyModelMarkers(
      sink,
      fakeModel(),
      [diagnostic('gopls', 'a'), diagnostic('eslint', 'b')],
      createModelMarkerOwners()
    )
    expect(sink.calls).toEqual(
      expect.arrayContaining([
        { owner: 'orca.lsp.gopls', count: 1 },
        { owner: 'orca.lsp.eslint', count: 1 }
      ])
    )
  })

  it('clears an owner that stopped reporting', () => {
    const sink = writer()
    const owners = createModelMarkerOwners()
    const model = fakeModel()
    applyModelMarkers(sink, model, [diagnostic('gopls', 'a'), diagnostic('eslint', 'b')], owners)
    sink.calls.length = 0
    // gopls went clean; eslint still reports.
    applyModelMarkers(sink, model, [diagnostic('eslint', 'b')], owners)
    expect(sink.calls).toEqual([
      { owner: 'orca.lsp.eslint', count: 1 },
      { owner: 'orca.lsp.gopls', count: 0 }
    ])
  })

  it('clears every owner when the file becomes clean', () => {
    const sink = writer()
    const owners = createModelMarkerOwners()
    const model = fakeModel()
    applyModelMarkers(sink, model, [diagnostic('gopls', 'a')], owners)
    sink.calls.length = 0
    applyModelMarkers(sink, model, [], owners)
    // Without this explicit empty write the squiggle would stay on screen
    // after the user fixed the code — nothing arrives for a clean owner.
    expect(sink.calls).toEqual([{ owner: 'orca.lsp.gopls', count: 0 }])
  })

  it('does not re-clear an owner already cleared', () => {
    const sink = writer()
    const owners = createModelMarkerOwners()
    const model = fakeModel()
    applyModelMarkers(sink, model, [diagnostic('gopls', 'a')], owners)
    applyModelMarkers(sink, model, [], owners)
    sink.calls.length = 0
    applyModelMarkers(sink, model, [], owners)
    expect(sink.calls).toEqual([])
  })

  it('never touches markers owned by other writers', () => {
    const sink = writer()
    applyModelMarkers(sink, fakeModel(), [diagnostic('gopls', 'a')], createModelMarkerOwners())
    // Monaco's own JSON/CSS workers own their markers; a model-wide clear
    // would wipe them too.
    expect(sink.calls.every((call) => call.owner.startsWith('orca.lsp.'))).toBe(true)
  })

  it('skips a disposed model instead of throwing', () => {
    const sink = writer()
    applyModelMarkers(
      sink,
      fakeModel(true),
      [diagnostic('gopls', 'a')],
      createModelMarkerOwners()
    )
    expect(sink.calls).toEqual([])
  })

  it('tracks owners per model', () => {
    const sink = writer()
    const owners = createModelMarkerOwners()
    const first = fakeModel()
    const second = fakeModel()
    applyModelMarkers(sink, first, [diagnostic('gopls', 'a')], owners)
    applyModelMarkers(sink, second, [diagnostic('eslint', 'b')], owners)
    sink.calls.length = 0
    applyModelMarkers(sink, first, [], owners)
    // Clearing the first model must not clear the second model's owner.
    expect(sink.calls).toEqual([{ owner: 'orca.lsp.gopls', count: 0 }])
  })
})

describe('clearModelMarkers', () => {
  it('clears every owner written for the model', () => {
    const sink = writer()
    const owners = createModelMarkerOwners()
    const model = fakeModel()
    applyModelMarkers(sink, model, [diagnostic('gopls', 'a'), diagnostic('eslint', 'b')], owners)
    sink.calls.length = 0
    clearModelMarkers(sink, model, owners)
    expect(sink.calls.map((call) => call.count)).toEqual([0, 0])
  })

  it('is a no-op for a model that was never written', () => {
    const sink = writer()
    clearModelMarkers(sink, fakeModel(), createModelMarkerOwners())
    expect(sink.calls).toEqual([])
  })

  it('does not write to a disposed model', () => {
    const sink = writer()
    const owners = createModelMarkerOwners()
    const model = fakeModel()
    applyModelMarkers(sink, model, [diagnostic('gopls', 'a')], owners)
    sink.calls.length = 0
    clearModelMarkers(sink, fakeModel(true), owners)
    expect(sink.calls).toEqual([])
  })

  it('forgets the model so a later apply does not re-clear', () => {
    const sink = writer()
    const owners = createModelMarkerOwners()
    const model = fakeModel()
    applyModelMarkers(sink, model, [diagnostic('gopls', 'a')], owners)
    clearModelMarkers(sink, model, owners)
    sink.calls.length = 0
    applyModelMarkers(sink, model, [], owners)
    expect(sink.calls).toEqual([])
  })
})

describe('marker writer contract', () => {
  it('matches the shape of monaco.editor', () => {
    // Guards the duck-typed seam: if Monaco's signature changes, this fails
    // here rather than at runtime in the editor.
    const spy = vi.fn()
    const sink: MarkerWriter = { setModelMarkers: spy }
    applyModelMarkers(sink, fakeModel(), [diagnostic('gopls', 'a')], createModelMarkerOwners())
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      'orca.lsp.gopls',
      expect.arrayContaining([expect.objectContaining({ severity: 8, message: 'a' })])
    )
  })
})
