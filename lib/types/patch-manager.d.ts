/**
 * Managed-block editing for a profile's `cordis.patch.yml`.
 *
 * The plugin owns one contiguous block inside the user's patch file, delimited
 * by a begin/end marker pair, and rewrites only that span — everything else the
 * user wrote (other patches, their comments) survives byte for byte. The
 * block's content is the loader patch that takes the loop engine over: it
 * disables the base bundle's `agent-loop` row so this plugin's factory can
 * register without colliding, because the harness admits exactly one
 * AgentFactory:
 *
 *   # -- dsh-loop-engine managed block --
 *   - id: agent-loop
 *     disabled: true
 *   # -- /dsh-loop-engine managed block --
 *
 * The block is now PERMANENT and engine-independent. Under per-session routing
 * this plugin always owns the slot — it registers a router that dispatches to
 * whichever engine a session belongs to, and it hosts the base in-process loop
 * itself as one of those engines. The block therefore no longer carries an
 * engine name and no longer changes when the user picks a different engine;
 * that choice is now runtime state, not boot state.
 *
 * All functions here are pure string transforms — file I/O and durability live
 * in the plugin's apply.
 *
 * @module dsh-agent-hub/patch-manager
 */
/**
 * Begin marker of the plugin-managed span inside a profile patch file.
 *
 * Deliberately still spelled `dsh-loop-engine` after the package was renamed to
 * `dsh-agent-hub`: this string is not a brand, it is the key by which the
 * plugin recognizes a block it already wrote into the *user's* file. Renaming
 * it would make every existing install fail to find its own span and append a
 * second one, leaving two `agent-loop: disabled` rows in the patch list.
 */
export declare const MANAGED_BLOCK_BEGIN = "# -- dsh-loop-engine managed block";
/** End marker of the plugin-managed span inside a profile patch file. */
export declare const MANAGED_BLOCK_END = "# -- /dsh-loop-engine managed block --";
/**
 * Render the permanent managed block. The plugin always owns the AgentFactory
 * slot, so the base `agent-loop` row is always disabled.
 */
export declare function renderManagedBlock(): string;
/** Whether a patch-file text contains the managed block span. */
export declare function hasManagedBlock(text: string): boolean;
/**
 * Ensure the permanent managed block is present, preserving every byte outside
 * the managed span. Appends the span when absent; rewrites it in place when
 * present, which also upgrades a legacy engine-tagged marker from the era when
 * the block encoded the selected engine.
 *
 * This is a belt-and-braces layer, not the mechanism that disables the base
 * loop. Disabling `agent-loop` is a boot-time fact and only the bundle patch can
 * state it: the loader applies bundle layers while expanding entries, whereas
 * this profile layer is applied afterwards and this very write happens inside
 * apply() — by which point `AgentLoop`'s constructor has already claimed the
 * sole AgentFactory slot. The row therefore lives in this package's own
 * `cordis.patch.yml`, and what lands here merely re-disables an already-disabled
 * row, which is idempotent. It is kept so a profile that pins an older bundle,
 * or that lists `agent-loop` itself, still boots.
 *
 * The file must always parse as a top-level YAML *array*: app-boot's
 * `parsePatchList` throws `must be a top-level YAML array of loader patch
 * entries` on anything else, which fails the whole plugin tree — including this
 * plugin's own `insert` row, so no agent factory registers at all.
 *
 * A fresh profile's file is `[]`, a complete flow-style document. Block
 * sequence items cannot follow it, so the `[]` is dropped when the block goes
 * in. The reverse direction no longer exists: the block is permanent, so it is
 * never removed and can never leave a comments-only file behind.
 *
 * @param text - current patch-file text.
 * @returns the rewritten patch-file text.
 */
export declare function applyManagedBlock(text: string): string;
//# sourceMappingURL=patch-manager.d.ts.map