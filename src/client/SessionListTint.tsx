/**
 * Sidebar session-list engine tint. A headless seat, registered at the
 * root-scoped `shell.overlay` so it is always mounted, that paints each session
 * row in the left list with its engine's accent colour — so a glance down the
 * list tells the kernels of every session apart, the same way the composer
 * picker and header badge already colour-code the open one.
 *
 * ## Why this is a DOM enhancement and not a Slot
 *
 * The sidebar session list has no per-row extension point: `sidebar.workspaces`
 * is a single `shadows-shipped-ui` seat, and the rows under it
 * (`@deepseek-ai/dsh-client-ui-workspace`) expose no list Slot and carry no
 * session id in the DOM. Short of replacing the whole browsing region — and
 * re-implementing its search, grouping, drag, and menus — the only seam left is
 * to observe the rendered rows and tint them. That is what this does, staying
 * inside the "plugin only, no harness edits" constraint.
 *
 * ## How a row is mapped to a session
 *
 * Each row renders as `role="treeitem"`, a stable ARIA contract (unlike the
 * hashed CSS-module class). The session id it stands for lives only in the row
 * component's React props (`node.id`), so we read it back off the element's
 * React fiber and confirm it against the live `sessions.list` snapshot — a
 * `treeitem` whose id is not a known session (a workspace/folder header) is left
 * untinted. Fiber reading is a private React detail, so every access is guarded;
 * if it ever stops working the rows simply render with no tint.
 *
 * ## How the tint stays subordinate to selection
 *
 * The engine colour is applied through a `[data-loop-engine=…]` attribute
 * selector (specificity 0,1,0), and the stylesheet is appended last. That makes
 * it win the resting-state background on a tie with the base row rule, while the
 * shipped `.selected` and `:hover` rules (higher specificity) still override it —
 * so selecting a row looks exactly as it did before.
 *
 * @module dsh-omniloop/client/session-list-tint
 */

import { useEffect, type JSX } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { EngineRpc } from './engine-rpc.ts'
import { ENGINE_COLORS } from './engine-visuals.ts'
import { LOOP_ENGINE_IDS, type LoopEngineId } from '../namespace.ts'

/** The `sessions.list` snapshot fields the tinter reads to validate a row id. */
interface SessionListSnapshotLike {
  readonly byId: Record<string, unknown>
}

/**
 * The subset of the client sessions service this seat borrows: the observable
 * list snapshot, so a row id can be checked against real sessions and a re-tint
 * can follow list changes. `subscribe` is optional — a profile whose list is not
 * observable still gets DOM-driven updates from the MutationObserver.
 */
export interface SessionsListLike {
  readonly list: {
    getSnapshot(): SessionListSnapshotLike
    subscribe?(listener: () => void): () => void
  }
}

/** Injected dependencies of {@link SessionListTint} (slot `inject`). */
export interface SessionListTintInjected {
  /** Reads a session's true engine from the node half. */
  rpc: EngineRpc
  /** The live sessions list, used to confirm a row id names a real session. */
  sessions: SessionsListLike | undefined
}

/** Props delivered by the slot outlet (the renderer erases the share boundary). */
export type SessionListTintProps = Partial<InjectFace<SessionListTintInjected>>

/** Attribute the tinter stamps on a row, read by the injected stylesheet. */
const ENGINE_ATTR = 'data-loop-engine'

/** How much of the engine colour is mixed into the resting row background. */
const TINT_PERCENT = 16

/** Stronger mix for the selected row, so selection reads without losing engine. */
const TINT_SELECTED_PERCENT = 40

/**
 * The stylesheet that turns a stamped attribute into a background tint.
 *
 * One rule per engine, built from the shared colour map so the list agrees with
 * every other engine-coloured seat. `color-mix(... transparent)` keeps the tint
 * translucent, so it reads on both light and dark surfaces and lets the row's
 * own text and borders show through. An inset left bar adds a stronger,
 * still-subordinate accent for quick scanning.
 *
 * The shipped selected/hover rules paint the row a flat neutral grey at
 * specificity (0,2,0), which would erase the engine colour the moment a row is
 * opened. Each engine therefore also gets a
 * `[role="treeitem"][…][aria-selected="true"]` rule at a higher (0,3,0)
 * specificity that paints the *selected* row a deeper wash of its own colour
 * plus a full-height left bar. Selection stays obvious (it is markedly stronger
 * than the resting tint), and which engine a session runs never disappears on
 * click.
 */
function tintStylesheet(): string {
  return LOOP_ENGINE_IDS.flatMap((engine: LoopEngineId) => {
    const color = ENGINE_COLORS[engine]
    return [
      `[${ENGINE_ATTR}="${engine}"]{` +
      `background-color:color-mix(in srgb, ${color} ${TINT_PERCENT}%, transparent);` +
      `box-shadow:inset 2px 0 0 0 ${color};` +
      `}`,
      `[role="treeitem"][${ENGINE_ATTR}="${engine}"][aria-selected="true"]{` +
      `background-color:color-mix(in srgb, ${color} ${TINT_SELECTED_PERCENT}%, transparent);` +
      `box-shadow:inset 3px 0 0 0 ${color};` +
      `}`,
    ]
  }).join('\n')
}

/**
 * Read the session id a rendered row stands for from its React fiber.
 *
 * The row DOM carries no session id; it lives in the row component's props
 * (`node.id`). We find the element's fiber by its `__reactFiber$…` key and walk
 * up a few `return` links until a fiber whose `memoizedProps.node.id` is a
 * string — the row (or search-result) component. Every step is defensive: React
 * internals are not a public contract, so any surprise yields `undefined` and
 * the row is simply left untinted.
 *
 * @param el - a `role="treeitem"` element.
 * @returns the session id, or undefined when it cannot be read.
 */
function readSessionId(el: Element): string | undefined {
  try {
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'))
    if (key === undefined) return undefined
    let fiber = (el as unknown as Record<string, unknown>)[key] as
      | { memoizedProps?: { node?: { id?: unknown } }; return?: unknown }
      | null
      | undefined
    for (let depth = 0; fiber != null && depth < 12; depth++) {
      const id = fiber.memoizedProps?.node?.id
      if (typeof id === 'string') return id
      fiber = fiber.return as typeof fiber
    }
  } catch {
    // React internals shifted; degrade to no tint rather than throw into render.
  }
  return undefined
}

/**
 * Render the headless session-list tinter.
 *
 * Returns nothing visible: all its work is a side effect that stamps the engine
 * attribute onto sidebar rows and injects the stylesheet that colours them.
 *
 * @param props - composed slot props (`rpc`, `sessions`).
 * @returns always null.
 */
export function SessionListTint(props: SessionListTintProps): JSX.Element | null {
  const { rpc, sessions } = props as InjectFace<SessionListTintInjected>

  useEffect(() => {
    if (rpc === undefined || typeof document === 'undefined') return

    // Inject the tint stylesheet once, last in <head> so it wins resting-state
    // background ties against the shipped row rule.
    const style = document.createElement('style')
    style.setAttribute('data-loop-engine-tint', '')
    style.textContent = tintStylesheet()
    document.head.appendChild(style)

    // Resolved engines are immutable per session, so cache them forever (bounded
    // by the number of sessions the page has shown). `pending` prevents firing a
    // second resolve for an id already in flight.
    const cache = new Map<string, LoopEngineId>()
    const pending = new Set<string>()
    let disposed = false
    let frame = 0

    const validIds = (): Record<string, unknown> => {
      try {
        return sessions?.list.getSnapshot().byId ?? {}
      } catch {
        return {}
      }
    }

    const apply = (): void => {
      const byId = validIds()
      const rows = document.querySelectorAll('[role="treeitem"]')
      rows.forEach((el) => {
        const id = readSessionId(el)
        if (id === undefined || !(id in byId)) {
          if (el.hasAttribute(ENGINE_ATTR)) el.removeAttribute(ENGINE_ATTR)
          return
        }
        const known = cache.get(id)
        if (known !== undefined) {
          if (el.getAttribute(ENGINE_ATTR) !== known) el.setAttribute(ENGINE_ATTR, known)
          return
        }
        if (!pending.has(id)) {
          pending.add(id)
          void rpc.resolve(id).then((engine) => {
            pending.delete(id)
            if (disposed || engine === undefined) return
            cache.set(id, engine)
            schedule()
          })
        }
      })
    }

    // Coalesce bursts of DOM mutations (and list-change notifications) into one
    // pass per animation frame.
    const schedule = (): void => {
      if (disposed || frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        apply()
      })
    }

    // Rows are added, removed, and re-ordered as the user navigates, searches,
    // and expands groups. Observing the whole document subtree for childList
    // changes catches every case without depending on the list container's
    // hashed class name; setting our own data attribute does not retrigger it
    // (attributes are not observed).
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })

    // Also re-tint when the session list itself changes, for the rare update
    // that swaps a row's identity without a childList mutation.
    const unsubscribe = sessions?.list.subscribe?.(schedule)

    apply()

    return () => {
      disposed = true
      if (frame !== 0) cancelAnimationFrame(frame)
      observer.disconnect()
      unsubscribe?.()
      style.remove()
      document.querySelectorAll(`[${ENGINE_ATTR}]`).forEach(el => el.removeAttribute(ENGINE_ATTR))
    }
  }, [rpc, sessions])

  return null
}
