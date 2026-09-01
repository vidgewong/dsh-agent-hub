/**
 * Loop engine settings section component: one dropdown choosing the **default**
 * agent loop engine, backed by the duplicated settings scope through the inject
 * face.
 *
 * This is deliberately not a switch for "the current engine". A session's
 * engine is fixed inside `createAgent`, which the harness fires eagerly when a
 * session is opened, so nothing set here can reach a session that already
 * exists. It applies to sessions created later that do not reserve an engine of
 * their own — the composer seat is where a session's engine is chosen. That
 * split mirrors the harness's own `agentPreset`: a per-session control, plus a
 * settings entry that only sets the default.
 *
 * Picking commits immediately; there is no confirmation dialog and no
 * `location.reload()`, because every engine is resident behind one router.
 *
 * Styling is token-driven like the rest of the settings shell (`--dsw-*`
 * aliases), with the picker rendered through the shared `Menu` primitive. The
 * client-module bundle is esbuild-built without a CSS loader, so the section
 * shell uses token-based inline styles instead of a CSS module.
 * @module dsh-loop-engine/client
 */
import { type JSX } from 'react';
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots';
import type { LoopEngineStore, LoopEngineState } from './store.ts';
import type { en } from './locales.ts';
/** Injected dependencies of {@link LoopEngineSection} (slot `inject`). */
export interface LoopEngineSectionInjected {
    /** The selection store (loaded on mount, refreshed by scope pushes). */
    controller: LoopEngineStore;
    hooks: {
        /** Section snapshot bound by the UI renderer as useSnapshot. */
        snapshot: SnapshotStore<LoopEngineState>;
    };
    /** Section copy. */
    t: (key: keyof typeof en) => string;
}
/** Props delivered by the slot outlet (the renderer erases the share boundary). */
export type LoopEngineSectionProps = Partial<InjectFace<LoopEngineSectionInjected>>;
/** Render the engine dropdown plus the binding notice and the composer toggle. */
export declare function LoopEngineSection(props: LoopEngineSectionProps): JSX.Element;
//# sourceMappingURL=LoopEngineSection.d.ts.map