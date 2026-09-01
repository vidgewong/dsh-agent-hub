/**
 * Loop engine settings plugin, browser half. Registers the "Loop engine"
 * page under the settings section slot once the settings shell declares it,
 * binding one store to the duplicated `agent-loop-engine` settings scope.
 * Export discipline: packages/client/AGENTS.md.
 * @module dsh-loop-engine/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls ui-conversation's SlotMap merge, which declares the
// `conversation.input.right` seat the composer picker registers at.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { LoopEngineSection } from './LoopEngineSection.tsx'
import type { LoopEngineSectionInjected } from './LoopEngineSection.tsx'
import { LoopEngineComposerSelect } from './LoopEngineComposerSelect.tsx'
import type { LoopEngineComposerSelectInjected, SessionSwitcher } from './LoopEngineComposerSelect.tsx'
import { EngineRpc, type ConnectionLike } from './engine-rpc.ts'
import { sessionLocation } from './session-location.ts'
import type { SessionListLike, WorkspaceViewLike } from './session-location.ts'
import { LoopEngineStore, decodeLoopEngine } from './store.ts'
import { en, zh, type LoopEngineKey } from './locales.ts'
import { LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL } from '../namespace.ts'
import type { LoopEngineId, LoopEngineSettings } from '../settings.ts'

export type { LoopEngineSectionInjected, LoopEngineSectionProps } from './LoopEngineSection.tsx'
export type { LoopEngineComposerSelectInjected, LoopEngineComposerSelectProps, SessionSwitcher } from './LoopEngineComposerSelect.tsx'
export type { LoopEngineState } from './store.ts'

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
    /** The Loop engine settings page copy. */
    'settings.loop-engine': LoopEngineKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.loop-engine'

/** Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply; registration depends on it through `slots.inject()`. */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Register the Loop engine section once the `settings.section` declaration is
 * on the ledger and bind its store to the duplicated settings scope.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'loop-engine: copy dictionaries')

  const scope = ctx.settingsScope.bind<LoopEngineSettings>({
    namespace: LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL,
    decode: decodeLoopEngine,
  })
  const controller = new LoopEngineStore(scope)
  ctx.effect(() => {
    controller.load()
    return () => { controller.dispose() }
  }, 'loop-engine: store lifecycle')

  const t = ctx.locale.bind(NS) as LoopEngineSectionInjected['t']
  const injected = (): LoopEngineSectionInjected => ({
    controller,
    hooks: { snapshot: controller.store },
    t,
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'loop-engine',
    order: 30,
    label: () => t('nav'),
    inject: injected,
  }, LoopEngineSection))

  // The composer's loop-engine control: registered at the tool-row seat beside
  // the model select. It names the engine the open session is *actually* on,
  // read from the node half over the plugin's own RPC channel, and switching it
  // creates a new session rather than pretending to change this one — a
  // session's engine is fixed inside `createAgent`, which the harness fires
  // eagerly at session-open.
  //
  // `connection` is injected here rather than read off the root context: a bare
  // `ctx.get` at apply time can run before the connection plugin provides the
  // service, and would then pin an undefined RPC for the life of the page. It
  // is not in the plugin-level `inject` because the settings section must still
  // mount on a profile that has no Connection.
  //
  // There is deliberately no session-header badge: the composer seat already
  // carries the per-session engine, and the settings value it would otherwise
  // read means only "the default for sessions that pick nothing".
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

    const composerInjected = (): LoopEngineComposerSelectInjected => ({
      controller,
      rpc,
      switcher,
      hooks: { snapshot: controller.store },
      t,
    })
    scope.effect(() => {
      return scope.slots.register({
        name: 'conversation.input.right',
        id: 'loop-engine',
        order: 0,
        locale: NS,
        inject: composerInjected,
      }, LoopEngineComposerSelect)
    }, 'loop-engine: composer engine select')
  })
}