# dsh-agent-hub

[![npm version](https://img.shields.io/npm/v/@vidge/dsh-agent-hub?color=cb3837)](https://www.npmjs.com/package/@vidge/dsh-agent-hub)

Run any agent loop engine on **dsh** — the built-in in-process loop, Claude
Code, Codex, or Pi — **chosen per session**, all sharing dsh's own session
store, message format, model routing, and tracing.

Pick an engine the way you pick a model: in the composer, when you start a
session. The session you are in keeps running on the engine it was created
with. No restart, no global switch, no interrupted work.

## Why a hub

dsh admits exactly one `AgentFactory` for the whole process. That single slot
is what forced every earlier approach to be a *global* choice: to run Claude
Code you had to disable the base loop, and every session in the profile moved
with you.

This plugin takes that slot and turns it into a router. It holds one factory
per engine — including dsh's own in-process loop, mounted as a first-class
engine rather than replaced — and dispatches each `createAgent` / `resume` call
to the engine that session belongs to.

```
dsh harness  (session · llm · tracing · model routing)
      │
      │  the one AgentFactory slot
      ▼
 LoopEngineRouter
      ├── in-process   → @deepseek-ai/dsh-agent-loop  (hosted, not replaced)
      ├── claude-code  → Claude Agent SDK
      ├── codex        → codex app-server
      └── pi           → pi --mode rpc
```

Everything above the router stays dsh's. Each engine's native output is
translated into dsh's `Message` / `ContentBlock` / `StreamChunk` types, so
sessions from different engines are stored, streamed, resumed, and traced
identically.

### Engine affinity is durable

A session's engine is recorded when it is created and travels with it. Resuming
a session restores it to the engine that produced its history — not to whatever
is currently selected. This matters because engine session logs carry different
provenance (a Codex-driven session records `provider = 'codex'`), and replaying
that history under another engine would hand the model a transcript it cannot
act on.

Forked sessions and subagents inherit the parent's engine.

## Install

```sh
dsh plugin --profile web add @vidge/dsh-agent-hub
```

Restart `dsh web` once after installing. After that, engine selection is
runtime state — switching never requires a restart again.

> Installing writes a small managed block into the profile's
> `cordis.patch.yml`, disabling the bundle's own `agent-loop` row so the router
> can take the factory slot and re-mount that loop itself. Everything else in
> that file is preserved byte for byte.

### Engine dependencies

Each engine's SDK is an **optional peer** — installing this plugin pulls in the
router only. Add the engines you actually want, into **the same profile**:

```sh
# Claude Code
dsh plugin --profile web add @anthropic-ai/claude-agent-sdk@0.3.220
# Codex
dsh plugin --profile web add @openai/codex@0.149.1
# Pi
dsh plugin --profile web add @earendil-works/pi-coding-agent@0.84.3
```

Two details matter, and getting either wrong looks like a plugin bug:

- **Install through `dsh plugin ... add`, not a bare `pnpm add`.** The SDK has to
  land in the profile that runs dsh (`~/.dsh/profiles/<name>`). A `pnpm add` in
  some other directory installs a package the host will never resolve.
- **Pin the version this release declares.** The versions above are the exact
  `peerDependencies` entries of this package; the SDK message vocabularies are
  not stable across minors, and a drifting version is not a supported
  configuration.

Because profiles set `autoInstallPeers: false`, an optional peer is only ever
present if some package explicitly depends on it. Installing it as a direct
profile dependency (which the command above does) records it in the profile's
lockfile, so later installs and upgrades keep it. An SDK that is merely *present*
in `node_modules` without being depended on is an orphan, and the next
`pnpm install` in that profile will prune it — after which the engine reports the
package as missing.

The `in-process` engine needs nothing beyond dsh itself, so a profile that
installs no SDK at all still works.

Selecting an engine whose SDK is missing fails that turn with a message naming
the package to install; it never affects other sessions or engines.

### Authentication

Only for the engines you use:

- **Claude Code** — credentials are derived from dsh's own LLM provider
  configuration (see below); a CLI login is a fallback, not a requirement.
- **Codex** — authenticated via `codex login`, or a `CODEX_API_KEY` entry.
- **Pi** — authenticated the way `pi` expects: its own `~/.pi/agent/auth.json`,
  or the provider's API-key environment variable.

## Usage

Choose an engine in the composer when starting a session. To change engines,
start a new session — the current one keeps its engine, and anything still
running on it is undisturbed.

**Settings → Loop engine** sets the default for new sessions and controls
whether the composer picker is shown.

To remove the plugin:

```sh
dsh plugin --profile web remove @vidge/dsh-agent-hub
```

Then restart `dsh web`.

## Model and credential routing

For the Claude Code engine, the child process's provider environment is derived
from dsh's own LLM configuration rather than inherited from the shell that
launched the host. The selected model names a provider route; the plugin reads
that route's endpoint from `llm-pi-ai` settings, resolves its key through dsh's
`credentials` service, and states the result as the environment variables the
Agent SDK understands — Bedrock (including behind a corporate gateway) and
native Anthropic endpoints.

This is why a dsh started from a desktop launcher works: it inherits no
provider variables, but it does not need to. dsh already knows the answer.

When a route cannot be derived — an OpenAI-protocol provider with no Claude
Code equivalent, an unset credential — the plugin falls back to inherited
environment and reports what the child was actually pointed at.

## Engine notes

- **Claude Code** runs one SDK query per dsh step. Its slash commands are
  bridged into the web menu (built-ins plus user-level `~/.claude/commands/`)
  and forwarded to the engine, which expands them natively. Project-level
  `.claude/commands/` files stay engine-side and work when typed directly.
- **Codex** runs `codex app-server` and has no interactive tool approval —
  permissions come from the session's `sandboxMode` + `approvalPolicy`. Its
  `AGENTS.md` files are surfaced through the dsh skill-injection seam across
  every directory from the session cwd up to the git root, plus
  `~/.codex/AGENTS.md`.
- **Pi** runs `pi --mode rpc`. Pi has no permission system, so the whole child
  is sandboxed through the dsh subprocess service (default `read-only`). Its
  context files (`AGENTS.md` / `CLAUDE.md`, with `AGENTS.override.md`
  preferred, plus the user-level file under the pi config dir) and its
  `skills/` catalogs are surfaced through the same seam.

## License

MIT
