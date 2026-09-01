/**
 * Package-owned invariant companion for the managed patch block.
 *
 * The plugin's owned relationship is that the managed block is a permanent
 * fixed point: applying it is idempotent, it always yields the row that frees
 * the AgentFactory slot for this plugin's router, and it upgrades a legacy
 * engine-tagged block from the era when the block encoded the selection. The
 * companion asserts these against the pure transform.
 *
 * @module dsh-loop-engine/invariant
 */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis companion plugin name. */
export declare const name = "loop-engine-invariant";
/** Services required before the companion can register. */
export declare const inject: string[];
/**
 * Register the loop-engine invariant contribution.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map