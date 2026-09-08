/**
 * Shared loop-engine identity, namespace, and schema.
 *
 * The namespace literal lives in the zero-import `./namespace.ts` so both
 * halves agree on the section name: the node half brands it with a compile-time
 * cast, while the browser half imports the same literal without pulling the
 * host-side `dsh-settings` service into the client bundle (cross-plugin value
 * imports go through cordis services, and `settings-scope.ts` follows the same
 * discipline).
 *
 * @module dsh-omniloop/settings
 */
import z from '@deepseek-ai/schemastery';
import { LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL } from "./namespace.js";
export { LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL } from "./namespace.js";
// The engine ids live in the zero-import `./namespace.ts` and are re-exported
// here so the node half keeps one import site for everything settings-shaped.
// The browser half must import them from `./namespace.ts` directly: a value
// import of this module would pull `dsh-settings` into the client bundle.
export { LOOP_ENGINE_IDS } from "./namespace.js";
/** Schema of the loop engine settings section. */
export const LOOP_ENGINE_SETTINGS_SCHEMA = z.object({
    engine: z.union([z.const('in-process'), z.const('claude-code'), z.const('codex'), z.const('pi')]).default('in-process'),
    showInComposer: z.boolean().default(true),
});
/**
 * Brand the shared literal on the node side. The runtime `settingsNamespace()`
 * validator was removed in dsh-settings 0.1.2; the brand is compile-time-only
 * now (the documented dsh-brand policy — a plain cast inside the owning
 * package), and the provider rejects a malformed namespace at registration.
 */
export function loopEngineSettingsNamespace() {
    return LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL;
}
//# sourceMappingURL=settings.js.map