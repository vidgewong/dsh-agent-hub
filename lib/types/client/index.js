/**
 * Loop engine plugin, browser half. Surfaces the per-session agent loop engine
 * in two seats — the composer picker (which switches engine by starting a new
 * session) and a static badge in the open session's header — each colour-coded
 * by engine so a session's kernel is legible at a glance. There is no settings
 * page: the engine is a per-session fact, not a global default worth a knob.
 * Export discipline: packages/client/AGENTS.md.
 * @module dsh-omniloop/client
 */
import { LoopEngineComposerSelect } from "./LoopEngineComposerSelect.js";
import { LoopEngineHeaderBadge } from "./LoopEngineHeaderBadge.js";
import { SessionListTint } from "./SessionListTint.js";
import { EngineRpc } from "./engine-rpc.js";
import { sessionLocation } from "./session-location.js";
import { en, zh } from "./locales.js";
/** Dictionary namespace owned by this plugin. */
const NS = 'settings.loop-engine';
/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale'];
/**
 * Register the composer engine picker and the session-header engine badge, both
 * reading each session's true engine over the plugin's RPC channel.
 * @param ctx - client root context.
 */
export function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'loop-engine: copy dictionaries');
    const t = ctx.locale.bind(NS);
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
        const composerInjected = () => ({ rpc, switcher, t });
        const badgeInjected = () => ({ rpc, t });
        const tintInjected = () => ({
            rpc,
            sessions: scope.get('sessions'),
        });
        scope.effect(() => scope.slots.register({
            name: 'conversation.input.right',
            id: 'loop-engine',
            order: 0,
            locale: NS,
            inject: composerInjected,
        }, LoopEngineComposerSelect), 'loop-engine: composer engine select');
        // The header badge is static session context, so it takes a negative order
        // to render before the title's interactive actions.
        scope.effect(() => scope.slots.register({
            name: 'conversation.session.header.actions',
            id: 'loop-engine',
            order: -100,
            locale: NS,
            inject: badgeInjected,
        }, LoopEngineHeaderBadge), 'loop-engine: session header engine badge');
        // A headless seat in the frame-wide overlay: always mounted, root-scoped,
        // it paints each sidebar session row with its engine's accent colour. It has
        // no visible output of its own — see SessionListTint for why the session
        // list is enhanced by observation rather than a per-row Slot (there is none).
        scope.effect(() => scope.slots.register({
            name: 'shell.overlay',
            id: 'loop-engine-tint',
            order: 0,
            inject: tintInjected,
        }, SessionListTint), 'loop-engine: session list engine tint');
    });
}
//# sourceMappingURL=index.js.map