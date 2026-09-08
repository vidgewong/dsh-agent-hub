/**
 * Web-switchable agent loop engine, node half.
 *
 * Hosts every agent-loop engine (the base in-process loop, Claude Code, Codex,
 * and Pi) and gives each session its own. The harness admits exactly one
 * AgentFactory, so this plugin registers a {@link LoopEngineRouter} in that slot
 * for the life of the process and mounts the four engines behind it through
 * shadowed contexts that redirect their `setFactory` calls into router
 * registration. The engine classes themselves are unmodified.
 *
 * A session's engine is fixed when it is created and recorded durably
 * ({@link EngineRecordStore}), because resuming a session on a different engine
 * would replay history that engine cannot act on — each engine writes its own
 * provenance. The `agent-loop-engine` settings section therefore selects the
 * engine for the *next new* session only; switching it never disturbs a running
 * session and needs no restart.
 *
 * The managed block in the profile's `cordis.patch.yml` is now permanent and
 * engine-independent: it disables the base bundle's `agent-loop` row so this
 * plugin owns the slot in every configuration.
 *
 * @module dsh-omniloop
 */
import { Context, type Fiber } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type Config as ClaudeCodeConfig } from './engine-claude/loop.ts';
import type { CodexApprovalPolicy, CodexSandboxMode } from './engine-codex/types.ts';
import { type LoopEngineId } from './settings.ts';
export declare const name = "loop-engine";
/**
 * Services the plugin's own fiber requires.
 *
 * `agents` and `systemPrompt` are read directly by {@link apply}: the router
 * claims the single AgentFactory slot on `ctx.agents`, and each engine mounts
 * through a context that shadows both members. Cordis refuses a bare property
 * read on an undeclared service ("cannot get property \"agents\" without
 * inject"), so both must be listed — and listing them also makes the fiber wait
 * for them rather than racing their providers.
 *
 * The optional host services (`commands`, `skills`) stay out: they are resolved
 * lazily via `ctx.get` and may legitimately be absent from a minimal profile.
 * The hosted engine factories (Claude Code, Codex, Pi) declare their own
 * `inject` when mounted as children; the base in-process loop additionally
 * requires `llm` and `tools`, which are injected through a dedicated
 * `ctx.inject` scope in {@link apply} rather than here — listing them here
 * would block the three external engines on services they never touch.
 */
export declare const inject: string[];
/** Composition entry for the loop engine selection and the hosted engine drivers. */
export interface Config extends ClaudeCodeConfig {
    /** Profile whose `cordis.patch.yml` carries the managed block; defaults to `web`. */
    profile?: string;
    /** Patch file name inside the profile; defaults to `cordis.patch.yml`. */
    patchFilename?: string;
    /** Explicit absolute path to the patch file, overriding profile + filename. */
    patchPath?: string;
    /** Pinned Codex sandbox mode; falls back to the session's dsh permission knobs. */
    sandboxMode?: CodexSandboxMode;
    /** Pinned Codex approval policy; falls back to the session's dsh permission knobs. */
    approvalPolicy?: CodexApprovalPolicy;
    /** LLM provider for the Pi RPC child (`--provider`). */
    piProvider?: string;
    /** Thinking/reasoning level for the Pi RPC child, appended to its `--model`. */
    piThinking?: string;
}
/**
 * Schema of the loop engine composition entry.
 *
 * A schemastery object validates each field only when it is present and lets
 * an absent key fall through as `undefined`, so omitted knobs are accepted —
 * matching the permissive interface and read path (`resolvePatchPath` defaults
 * the patch path; each engine driver resolves only the knobs it owns and
 * omitted deployment tunables fall back to the session). The composition entry
 * is an engine-agnostic superset: the selectable knobs belong to whichever
 * engine the settings pick at runtime, so both engines' knobs may coexist and
 * only the selected one is consumed.
 */
export declare const Config: z<Config>;
/** Resolve the managed patch file from configuration, defaulting to the web profile. */
export declare function resolvePatchPath(config: Config): string;
/** Atomically replace the patch file (same-directory temp + rename). */
export declare function writePatchFile(path: string, text: string): Promise<void>;
/**
 * Synchronously atomically replace the patch file. The engine-selection
 * onChange is a synchronous hook with no await, and the write MUST land before
 * the caller is told the switch committed — otherwise a user who restarts
 * `dsh web` immediately reads the stale file and the previous engine boots.
 * @param path - the profile's patch file.
 * @param text - the next file content.
 */
export declare function writePatchFileSync(path: string, text: string): void;
/**
 * Ensure the permanent managed block is present, preserving the rest of the
 * file byte for byte. Only writes when the file actually differs.
 * @param path - the profile's patch file.
 * @returns whether a write occurred.
 */
export declare function syncManagedBlock(path: string): Promise<boolean>;
/**
 * Mount the base in-process loop behind the router.
 *
 * The plugin now owns the AgentFactory slot in every configuration, so the base
 * loop can no longer register itself through the bundle — the managed block
 * disables its row. It is instead hosted here, through the same shadowed
 * context as the other engines, which keeps `in-process` a first-class
 * per-session choice.
 *
 * The import is dynamic and failure-tolerant: the package is a peer, and a
 * deployment that omits it should lose only the in-process engine rather than
 * failing the whole plugin tree.
 *
 * **Caller requirement**: the base loop declares `static inject = ['agents',
 * 'sessions', 'llm', 'tools', 'systemPrompt']`. The `loopCtx` must descend
 * from a context whose fiber chain carries `llm` and `tools` in its inject,
 * otherwise the Cordis property walk will throw `cannot get property "tools"
 * without inject` at runtime. {@link apply} satisfies this by wrapping the
 * call in a `ctx.inject(['llm', 'tools'], ...)` scope.
 *
 * @param ctx - the plugin context, used for diagnostics.
 * @param loopCtx - the shadowed context that redirects `setFactory` to the router.
 * @param mount - the shared fiber-start helper.
 */
export declare function mountBaseLoop(ctx: Context, loopCtx: Context, mount: (engine: LoopEngineId, plugin: () => (Fiber & PromiseLike<Fiber>)) => void): void;
/**
 * Register an engine's skill provider into ONE agent's own scope layer.
 *
 * The harness's skill registry is layered by `scopeOf(ctx)`, and every engine
 * mints its agent as its own scope key then hands that scope-tagged context to
 * `setup`. Registering through that context therefore makes the provider
 * visible to exactly one session — a codex session never sees
 * `~/.claude/skills/` — with no per-provider engine predicate, and the
 * registration unwinds with the agent's scope.
 *
 * `in-process` contributes nothing: the base loop brings the harness's own
 * skills, and this plugin adds no engine-specific ones for it.
 *
 * @param engine - the engine that owns the session being set up.
 * @param agentCtx - the scope-tagged agent context the engine passes to `setup`.
 */
export declare function registerEngineSkills(engine: LoopEngineId, agentCtx: Context): void;
/**
 * Apply the plugin: own the AgentFactory slot with the router, mount every
 * engine behind it, and track the selection for new sessions.
 * @param ctx - the composing context.
 * @param config - composition entry for the managed patch file.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map