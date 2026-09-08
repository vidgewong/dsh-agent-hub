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
 * @module dsh-omniloop/client/composer
 */
import { type JSX } from 'react';
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots';
import type { EngineRpc } from './engine-rpc.ts';
import type { LoopEngineId } from '../namespace.ts';
import type { en } from './locales.ts';
/** Creates a session on a caller-chosen id and brings it to the foreground. */
export interface SessionSwitcher {
    /**
     * Create a session carrying a specific engine, and open it.
     * @param engine - engine the new session must run on.
     * @returns whether a new session was created and opened.
     */
    startSessionOn(engine: LoopEngineId): Promise<boolean>;
}
/** Injected dependencies of {@link LoopEngineComposerSelect} (slot `inject`). */
export interface LoopEngineComposerSelectInjected {
    /** Reads a session's true engine from the node half. */
    rpc: EngineRpc;
    /** Creates and opens a session bound to a chosen engine. */
    switcher: SessionSwitcher;
    /** Composer copy bound to the loop engine dictionaries. */
    t: (key: keyof typeof en) => string;
}
/** Props delivered by the slot outlet (the renderer erases the share boundary). */
export type LoopEngineComposerSelectProps = Partial<InjectFace<LoopEngineComposerSelectInjected>>;
/**
 * Render the composer's loop-engine seat.
 * @param props - composed slot props.
 * @returns the control naming this session's engine, or null when the settings
 *   toggle hides it.
 */
export declare function LoopEngineComposerSelect(props: LoopEngineComposerSelectProps): JSX.Element | null;
//# sourceMappingURL=LoopEngineComposerSelect.d.ts.map