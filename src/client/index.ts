/**
 * Loop engine plugin, browser half. Surfaces the per-session agent loop engine
 * in two seats — the composer picker (which switches engine by starting a new
 * session) and a static badge in the open session's header — each colour-coded
 * by engine so a session's kernel is legible at a glance. There is no settings
 * page: the engine is a per-session fact, not a global default worth a knob.
 * Export discipline: packages/client/AGENTS.md.
 * @module dsh-agent-hub/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls ui-conversation's SlotMap merge, which declares the
// `conversation.input.right` composer seat and the
// `conversation.session.header.actions` header seat this plugin registers at.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls ui-layout's SlotMap merge, which declares the frame-wide
// `shell.overlay` seat the session-list tinter mounts in.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { LoopEngineComposerSelect } from './LoopEngineComposerSelect.tsx'
import type { LoopEngineComposerSelectInjected, SessionSwitcher } from './LoopEngineComposerSelect.tsx'
import { LoopEngineHeaderBadge } from './LoopEngineHeaderBadge.tsx'
import type { LoopEngineHeaderBadgeInjected } from './LoopEngineHeaderBadge.tsx'
import { SessionListTint } from './SessionListTint.tsx'
import type { SessionListTintInjected, SessionsListLike } from './SessionListTint.tsx'
import { EngineRpc, type ConnectionLike } from './engine-rpc.ts'
import { sessionLocation } from './session-location.ts'
import type { SessionListLike, WorkspaceViewLike } from './session-location.ts'
import { en, zh, type LoopEngineKey } from './locales.ts'
import type { LoopEngineId } from '../namespace.ts'

export type { LoopEngineComposerSelectInjected, LoopEngineComposerSelectProps, SessionSwitcher } from './LoopEngineComposerSelect.tsx'
export type { LoopEngineHeaderBadgeInjected, LoopEngineHeaderBadgeProps } from './LoopEngineHeaderBadge.tsx'
export type { SessionListTintInjected, SessionListTintProps, SessionsListLike } from './SessionListTint.tsx'

/**
 * The client session service this plugin drives, declared structurally so the
 * bundle needs no value import from the session controller.
 *
 * `create` is called with an explicit `sessionId` on purpose: it is the only
 * way to know the id *before* the session exists, which is what lets the engine
 * be reserved for it. Going through `uiWorkspace.connectWorkspace` instead
 * would return the current blank session unchanged.
 *
 * `workspaceId` and `cwd` are mutually exclusive on the wire — the host rejects
 * a request carrying both with `gateway/bad-request` — and they are not
 * interchangeable: only the `workspaceId` branch runs `workspace.attachSession`.
 * A session created with a bare `cwd` therefore belongs to no workspace, which
 * is what makes the UI ask the user to pick one all over again.
 */
interface SessionsLike {
  create(opts: { workspaceId?: string; cwd?: string; sessionId?: string }): Promise<string>
  open(id: string): void
  list: { getSnapshot(): SessionListLike }
}

/**
 * The workspace snapshot this plugin reads to find the current session's
 * workspace. Membership is held by the workspace, not the session, so the
 * lookup is a scan over `items` — the same one `uiWorkspace.startSession` does.
 */
interface WorkspacesLike {
  list: { getSnapshot(): { items: readonly WorkspaceViewLike[] } }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The loop engine display copy (labels, tooltips). */
    'settings.loop-engine': LoopEngineKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.loop-engine'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale']

/**
 * Register the composer engine picker and the session-header engine badge, both
 * reading each session's true engine over the plugin's RPC channel.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'loop-engine: copy dictionaries')

  const t = ctx.locale.bind(NS) as LoopEngineComposerSelectInjected['t']

  // Both seats read the engine a session is *actually* on, from the node half
  // over the plugin's own RPC channel. A session's engine is chosen inside
  // `createAgent`, which the harness fires eagerly at session-open, so a control
  // backed by any settings value would name "the last thing picked anywhere"
  // while the session ran something else.
  //
  // `connection` is injected here rather than read off the root context: a bare
  // `ctx.get` at apply time can run before the connection plugin provides the
  // service, and would then pin an undefined RPC for the life of the page. It is
  // not in the plugin-level `inject` because both seats must still mount on a
  // profile that has no Connection (the badge hides, the picker goes read-only).
  ctx.inject(['slots', 'conversation', 'connection'], (scope: ClientContext) => {
    const rpc = new EngineRpc(scope.get('connection') as ConnectionLike | undefined)

    const switcher: SessionSwitcher = {
      async startSessionOn(engine: LoopEngineId): Promise<boolean> {
        const sessions = scope.get('sessions') as SessionsLike | undefined
        if (sessions === undefined) return false
        // Place the new session where the user already is. Workspace
        // membership is the one that matters, and it is not implied by the
        // directory — see `sessionLocation` for why passing `cwd` alone is what
        // made the UI ask for a workspace a second time.
        const location = sessionLocation(
          sessions.list.getSnapshot(),
          (scope.get('workspaces') as WorkspacesLike | undefined)?.list.getSnapshot().items,
        )
        const sessionId = crypto.randomUUID()
        // Order matters: the host resolves the reservation inside `createAgent`,
        // which runs during `create`. Reserving afterwards would be too late.
        if (!await rpc.bind(sessionId, engine)) return false
        try {
          await sessions.create({ sessionId, ...location })
        } catch (error: unknown) {
          console.warn('loop-engine: could not start a session on', engine, error)
          return false
        }
        sessions.open(sessionId)
        return true
      },
    }

    const composerInjected = (): LoopEngineComposerSelectInjected => ({ rpc, switcher, t })
    const badgeInjected = (): LoopEngineHeaderBadgeInjected => ({ rpc, t })
    const tintInjected = (): SessionListTintInjected => ({
      rpc,
      sessions: scope.get('sessions') as SessionsListLike | undefined,
    })

    scope.effect(() => scope.slots.register({
      name: 'conversation.input.right',
      id: 'loop-engine',
      order: 0,
      locale: NS,
      inject: composerInjected,
    }, LoopEngineComposerSelect), 'loop-engine: composer engine select')

    // The header badge is static session context, so it takes a negative order
    // to render before the title's interactive actions.
    scope.effect(() => scope.slots.register({
      name: 'conversation.session.header.actions',
      id: 'loop-engine',
      order: -100,
      locale: NS,
      inject: badgeInjected,
    }, LoopEngineHeaderBadge), 'loop-engine: session header engine badge')

    // A headless seat in the frame-wide overlay: always mounted, root-scoped,
    // it paints each sidebar session row with its engine's accent colour. It has
    // no visible output of its own — see SessionListTint for why the session
    // list is enhanced by observation rather than a per-row Slot (there is none).
    scope.effect(() => scope.slots.register({
      name: 'shell.overlay',
      id: 'loop-engine-tint',
      order: 0,
      inject: tintInjected,
    }, SessionListTint), 'loop-engine: session list engine tint')
  })
}
