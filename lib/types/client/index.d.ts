/**
 * Loop engine plugin, browser half. Surfaces the per-session agent loop engine
 * in two seats — the composer picker (which switches engine by starting a new
 * session) and a static badge in the open session's header — each colour-coded
 * by engine so a session's kernel is legible at a glance. There is no settings
 * page: the engine is a per-session fact, not a global default worth a knob.
 * Export discipline: packages/client/AGENTS.md.
 * @module dsh-agent-hub/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import { type LoopEngineKey } from './locales.ts';
export type { LoopEngineComposerSelectInjected, LoopEngineComposerSelectProps, SessionSwitcher } from './LoopEngineComposerSelect.tsx';
export type { LoopEngineHeaderBadgeInjected, LoopEngineHeaderBadgeProps } from './LoopEngineHeaderBadge.tsx';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** The loop engine display copy (labels, tooltips). */
        'settings.loop-engine': LoopEngineKey;
    }
}
/** Required services (cordis fiber inject). */
export declare const inject: string[];
/**
 * Register the composer engine picker and the session-header engine badge, both
 * reading each session's true engine over the plugin's RPC channel.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map