/**
 * Per-engine visual identity shared by every browser seat that names an engine:
 * the composer picker, its menu list, and the session-header badge. One engine
 * reads as one colour everywhere, so a glance is enough to tell a session's
 * kernel apart.
 *
 * Kept dependency-free (a plain colour map plus a locale-key helper) so both the
 * composer and the header badge import it without pulling either component into
 * the other's bundle graph.
 *
 * @module dsh-omniloop/client/engine-visuals
 */

import type { LoopEngineId } from '../namespace.ts'
import type { LoopEngineKey } from './locales.ts'

/**
 * The accent colour that identifies each engine. Chosen to echo each engine's
 * own brand so the association is learnable, and to stay legible as a small dot
 * on both light and dark surfaces:
 *   - DeepSeek Loop — DeepSeek blue
 *   - Claude Code — Claude terracotta/orange
 *   - Codex — OpenAI green
 *   - Pi — violet
 */
export const ENGINE_COLORS: Readonly<Record<LoopEngineId, string>> = {
  'in-process': '#4d6bfe',
  'claude-code': '#d97757',
  codex: '#10a37f',
  pi: '#a78bfa',
}

/** The accent colour for an engine, falling back to the DeepSeek Loop hue. */
export function engineColor(engine: LoopEngineId | undefined): string {
  return engine === undefined ? 'var(--dsw-alias-label-tertiary)' : ENGINE_COLORS[engine]
}

/** Locale key of one engine's display name. */
export function engineLabelKey(engine: LoopEngineId): keyof LoopEngineKey {
  switch (engine) {
    case 'claude-code': return 'engineClaudeCode'
    case 'codex': return 'engineCodex'
    case 'pi': return 'enginePi'
    default: return 'engineInProcess'
  }
}
