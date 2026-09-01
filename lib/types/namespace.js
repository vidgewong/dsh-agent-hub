/**
 * Loop engine constants shared by both halves, in a module with no runtime
 * imports so the browser bundle can import them without dragging
 * `dsh-settings` (a host-side service) into the client artifact.
 *
 * That constraint is load-bearing, not stylistic: the browser bundle inlines
 * non-seed specifiers (see `build.mjs`), so a value imported from
 * `./settings.ts` — which imports `dsh-settings` — pulls the whole host-side
 * settings module into the client build. Anything both halves need as a
 * *value* belongs here; `./settings.ts` re-exports it for the node half.
 * @module dsh-loop-engine/namespace
 */
/** Settings namespace carrying the deployment's selected agent loop engine. */
export const LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL = 'agent-loop-engine';
/** The installed engines driving new Agent turns. */
export const LOOP_ENGINE_IDS = ['in-process', 'claude-code', 'codex', 'pi'];
//# sourceMappingURL=namespace.js.map