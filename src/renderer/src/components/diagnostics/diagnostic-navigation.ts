/**
 * Clicking a diagnostic: open its file, focus the editor, reveal the line.
 *
 * Deliberately built on the same activation path as check-run annotations
 * (`check-annotation-open.ts`), search results and terminal links, so a jump
 * from the Problems panel lands in the same history stack and behaves
 * identically. The two-frame wait is the load-bearing part of that pattern:
 * opening can replace the active tab and mount Monaco asynchronously, so the
 * reveal has to wait for the destination editor to own layout.
 */
import { detectLanguage } from '@/lib/language-detect'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'

export type DiagnosticNavigationTarget = {
  worktreeId: string
  /** Absolute path on the execution host. */
  filePath: string
  relativePath: string
  /** 1-based, as shown in the panel. */
  line: number
  column: number
}

type FrameRef = { current: number | null }

export function openDiagnosticLocation(
  target: DiagnosticNavigationTarget,
  frames: { outer: FrameRef; inner: FrameRef }
): void {
  const store = useAppStore.getState()
  if (!findWorktreeById(store.worktreesByRepo, target.worktreeId)) {
    return
  }
  activateAndRevealWorktree(target.worktreeId, { providesInitialSurface: true })
  store.openFile(
    {
      filePath: target.filePath,
      relativePath: target.relativePath,
      worktreeId: target.worktreeId,
      language: detectLanguage(target.relativePath),
      mode: 'edit'
    },
    { focusEditor: true }
  )
  cancelDiagnosticRevealFrames(frames)
  store.setPendingEditorReveal(null)
  frames.outer.current = requestAnimationFrame(() => {
    frames.inner.current = requestAnimationFrame(() => {
      store.setPendingEditorReveal({
        filePath: target.filePath,
        line: target.line,
        column: target.column,
        matchLength: 0
      })
      cancelDiagnosticRevealFrames(frames)
    })
  })
}

export function cancelDiagnosticRevealFrames(frames: {
  outer: FrameRef
  inner: FrameRef
}): void {
  for (const frame of [frames.outer, frames.inner]) {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }
}
