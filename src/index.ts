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

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { ClaudeCodeLoop, CLAUDE_CODE_BACKENDS, CLAUDE_CODE_PERMISSION_MODES, type Config as ClaudeCodeConfig } from './engine-claude/loop.ts'
import { CodexLoop, CODEX_APPROVAL_POLICIES, CODEX_SANDBOX_MODES, type Config as CodexConfig } from './engine-codex/loop.ts'
import { PiLoop, type Config as PiConfig } from './engine-pi/loop.ts'
import type { CodexApprovalPolicy, CodexSandboxMode } from './engine-codex/types.ts'
import { applyManagedBlock } from './patch-manager.ts'
import {
  loopEngineSettingsNamespace,
  LOOP_ENGINE_SETTINGS_SCHEMA,
  type LoopEngineId,
  type LoopEngineSettings,
} from './settings.ts'
import { LoopEngineRouter, shadowSystemPrompt } from './router.ts'
import { EngineRecordStore, type RecordPersistence } from './engine-record.ts'
import { installEngineRpc, type ConnectionLike } from './rpc.ts'
import { CLAUDE_CODE_COMMANDS, discoverUserSlashCommands, type CommandDefinition } from './commands.ts'
import { ClaudeCodeSkillProvider, type SkillProvider, type SkillProviderControl } from './skills.ts'
import { CodexSkillProvider } from './engine-codex/skills.ts'
import { PiSkillProvider } from './engine-pi/skills.ts'


export const name = 'loop-engine'

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
export const inject = ['agents', 'systemPrompt']

/** Composition entry for the loop engine selection and the hosted engine drivers. */
export interface Config extends ClaudeCodeConfig {
  /** Profile whose `cordis.patch.yml` carries the managed block; defaults to `web`. */
  profile?: string
  /** Patch file name inside the profile; defaults to `cordis.patch.yml`. */
  patchFilename?: string
  /** Explicit absolute path to the patch file, overriding profile + filename. */
  patchPath?: string
  /** Pinned Codex sandbox mode; falls back to the session's dsh permission knobs. */
  sandboxMode?: CodexSandboxMode
  /** Pinned Codex approval policy; falls back to the session's dsh permission knobs. */
  approvalPolicy?: CodexApprovalPolicy
  /** LLM provider for the Pi RPC child (`--provider`). */
  piProvider?: string
  /** Thinking/reasoning level for the Pi RPC child, appended to its `--model`. */
  piThinking?: string
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
export const Config: z<Config> = z.object({
  profile: z.string(),
  patchFilename: z.string(),
  patchPath: z.string(),
  permissionMode: z.union(CLAUDE_CODE_PERMISSION_MODES.map(mode => z.const(mode))),
  env: z.dict(z.string()),
  model: z.string(),
  backend: z.union(CLAUDE_CODE_BACKENDS.map(id => z.const(id))),
  disposeGraceMs: z.number(),
  maxTurns: z.number(),
  sandboxMode: z.union(CODEX_SANDBOX_MODES.map(mode => z.const(mode))),
  approvalPolicy: z.union(CODEX_APPROVAL_POLICIES.map(policy => z.const(policy))),
  piProvider: z.string(),
  piThinking: z.string(),
})

/** Resolve the managed patch file from configuration, defaulting to the web profile. */
export function resolvePatchPath(config: Config): string {
  if (config.patchPath !== undefined && config.patchPath !== '') return config.patchPath
  return join(
    resolveDshHome(),
    'profiles',
    config.profile ?? 'web',
    config.patchFilename ?? 'cordis.patch.yml',
  )
}

/** Whether a promise rejection was an ENOENT (file not found). */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Read the patch file, or `undefined` when it does not exist yet. */
async function readPatchOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/** Atomically replace the patch file (same-directory temp + rename). */
export async function writePatchFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${randomUUID()}`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

/**
 * Synchronously atomically replace the patch file. The engine-selection
 * onChange is a synchronous hook with no await, and the write MUST land before
 * the caller is told the switch committed — otherwise a user who restarts
 * `dsh web` immediately reads the stale file and the previous engine boots.
 * @param path - the profile's patch file.
 * @param text - the next file content.
 */
export function writePatchFileSync(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${randomUUID()}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

/**
 * Ensure the permanent managed block is present, preserving the rest of the
 * file byte for byte. Only writes when the file actually differs.
 * @param path - the profile's patch file.
 * @returns whether a write occurred.
 */
export async function syncManagedBlock(path: string): Promise<boolean> {
  const current = await readPatchOrUndefined(path)
  const next = applyManagedBlock(current ?? '')
  if (current === next) return false
  await writePatchFile(path, next)
  return true
}

/** Synchronous patch-file read for plugin startup only. */
function readPatchFileSync(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return ''
    throw error
  }
}

/** Forward the engine-driver fields of the composition entry to the Claude Code loop. */
function claudeCodeConfig(config: Config): ClaudeCodeConfig {
  return {
    ...config.permissionMode === undefined ? {} : { permissionMode: config.permissionMode },
    ...config.env === undefined ? {} : { env: config.env },
    ...config.model === undefined ? {} : { model: config.model },
    ...config.backend === undefined ? {} : { backend: config.backend },
    ...config.disposeGraceMs === undefined ? {} : { disposeGraceMs: config.disposeGraceMs },
    ...config.maxTurns === undefined ? {} : { maxTurns: config.maxTurns },
  }
}

/** Forward the engine-driver fields of the composition entry to the Codex loop. */
function codexConfig(config: Config): CodexConfig {
  return {
    ...config.sandboxMode === undefined ? {} : { sandboxMode: config.sandboxMode },
    ...config.approvalPolicy === undefined ? {} : { approvalPolicy: config.approvalPolicy },
    ...config.env === undefined ? {} : { env: config.env },
    ...config.model === undefined ? {} : { model: config.model },
  }
}

/** Forward the engine-driver fields of the composition entry to the Pi loop. */
function piConfig(config: Config): PiConfig {
  return {
    ...config.piProvider === undefined ? {} : { provider: config.piProvider },
    ...config.model === undefined ? {} : { model: config.model },
    ...config.piThinking === undefined ? {} : { thinkingLevel: config.piThinking },
    ...config.env === undefined ? {} : { env: config.env },
    ...config.sandboxMode === undefined ? {} : { sandboxMode: config.sandboxMode },
  }
}

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
export function mountBaseLoop(
  ctx: Context,
  loopCtx: Context,
  mount: (engine: LoopEngineId, plugin: () => (Fiber & PromiseLike<Fiber>)) => void,
): void {
  void import('@deepseek-ai/dsh-agent-loop').then(
    ({ default: AgentLoop }) => {
      // `agents` is the base loop's boot-time declarative composition list.
      // Sessions here are always created on demand through the router, so it
      // is empty — this mount exists only to supply the factory.
      mount('in-process', () => loopCtx.plugin(AgentLoop, { agents: [] }))
    },
    (error: unknown) => {
      ctx.logger.warn(`loop-engine: in-process engine unavailable: ${String(error)}`)
    },
  )
}

/** Minimal shape of the host skills service (avoiding a direct peer dep). */
interface SkillsService {
  registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void
}

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
export function registerEngineSkills(engine: LoopEngineId, agentCtx: Context): void {
  const skills = agentCtx.get('skills') as SkillsService | undefined
  if (skills === undefined) return
  if (engine === 'claude-code') {
    skills.registerProvider(control => new ClaudeCodeSkillProvider(control))
  } else if (engine === 'codex') {
    skills.registerProvider(control => new CodexSkillProvider(control))
  } else if (engine === 'pi') {
    skills.registerProvider(control => new PiSkillProvider(control))
  }
}

/**
 * Apply the plugin: own the AgentFactory slot with the router, mount every
 * engine behind it, and track the selection for new sessions.
 * @param ctx - the composing context.
 * @param config - composition entry for the managed patch file.
 */
export function apply(ctx: Context, config: Config): void {
  const patchPath = resolvePatchPath(config)
  // The managed block is permanent: this plugin owns the slot in every
  // configuration, so a profile that predates per-session routing (no block,
  // or a legacy engine-tagged one) is upgraded in place at startup. The write
  // is synchronous because a user may restart `dsh web` at any moment.
  try {
    const current = readPatchFileSync(patchPath)
    const updated = applyManagedBlock(current)
    if (updated !== current) writePatchFileSync(patchPath, updated)
  } catch (error: unknown) {
    ctx.logger.error(`loop-engine: managed block write failed: ${String(error)}`)
  }

  // Minimal shape of the host commands service (avoiding a direct peer dep).
  interface CommandsService {
    register(def: CommandDefinition): () => void
  }

  /**
   * The engine a new session gets when it reserved none — the profile default,
   * updated live by the settings watch.
   *
   * This is a *default*, not the current engine: a session's engine is fixed
   * when it is created and lives in its own record. Changing this never reaches
   * a session that already exists.
   */
  let selected: LoopEngineId = 'in-process'

  const records = new EngineRecordStore(
    () => ctx.get('sessionPersistence') as RecordPersistence | undefined,
  )

  const router = new LoopEngineRouter({
    engineForNewSession: () => selected,
    remember: (meta, engine) => records.remember(meta, engine),
    resolve: sessionId => records.recall(sessionId),
    decorateSetup: registerEngineSkills,
  })

  // The router owns the single slot for the life of the process. Nothing ever
  // replaces it, so the slot race the old runtime-swap logic fought is gone.
  ctx.effect(() => ctx.agents.setFactory(router), 'loop-engine.setFactory()')

  // The browser's route to per-session engine state. Agent creation is eager
  // (it fires at session-open, before a user can click anything), so the
  // composer reserves an engine for a session id it mints itself and only then
  // asks for that session to be created. The same channel reads a session's
  // true engine back, which no projection can supply — it lives in the sidecar.
  //
  // Registered through `ctx.inject` rather than a bare `ctx.get`: `connection`
  // is provided by a sibling plugin that may still be loading when this one
  // applies, and a plain read would see `undefined` and skip the channel for
  // the life of the process. `inject` starts a child fiber that waits for the
  // service and unwinds if it goes away.
  //
  // `webServer` is injected alongside it because `rpc.handle` registers a
  // *route*: it calls `owner.webServer.register(...)` on the fiber that reads
  // the service, where `owner` is this callback's context, not Connection's
  // own. Injecting only `connection` leaves that read undefined and the channel
  // never mounts. The harness draws the same line: the gateway injects bare
  // `['connection']` for `rpc.intercept`, which touches no server, but
  // `['connection', 'webServer']` for anything that registers a route.
  //
  // Both stay out of the plugin-level `inject` on purpose: a headless profile
  // has no Connection, and the rest of the plugin must still mount there.
  ctx.inject(['connection', 'webServer'], (connectionCtx: Context) => {
    installEngineRpc(
      connectionCtx.get('connection') as ConnectionLike | undefined,
      (install, label) => { connectionCtx.effect(install, label) },
      {
        reserve: (sessionId, engine) => { router.reserve(sessionId, engine) },
        recall: sessionId => records.recall(sessionId),
        fallback: () => selected,
      },
    )
  })

  /**
   * Mount one engine behind the router. The engine's own
   * `ctx.agents.setFactory(this)` call is redirected into router registration
   * by the shadowed `agents` member, so the engine classes are unmodified.
   *
   * Cordis starts plugin fibers lazily on await, so the fiber is touched here
   * to start it now; a start failure is reported and leaves that engine
   * unmounted, which the router reports precisely when it is selected.
   */
  const mount = (
    engine: LoopEngineId,
    plugin: () => (Fiber & PromiseLike<Fiber>),
  ): void => {
    const fiber = plugin()
    void fiber.then(() => undefined, (error: unknown) => {
      ctx.logger.error(`loop-engine: ${engine} factory failed to start: ${String(error)}`)
    })
  }

  /**
   * Prompt-variable names already claimed by an engine mounted earlier.
   *
   * Every engine constructor registers the same three engine-independent
   * variables on the unscoped global prompt layer, so the second engine to
   * mount would otherwise die on a duplicate name. First mount wins; the
   * providers are identical and read the assembling agent's own values, so the
   * winner serves every engine correctly. See {@link shadowSystemPrompt}.
   */
  const claimedVariables = new Set<string>()

  /** A child context whose registrations are redirected past their collisions. */
  const engineCtx = (engine: LoopEngineId): Context => ctx.extend({
    agents: router.shadowFor(engine, ctx.agents),
    systemPrompt: shadowSystemPrompt(ctx.systemPrompt, (variable) => {
      if (claimedVariables.has(variable)) return false
      claimedVariables.add(variable)
      return true
    }),
  })

  mount('claude-code', () => engineCtx('claude-code').plugin(ClaudeCodeLoop, claudeCodeConfig(config)))
  mount('codex', () => engineCtx('codex').plugin(CodexLoop, codexConfig(config)))
  mount('pi', () => engineCtx('pi').plugin(PiLoop, piConfig(config)))

  // The base in-process loop declares `static inject = ['agents', 'sessions',
  // 'llm', 'tools', 'systemPrompt']` — it needs the host's `tools` and `llm`
  // services to schedule tool calls and stream model responses. The hosted
  // engines (Claude Code, Codex, Pi) delegate both to their CLI child processes
  // and never touch `ctx.tools` or `ctx.llm`, which is why they mount directly.
  //
  // This plugin's own inject is `['agents', 'systemPrompt']`, so its fiber
  // does not carry `tools` or `llm` in its inject chain. Without an explicit
  // scope, the base loop's child fiber walks up through parent fibers that
  // never declared those services, and the Cordis property resolution throws
  // `cannot get property "tools" without inject` when the walk terminates at
  // the root fiber. The base loop's own `_checkImpl` can still find the
  // implementations in the global reflect store (and activate the fiber), but
  // the *runtime* Proxy handler's fiber walk is stricter — it requires each
  // step's parent to either hold the service in its store or declare it in its
  // inject before continuing the walk.
  //
  // `ctx.inject(['llm', 'tools'], ...)` closes the gap: it starts a child
  // fiber that declares both names, waits for their providers, and gives the
  // base loop a parent whose fiber walk succeeds. If either provider
  // disappears the scope tears down and the in-process engine unmounts cleanly
  // — the other three engines are never touched.
  ctx.inject(['llm', 'tools'], (injectedCtx: Context) => {
    const inProcessCtx = injectedCtx.extend({
      agents: router.shadowFor('in-process', ctx.agents),
      systemPrompt: shadowSystemPrompt(ctx.systemPrompt, (variable) => {
        if (claimedVariables.has(variable)) return false
        claimedVariables.add(variable)
        return true
      }),
    })
    mountBaseLoop(ctx, inProcessCtx, mount)
  })

  // Claude Code slash commands are a client-side namespace, not a scoped
  // registry, so they cannot be filtered by the per-agent seam above. They stay
  // globally registered; their handlers refuse a non-Claude session rather than
  // forwarding a line that engine cannot expand.
  const commands = ctx.get('commands') as CommandsService | undefined
  if (commands !== undefined) {
    for (const command of [...CLAUDE_CODE_COMMANDS, ...discoverUserSlashCommands()]) {
      try {
        ctx.effect(() => commands.register(command), `loop-engine.command(${command.name})`)
      } catch (error: unknown) {
        ctx.logger.warn(`loop-engine: skip claude-code command /${command.name}: ${String(error)}`)
      }
    }
  }

  // Records for sessions the backend no longer knows are swept once, bounded,
  // so a long history cannot stall startup.
  void records.collectOrphans().catch((error: unknown) => {
    ctx.logger.warn(`loop-engine: orphan record sweep failed: ${String(error)}`)
  })

  // installSection always calls setSource before the first onChange,
  // so `source` is guaranteed set here; the assertion is a contract guard.
  let source: (() => LoopEngineSettings) | undefined
  // Since dsh-settings 0.1.2 the optional-settings wiring (composition base
  // layer, detach fallback) lives on the provider itself; the inject only
  // bounds it to a mounted settings service, as the removed free-function
  // helper used to do.
  ctx.inject(['settings'], (settingsCtx: Context) => {
    settingsCtx.settings.installSection(ctx, loopEngineSettingsNamespace(), LOOP_ENGINE_SETTINGS_SCHEMA, { engine: selected, showInComposer: true }, {
      setSource: (current) => { source = current },
      onChange: () => {
        // This is the default for sessions that reserve no engine of their own.
        // Sessions already running keep their engine, and resume reads each
        // session's own record, so nothing is unmounted, no page reload is
        // needed, and no restart.
        selected = source!().engine
      },
    })
  })
}
