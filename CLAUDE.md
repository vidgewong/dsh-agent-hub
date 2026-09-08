# AGENTS.md — dsh-omniloop

## What This Project Is

`dsh-omniloop` (`@vidge/dsh-omniloop`) is a **DSH (DeepSeek Harness) plugin** that provides **per-session agent loop engine routing**. It occupies the harness's single `AgentFactory` slot and installs a `LoopEngineRouter` that dispatches each session to one of four engines:

| Engine ID | SDK | Transport |
|---|---|---|
| `in-process` | `@deepseek-ai/dsh-agent-loop` | Hosted in-process (the DSH built-in loop) |
| `claude-code` | `@anthropic-ai/claude-agent-sdk` | One stateless SDK query per step |
| `codex` | `@openai/codex` | `codex app-server` thread |
| `pi` | `@earendil-works/pi-coding-agent` | `pi --mode rpc` JSONL over stdio |

A session's engine is **fixed at creation** and recorded in a durable sidecar file (`.loop-engine.json`). Resuming always restores the original engine. Switching engines means starting a new session — no restart required.

## Architecture Overview

### Core Design: One Slot, Four Engines

The DSH harness admits exactly **one** `AgentFactory` for the whole process. This plugin takes that slot and turns it into a multiplexer:

```
DSH Harness  (session · LLM · tracing · model routing)
      │
      │  the one AgentFactory slot
      ▼
 LoopEngineRouter  ←── setFactory(router)
      ├── in-process   → dsh-agent-loop  (hosted, not replaced)
      ├── claude-code  → Claude Agent SDK
      ├── codex        → codex app-server
      └── pi           → pi --mode rpc
```

### Cordis IoC Integration

The project is built on the **Cordis IoC framework** (`@deepseek-ai/cordis`):

- **Context** — dependency injection container; plugins extend it
- **Fiber** — lifecycle unit; a plugin's fiber waits for its declared services
- **Service** — named injectable; e.g. `agents`, `sessions`, `systemPrompt`
- **`ctx.effect()`** — registers a side effect that unwinds on dispose
- **`ctx.inject()`** — creates a child fiber that waits for named services
- **`ctx.extend()`** — creates a child context with overridden members

### Shadow Contexts (the Proxy Trick)

All four engines call `ctx.agents.setFactory(this)` in their constructors — which would collide on the single slot. The plugin solves this with **Proxy-based shadow contexts**:

- **`shadowAgents()`** (`src/router.ts`) — wraps `ctx.agents` so each engine's `setFactory` call is redirected into `router.register(engine, factory)` instead of claiming the slot
- **`shadowSystemPrompt()`** (`src/router.ts`) — deduplicates prompt variable registrations (`provider`, `model`, `cwd`) that every engine registers under the same names; first-mount wins

Each engine is mounted through `ctx.extend({ agents: shadow, systemPrompt: shadow })` — the engine classes are **completely unmodified**.

### Browser ↔ Node Bridge

The plugin has two halves:

- **Node half** (`src/index.ts`) — the `apply()` function, router, engines, records
- **Browser half** (`src/client/`) — composer picker, header badge, RPC client

They communicate over the **`/loop-engine` Connection RPC channel**:

- `bind(sessionId, engine)` — reserve an engine for a session about to be created
- `resolve(sessionId)` — query which engine a session is actually running on

The timing is critical: `createAgent` fires eagerly at session-open, so `bind` must happen **before** `sessions.create()`.

## Codebase Map

### Plugin Entry

- **`src/index.ts`** — Main `apply()` function. Mounts all four engines behind the router, installs the RPC channel, registers commands/skills, watches settings. This is the Cordis plugin entry point.
- **`src/namespace.ts`** — Zero-import constants shared by both halves (`LOOP_ENGINE_IDS`, settings namespace literal). Exists so the browser bundle doesn't pull in `dsh-settings`.
- **`src/settings.ts`** — Settings schema (`LoopEngineSettings`) and the branded namespace. Node-half only.

### Routing Core

- **`src/router.ts`** — `LoopEngineRouter` (the sole `AgentFactory`), `shadowAgents()`, `shadowSystemPrompt()`. The router holds a `Map<LoopEngineId, AgentFactory>` and dispatches `createAgent`/`resume` to the right engine.
- **`src/engine-record.ts`** — `EngineRecordStore`: durable per-session engine records. Writes sidecar `.loop-engine.json` files beside the session's persistence artifact (or in a fallback directory). Atomic writes via temp+rename.
- **`src/rpc.ts`** — Node half of the `/loop-engine` Connection RPC channel. Handles `bind` and `resolve` endpoints.

### Engine Drivers

Each engine follows the same pattern: a `Service` subclass implementing `AgentFactory` with `createAgent()` and `resume()`.

- **`src/engine-claude/`** — Claude Code engine
  - `loop.ts` — `ClaudeCodeLoop` service, config resolution, factory lifecycle
  - `agent.ts` — `ClaudeCodeAgent` state machine
  - `sdk.ts` — SDK wrapper, process management
  - `mapping.ts` — Maps SDK events → DSH `ContentBlock`/`StreamChunk`
  - `process.ts` — Child process management
  - `permission.ts` — Maps DSH permission knobs → Claude Code permission modes
  - `provider-env.ts` — Derives CLI environment from DSH's LLM provider config
  - `types.ts` — Engine-specific types

- **`src/engine-codex/`** — Codex engine
  - `loop.ts` — `CodexLoop` service
  - `agent.ts` — `CodexAgent` state machine
  - `appserver/` — App-server client, thread management, mapping
  - `permission.ts` — Maps DSH permission knobs → Codex sandbox modes
  - `skills.ts` — `CodexSkillProvider` (discovers `AGENTS.md` context files)
  - `types.ts`

- **`src/engine-pi/`** — Pi engine
  - `loop.ts` — `PiLoop` service
  - `agent.ts` — `PiAgent` state machine
  - `rpc/` — JSONL RPC client, type mapping
  - `permission.ts` — Sandbox stance resolution
  - `skills.ts` — `PiSkillProvider` (discovers `AGENTS.md`/`CLAUDE.md` context files)
  - `types.ts`

### Shared Driver Core

- **`src/driver-core/ownership.ts`** — `FactoryOwnership`: tracks live agents, fuses abort signals (caller + owner fiber + factory teardown), `raceAbort()` helper
- **`src/driver-core/prompt.ts`** — `serializeHistory()`: converts DSH session log → prompt text for hosted engines
- **`src/driver-core/skill-inject.ts`** — Skill gesture scanning (`/name`), `<skill_content>` XML rendering
- **`src/driver-core/context-files.ts`** — Walks project ancestors collecting `AGENTS.md` / `CLAUDE.md` files
- **`src/driver-core/permission-knobs.ts`** — Reads DSH sandbox/approval session knobs
- **`src/driver-core/missing-sdk.ts`** — Named error for missing optional peer SDKs

### Client (Browser Half)

- **`src/client/index.ts`** — Client plugin `apply()`. Registers the composer picker slot and header badge slot.
- **`src/client/engine-rpc.ts`** — `EngineRpc` class: browser RPC client with client-side hint cache
- **`src/client/engine-visuals.ts`** — Color map per engine (DeepSeek blue, Claude orange, Codex green, Pi violet)
- **`src/client/session-location.ts`** — Resolves workspace/cwd for new session placement
- **`src/client/locales.ts`** — i18n dictionaries (en, zh)
- **`src/client/LoopEngineComposerSelect.tsx`** — Composer engine picker React component
- **`src/client/LoopEngineHeaderBadge.tsx`** — Session header engine badge React component

### Infrastructure

- **`src/patch-manager.ts`** — Manages a delimited block in `cordis.patch.yml` that disables the bundle's `agent-loop` row
- **`src/commands.ts`** — Bridges Claude Code slash commands into the DSH web menu
- **`src/skills.ts`** — `ClaudeCodeSkillProvider`: discovers skills from `.claude/skills/` and `~/.claude/skills/`
- **`src/invariant.ts`** — Shared assertion utilities
- **`src/llm-compat.ts`** — LLM type compatibility helpers

## Development

### Build

```bash
pnpm run build        # esbuild bundle (lib/index.js, lib/client.js, lib/invariant.js + .d.ts)
pnpm run watch        # esbuild in watch mode
pnpm run dev          # dev-install.sh + watch (links into the DSH profile)
```

The build (`build.mjs`) produces three entry bundles via esbuild:
- `lib/index.js` — Node half (plugin entry)
- `lib/client.js` — Browser half (client plugin)
- `lib/invariant.js` — Shared invariant utilities

TypeScript declarations are emitted separately via `tsc -p tsconfig.build.json`.

### Test

```bash
pnpm test             # vitest run
pnpm run test:coverage  # vitest with v8 coverage
pnpm run typecheck    # tsc --noEmit
```

Tests are in `tests/` and mirror the source structure. Key test files:
- `tests/router.spec.ts` — Router dispatch, reservation, shadow contexts
- `tests/engine-record.spec.ts` — Sidecar persistence, orphan collection
- `tests/rpc.spec.ts` — RPC channel endpoints
- `tests/engine-claude/` — Claude Code engine tests
- `tests/engine-codex/` — Codex engine tests
- `tests/engine-pi/` — Pi engine tests
- `tests/commands.spec.ts` — Slash command bridge
- `tests/skills.spec.ts` — Skill provider discovery and parsing
- `tests/patch-manager.spec.ts` — Managed block editing

### Install into DSH

```bash
dsh plugin --profile web add @vidge/dsh-omniloop
# Then restart dsh web once. After that, engine selection is runtime state.
```

## Key Patterns and Conventions

### Structural Typing for Host Services

The plugin declares **structural interfaces** for every host service it borrows (`AgentsLike`, `ConnectionLike`, `SessionsLike`, `SkillsService`, `CommandsService`) rather than importing the service's concrete type. This avoids direct peer dependencies on packages that may not be present in every profile.

### Optional Peer Dependencies

Engine SDKs are optional peers. The plugin uses dynamic `import()` with `.catch()` for `dsh-agent-loop`, and lazy `import.meta.resolve()` for Pi's CLI entrypoint. A missing SDK fails only the sessions that select that engine.

### Atomic File Writes

All durable state (sidecar records, patch files) uses the same discipline: write to a temp file in the same directory, then `rename()`. This is the only POSIX-portable atomic replace.

### Fused Abort Signals

Every agent lifecycle fuses three cancellation sources into one `AbortController`:
1. Caller's signal (the harness or user cancelling)
2. Owner fiber's dispose (the Cordis plugin tree unwinding)
3. Factory teardown (the engine being dismounted)

Any of the three aborts the agent. See `FactoryOwnership` in `src/driver-core/ownership.ts`.

### Engine-Agnostic Session Format

Every engine's native output (SDK events, app-server responses, JSONL messages) is translated into DSH's `Message` / `ContentBlock` / `StreamChunk` types. Sessions from different engines are stored, streamed, resumed, and traced identically. The mapping lives in each engine's `mapping.ts`.

### Zero-Import Namespace Module

`src/namespace.ts` exists so the browser bundle can import `LOOP_ENGINE_IDS` without pulling `dsh-settings` (a host-side Node service) into the client build. Both halves import from it; `src/settings.ts` re-exports for the node half.

## Important Invariants

1. **One AgentFactory for the process.** The router holds this slot permanently. The managed block in `cordis.patch.yml` disables the bundle's own `agent-loop` row.

2. **Engine affinity is immutable.** A session's engine is recorded before `createAgent` delegates to the engine factory. Resuming reads the sidecar, never the current default.

3. **Reservation before creation.** The browser must `bind(sessionId, engine)` before calling `sessions.create({ sessionId })`. Agent creation is eager — it fires at session-open, not at first prompt.

4. **Shadow contexts are Proxy wrappers.** They intercept exactly one method (`setFactory` or `variable`) and forward everything else. The real service is never replaced.

5. **Settings change ≠ session change.** Changing the default engine only affects the *next new* session. Running sessions are undisturbed, no restart needed.

6. **Prompt variable deduplication is first-mount-wins.** All four engines register `provider`, `model`, `cwd` on the global prompt layer. The first to mount wins; the providers are identical and engine-independent.

7. **The patch file must be a YAML array.** `cordis.patch.yml` is parsed as a top-level array of loader patches. A malformed file fails the entire plugin tree.

## Gotchas

- **Don't import `src/settings.ts` from client code.** It pulls in `dsh-settings`. Use `src/namespace.ts` for shared constants.
- **Engine SDK versions must be pinned exactly.** The message vocabularies are not stable across minors. Check `peerDependencies` for the exact versions.
- **`ctx.inject` vs `ctx.get`**: `ctx.get` at `apply()` time may see `undefined` if the service hasn't been provided yet. Use `ctx.inject` for services that may load after this plugin.
- **Synchronous patch writes at startup.** The managed block write in `apply()` is deliberately synchronous — a user restarting `dsh web` immediately must read the updated file.
- **The Codex SDK spawns its own CLI binary** — no subprocess injection seam. It does NOT use `ctx.subprocess`.
- **Pi has no permission system.** The entire `pi --mode rpc` child is wrapped by the DSH subprocess sandbox.
