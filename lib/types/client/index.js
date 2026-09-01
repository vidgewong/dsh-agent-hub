/**
 * Loop engine settings plugin, browser half. Registers the "Loop engine"
 * page under the settings section slot once the settings shell declares it,
 * binding one store to the duplicated `agent-loop-engine` settings scope.
 * Export discipline: packages/client/AGENTS.md.
 * @module dsh-loop-engine/client
 */
import { LoopEngineSection } from "./LoopEngineSection.js";
import { LoopEngineComposerSelect } from "./LoopEngineComposerSelect.js";
import { EngineRpc } from "./engine-rpc.js";
import { sessionLocation } from "./session-location.js";
import { LoopEngineStore, decodeLoopEngine } from "./store.js";
import { en, zh } from "./locales.js";
import { LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL } from "../namespace.js";
/** Dictionary namespace owned by this plugin. */
const NS = 'settings.loop-engine';
/** Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply; registration depends on it through `slots.inject()`. */
export const inject = ['slots', 'locale', 'settingsScope'];
/**
 * Register the Loop engine section once the `settings.section` declaration is
 * on the ledger and bind its store to the duplicated settings scope.
 * @param ctx - client root context.
 */
export function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'loop-engine: copy dictionaries');
    const scope = ctx.settingsScope.bind({
        namespace: LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL,
        decode: decodeLoopEngine,
    });
    const controller = new LoopEngineStore(scope);
    ctx.effect(() => {
        controller.load();
        return () => { controller.dispose(); };
    }, 'loop-engine: store lifecycle');
    const t = ctx.locale.bind(NS);
    const injected = () => ({
        controller,
        hooks: { snapshot: controller.store },
        t,
    });
    ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'loop-engine',
        order: 30,
        label: () => t('nav'),
        inject: injected,
    }, LoopEngineSection));
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
    ctx.inject(['slots', 'conversation', 'connection'], (scope) => {
        const rpc = new EngineRpc(scope.get('connection'));
        const switcher = {
            async startSessionOn(engine) {
                const sessions = scope.get('sessions');
                if (sessions === undefined)
                    return false;
                // Place the new session where the user already is. Workspace
                // membership is the one that matters, and it is not implied by the
                // directory — see `sessionLocation` for why passing `cwd` alone is what
                // made the UI ask for a workspace a second time.
                const location = sessionLocation(sessions.list.getSnapshot(), scope.get('workspaces')?.list.getSnapshot().items);
                const sessionId = crypto.randomUUID();
                // Order matters: the host resolves the reservation inside `createAgent`,
                // which runs during `create`. Reserving afterwards would be too late.
                if (!await rpc.bind(sessionId, engine))
                    return false;
                try {
                    await sessions.create({ sessionId, ...location });
                }
                catch (error) {
                    console.warn('loop-engine: could not start a session on', engine, error);
                    return false;
                }
                sessions.open(sessionId);
                return true;
            },
        };
        const composerInjected = () => ({
            controller,
            rpc,
            switcher,
            hooks: { snapshot: controller.store },
            t,
        });
        scope.effect(() => {
            return scope.slots.register({
                name: 'conversation.input.right',
                id: 'loop-engine',
                order: 0,
                locale: NS,
                inject: composerInjected,
            }, LoopEngineComposerSelect);
        }, 'loop-engine: composer engine select');
    });
}
//# sourceMappingURL=index.js.map