/**
 * One severity → one icon, one token, one label, for every diagnostic surface.
 *
 * Centralised so the Problems panel, the explorer badges, the summary chip and
 * any future surface cannot disagree: a file showing a red dot in the tree and
 * a yellow triangle in the panel is worse than either alone.
 *
 * Colors are token class names, never literals — diagnostics follow the active
 * theme, and the tokens are defined for light and dark in `main.css`.
 */
import { CircleAlert, CircleX, Info, Lightbulb, type LucideIcon } from 'lucide-react'
import type { DiagnosticSeverityName } from '../../../../shared/lsp/diagnostic-severity'

export type DiagnosticSeverityPresentation = {
  icon: LucideIcon
  /** Tailwind text-color utility bound to the theme token. */
  textClass: string
  /** For the explorer's small dot, where a glyph would not fit. */
  dotClass: string
  /** Untranslated fallback label; callers pass it through `translate`. */
  label: string
}

export const DIAGNOSTIC_SEVERITY_PRESENTATION: Record<
  DiagnosticSeverityName,
  DiagnosticSeverityPresentation
> = {
  error: {
    icon: CircleX,
    textClass: 'text-diagnostic-error',
    dotClass: 'bg-diagnostic-error',
    label: 'Error'
  },
  warning: {
    icon: CircleAlert,
    textClass: 'text-diagnostic-warning',
    dotClass: 'bg-diagnostic-warning',
    label: 'Warning'
  },
  information: {
    icon: Info,
    textClass: 'text-diagnostic-info',
    dotClass: 'bg-diagnostic-info',
    label: 'Information'
  },
  hint: {
    icon: Lightbulb,
    textClass: 'text-diagnostic-hint',
    dotClass: 'bg-diagnostic-hint',
    label: 'Hint'
  }
}

/** `main.go:12:5` — the position form the Problems panel and tooltips show. */
export function formatDiagnosticPosition(line: number, column: number): string {
  return `${line}:${column}`
}

/**
 * LSP positions are 0-based; every user-facing line and column is 1-based.
 * Converted in one place so no surface is ever off by one.
 */
export function toDisplayPosition(position: { line: number; character: number }): {
  line: number
  column: number
} {
  return { line: position.line + 1, column: position.character + 1 }
}
