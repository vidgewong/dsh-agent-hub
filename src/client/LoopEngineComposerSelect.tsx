/**
 * Composer loop-engine control, registered at the `conversation.input.right`
 * seat so it sits immediately left of the model select in the composer's tool
 * row.
 *
 * It shows **this session's actual engine**, read from the node half over the
 * plugin's own RPC channel. That distinction is the whole point of this
 * component. A session's engine is chosen inside `createAgent`, which the
 * harness fires eagerly when a session is *opened* — before a user can click
 * anything — so a control backed by the settings value would name "the last
 * thing picked anywhere" while the session ran something else. That was a real,
 * reported defect: the composer read "In-process engine" while Claude Code
 * answered.
 *
 * The seat never hides itself over a failed read. When the engine cannot be
 * resolved it says so and stays clickable: the picker is the only route to
 * another engine, so removing it would strand the user with no control and no
 * explanation — which is precisely how this looked when the channel silently
 * failed to register.
 *
 * Because the engine is fixed before the control is reachable, picking a
 * different one cannot change this session. It instead **creates a new one**:
 * the seat mints a session id, reserves the engine for it over the channel, and
 * asks the host to create exactly that id — bypassing `connectWorkspace`, which
 * would hand back the current blank session and defeat the purpose. The
 * abandoned blank session is left alone; discarding a session is the user's
 * call, not the picker's.
 *
 * Styling is token-driven inline styles like the section (the client-module
 * bundle is esbuild-built without a CSS loader).
 * @module dsh-agent-hub/client/composer
 */

import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react'
import {
  IconChevronDownOutline14,
  Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { EngineRpc } from './engine-rpc.ts'
import { engineColor, engineLabelKey } from './engine-visuals.ts'
import type { LoopEngineId } from '../namespace.ts'
import type { en } from './locales.ts'

/** Creates a session on a caller-chosen id and brings it to the foreground. */
export interface SessionSwitcher {
  /**
   * Create a session carrying a specific engine, and open it.
   * @param engine - engine the new session must run on.
   * @returns whether a new session was created and opened.
   */
  startSessionOn(engine: LoopEngineId): Promise<boolean>
}

/** Injected dependencies of {@link LoopEngineComposerSelect} (slot `inject`). */
export interface LoopEngineComposerSelectInjected {
  /** Reads a session's true engine from the node half. */
  rpc: EngineRpc
  /** Creates and opens a session bound to a chosen engine. */
  switcher: SessionSwitcher
  /** Composer copy bound to the loop engine dictionaries. */
  t: (key: keyof typeof en) => string
}

/** Props delivered by the slot outlet (the renderer erases the share boundary). */
export type LoopEngineComposerSelectProps = Partial<InjectFace<LoopEngineComposerSelectInjected>>

/**
 * The slice of the owner's `InputZone.session` this seat reads. `sessionId`
 * identifies the session whose engine to resolve; the seat has no other route
 * to it.
 */
interface SessionFacts {
  readonly sessionId: string
}

/**
 * The rendered face. The renderer spreads the owner's props (`session`, from
 * `InputZone`) over the injected ones, so the session snapshot arrives as a
 * plain prop and needs no hook.
 */
type ComposerFace = InjectFace<LoopEngineComposerSelectInjected> & {
  session?: SessionFacts
}

const ENGINE_OPTIONS: readonly { value: LoopEngineId; key: keyof typeof en }[] = [
  { value: 'in-process', key: 'engineInProcess' },
  { value: 'claude-code', key: 'engineClaudeCode' },
  { value: 'codex', key: 'engineCodex' },
  { value: 'pi', key: 'enginePi' },
]

/** The colour dot marking an engine's identity in the trigger and menu list. */
const dot = (color: string): CSSProperties => ({
  boxSizing: 'border-box',
  width: 8,
  height: 8,
  borderRadius: 999,
  background: color,
  flex: 'none',
  display: 'inline-block',
})

/** Compact quiet trigger, one row tall like the model pill. */
const trigger: CSSProperties = {
  appearance: 'none',
  boxSizing: 'border-box',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 8px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 12,
  lineHeight: '20px',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}

const triggerBusy: CSSProperties = { ...trigger, opacity: 0.5, cursor: 'default' }

/**
 * The read-only seat, used when no Connection is available to switch through.
 * No border or button affordance — it must not invite a click that cannot do
 * anything.
 */
const frozen: CSSProperties = {
  boxSizing: 'border-box',
  display: 'inline-flex',
  alignItems: 'center',
  padding: '4px 8px',
  color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit',
  fontSize: 12,
  lineHeight: '20px',
  whiteSpace: 'nowrap',
}

/**
 * Render the composer's loop-engine seat.
 * @param props - composed slot props.
 * @returns the control naming this session's engine, or null when the settings
 *   toggle hides it.
 */
export function LoopEngineComposerSelect(props: LoopEngineComposerSelectProps): JSX.Element | null {
  const { rpc, switcher, session, t } = props as ComposerFace
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  // This session's true engine, from the node half's durable record. It stays
  // `undefined` while the answer is outstanding and when it never arrives (an
  // absent Connection, a channel that failed to register, a transport error);
  // `resolving` separates those two so the seat can say which one it is.
  const [engine, setEngine] = useState<LoopEngineId | undefined>(undefined)
  const [resolving, setResolving] = useState(false)
  const sessionId = session?.sessionId
  useEffect(() => {
    if (sessionId === undefined) {
      setEngine(undefined)
      setResolving(false)
      return
    }
    const abort = new AbortController()
    // Clear first: showing the previous session's engine against a new session
    // id is exactly the lie this component exists to remove.
    setEngine(undefined)
    setResolving(true)
    void rpc.resolve(sessionId, abort.signal).then((resolved) => {
      if (abort.signal.aborted) return
      setEngine(resolved)
      setResolving(false)
    })
    return () => { abort.abort() }
  }, [rpc, sessionId])

  // The picker is always available on the chat page now — the engine is a
  // per-session fact worth surfacing, and an unknown engine must NOT hide the
  // control: it is how a user reaches another engine at all, and removing it on
  // a failed read leaves them with no way to switch and no sign anything went
  // wrong.

  // Three display states: the resolved engine, "still reading", and "could not
  // read". The last two keep the picker live — creating a session on a chosen
  // engine does not depend on knowing the current one.
  const label = engine !== undefined
    ? t(engineLabelKey(engine))
    : t(resolving ? 'engineResolving' : 'engineUnknown')
  const notice = engine === 'claude-code'
    ? t('claudeModelNotice')
    : engine === undefined && !resolving
      ? t('engineUnknownNotice')
      : t('switchCreatesSession')

  // Without a Connection there is no way to reserve an engine for a new
  // session, so the seat reports the current one and stops there.
  if (!rpc.available) {
    return (
      <span style={frozen} title={t('boundNotice')}>
        {engine !== undefined && <span style={dot(engineColor(engine))} />}
        {label}
      </span>
    )
  }

  // Picking cannot change this session — its agent already exists — so it
  // creates a new session on the chosen engine and switches to it.
  const onSelect = (next: string): void => {
    setOpen(false)
    const value = next as LoopEngineId
    if (value === engine || busy) return
    setBusy(true)
    void switcher.startSessionOn(value).finally(() => { setBusy(false) })
  }

  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={ENGINE_OPTIONS.map(option => ({
        id: option.value,
        label: (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span style={dot(engineColor(option.value))} />
            {t(option.key)}
          </span>
        ),
      }))}
      selectedId={engine}
      onSelect={onSelect}
      align="start"
      portal
      getAnchorRect={() => triggerRef.current?.getBoundingClientRect() ?? null}
      anchor={(
        <button
          type="button"
          ref={triggerRef}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={busy}
          style={busy ? triggerBusy : trigger}
          title={notice}
          onClick={() => { setOpen(!open) }}
        >
          {engine !== undefined && <span style={dot(engineColor(engine))} />}
          {label}
          <IconChevronDownOutline14 size={14} />
        </button>
      )}
    />
  )
}
