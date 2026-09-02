/**
 * Session-header engine badge, registered at
 * `conversation.session.header.actions` with a negative order so it renders as
 * static session context immediately before the title's interactive actions.
 *
 * It names the engine the OPEN session is actually running — read from the node
 * half's durable record over the plugin's RPC channel, keyed on the framework
 * session id — and prefixes it with the engine's accent colour, so the kernel
 * driving a session is legible the moment it is opened. It is a label, not a
 * control: switching engines is the composer picker's job (a switch means a new
 * session), and duplicating that here would only invite a click that cannot
 * change a session whose agent already exists.
 *
 * When the engine cannot be read (no Connection, an unregistered channel, a
 * transport error) the badge renders nothing rather than a misleading guess —
 * unlike the composer seat, it is not the only route to anything, so silence is
 * the honest degradation.
 *
 * Styling is token-driven inline styles like the composer seat (the
 * client-module bundle is esbuild-built without a CSS loader).
 * @module dsh-agent-hub/client/header-badge
 */

import { useEffect, useState, type CSSProperties, type JSX } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { EngineRpc } from './engine-rpc.ts'
import { engineColor, engineLabelKey } from './engine-visuals.ts'
import type { LoopEngineId } from '../namespace.ts'
import type { en } from './locales.ts'

/** Injected dependencies of {@link LoopEngineHeaderBadge} (slot `inject`). */
export interface LoopEngineHeaderBadgeInjected {
  /** Reads a session's true engine from the node half. */
  rpc: EngineRpc
  /** Header copy bound to the loop engine dictionaries. */
  t: (key: keyof typeof en) => string
}

/** Props delivered by the slot outlet (the renderer erases the share boundary). */
export type LoopEngineHeaderBadgeProps = Partial<InjectFace<LoopEngineHeaderBadgeInjected>>

/**
 * The rendered face. The framework session kit spreads `sessionId` onto every
 * session-scope seat, so it arrives as a plain prop and needs no hook.
 */
type BadgeFace = InjectFace<LoopEngineHeaderBadgeInjected> & {
  sessionId?: string
}

/** The colour dot marking the engine's identity. */
const dot = (color: string): CSSProperties => ({
  boxSizing: 'border-box',
  width: 8,
  height: 8,
  borderRadius: 999,
  background: color,
  flex: 'none',
})

/** Quiet static badge: a colour dot plus the engine name, no button affordance. */
const badge: CSSProperties = {
  boxSizing: 'border-box',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '2px 8px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 999,
  color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit',
  fontSize: 12,
  lineHeight: '18px',
  whiteSpace: 'nowrap',
}

/**
 * Render the session-header engine badge.
 * @param props - composed slot props.
 * @returns the badge naming this session's engine, or null when it is unknown.
 */
export function LoopEngineHeaderBadge(props: LoopEngineHeaderBadgeProps): JSX.Element | null {
  const { rpc, t, sessionId } = props as BadgeFace

  // This session's true engine, from the node half's durable record. It stays
  // `undefined` while the answer is outstanding and when it never arrives; the
  // badge shows only a settled, known engine.
  const [engine, setEngine] = useState<LoopEngineId | undefined>(undefined)
  useEffect(() => {
    if (sessionId === undefined || rpc === undefined) {
      setEngine(undefined)
      return
    }
    const abort = new AbortController()
    // Clear first: a previous session's engine against a new session id is
    // exactly the lie the per-session resolve exists to remove.
    setEngine(undefined)
    void rpc.resolve(sessionId, abort.signal).then((resolved) => {
      if (abort.signal.aborted) return
      setEngine(resolved)
    })
    return () => { abort.abort() }
  }, [rpc, sessionId])

  if (engine === undefined || t === undefined) return null

  const notice = engine === 'claude-code' ? t('claudeModelNotice') : t('boundNotice')
  return (
    <span style={badge} title={notice}>
      <span style={dot(engineColor(engine))} />
      {t(engineLabelKey(engine))}
    </span>
  )
}
