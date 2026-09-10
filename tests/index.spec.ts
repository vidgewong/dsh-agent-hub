/**
 * Node-half suite: patch path resolution, atomic file writes, the
 * settings-selection → managed-block pipeline, and apply wiring.
 * @module tests/index
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry, { type AgentFactory } from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

import {
  apply,
  mountBaseLoop,
  registerEngineSkills,
  resolvePatchPath,
  syncManagedBlock,
  writePatchFile,
} from '../src/index.ts'
import { applyManagedBlock, hasManagedBlock } from '../src/patch-manager.ts'
import { LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL } from '../src/namespace.ts'
import { CLAUDE_CODE_COMMANDS, type CommandDefinition } from '../src/commands.ts'
import { ClaudeCodeSkillProvider, type SkillProvider, type SkillProviderControl } from '../src/skills.ts'
import { CodexSkillProvider } from '../src/engine-codex/skills.ts'
import { PiSkillProvider } from '../src/engine-pi/skills.ts'
import { EngineRecordStore } from '../src/engine-record.ts'

// Partial mocks so a non-ENOENT read failure is reproducible on every host.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => actual.readFile(...args)) }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) => actual.readFileSync(...args)) }
})

const mockedReadFile = vi.mocked(readFile)
const mockedReadFileSync = vi.mocked(readFileSync)

/** Hoisted home path so the os homedir mock can return it (claude command discovery reads `~/.claude/commands`). */
const mockHome = vi.hoisted(() => ({ path: '' }))

vi.mock('node:os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:os')>()
  return { ...mod, homedir: () => mockHome.path }
})

// Each test gets a fresh empty home, so `discoverUserSlashCommands` in the
// claude-code mount path is deterministic regardless of the host's dotfiles.
// `DSH_HOME` is redirected too: the `node:os` mock below only reaches importers
// inside this module graph, and dsh-home-paths resolves its own copy — without
// the env override the engine records would land in the developer's live
// `~/.dsh/loop-engine`.
let previousDshHome: string | undefined
beforeEach(async () => {
  mockHome.path = await tempDir()
  previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(mockHome.path, '.dsh')
})

const NS = LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL

/** In-memory settings provider (same shape as the shared test fixture). */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown>

  constructor(ctx: Context, doc?: Record<string, unknown>) {
    super(ctx)
    this.doc = structuredClone(doc ?? {})
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

async function boot(doc?: Record<string, unknown>) {
  const ctx = new Context()
  // The claude-code managed block hosts the Claude Code factory in apply(),
  // which requires the agent/session/system-prompt/subprocess services.
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  const fiber = ctx.plugin(MemorySettings, doc)
  await fiber
  return { ctx, provider: ctx.get('settings') as MemorySettings, fiber }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  while (cleanups.length > 0) {
    const dispose = cleanups.pop()!
    await dispose()
  }
  vi.restoreAllMocks()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'loop-engine-test-'))
  cleanups.push(async () => {
    // Renaming a just-written file can leave the Windows directory entry stale;
    // Node's built-in retry handles ENOTEMPTY/EBUSY/EPERM.
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  })
  return dir
}

describe('resolvePatchPath', () => {
  it('defaults to the web profile cordis.patch.yml under the dsh home', () => {
    expect(resolvePatchPath({})).toBe(join(resolveDshHome(), 'profiles', 'web', 'cordis.patch.yml'))
  })

  it('honors a custom profile and patch filename', () => {
    expect(resolvePatchPath({ profile: 'claude-loop', patchFilename: 'patches.yml' }))
      .toBe(join(resolveDshHome(), 'profiles', 'claude-loop', 'patches.yml'))
  })

  it('prefers an explicit patchPath over profile derivation', () => {
    expect(resolvePatchPath({ patchPath: '/tmp/x.yml', profile: 'web' })).toBe('/tmp/x.yml')
  })

  it('treats an empty patchPath as absent', () => {
    expect(resolvePatchPath({ patchPath: '' })).toBe(join(resolveDshHome(), 'profiles', 'web', 'cordis.patch.yml'))
  })
})

describe('writePatchFile', () => {
  it('creates parent directories and writes the text', async () => {
    const dir = await tempDir()
    const path = join(dir, 'a', 'b', 'cordis.patch.yml')
    await writePatchFile(path, '# hello\n')
    expect(await readFile(path, 'utf8')).toBe('# hello\n')
  })

  it('leaves no temporary files behind', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writePatchFile(path, 'x\n')
    const leftover = (await readdir(dir)).filter(name => name.includes('.tmp-'))
    expect(leftover).toEqual([])
  })

  it('overwrites an existing file', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, 'old\n')
    await writePatchFile(path, 'new\n')
    expect(await readFile(path, 'utf8')).toBe('new\n')
  })
})

describe('syncManagedBlock', () => {
  it('creates a missing file with the permanent block', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const changed = await syncManagedBlock(path)
    expect(changed).toBe(true)
    const text = await readFile(path, 'utf8')
    expect(hasManagedBlock(text)).toBe(true)
    expect(text).toContain('- id: agent-loop\n  disabled: true')
  })

  it('reports no change when the file already matches', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n'))
    const changed = await syncManagedBlock(path)
    expect(changed).toBe(false)
  })

  it('upgrades a legacy engine-tagged block in place, preserving surrounding lines', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const seed = '# my patches\n- id: tool-x\n'
    const legacy = `${seed}\n# -- dsh-loop-engine managed block: codex --\n- id: agent-loop\n  disabled: true\n# -- /dsh-loop-engine managed block --\n`
    await writeFile(path, legacy)
    const changed = await syncManagedBlock(path)
    expect(changed).toBe(true)
    const text = await readFile(path, 'utf8')
    // The user's own rows survive byte for byte, and the block is the
    // engine-independent one — the selection is runtime state now.
    expect(text.startsWith(seed)).toBe(true)
    expect(text).toBe(applyManagedBlock(seed))
    expect(text).not.toContain('codex')
  })

  it('adds the block to a file that predates the plugin', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, '# seed\n')
    // The plugin now owns the AgentFactory slot in every configuration, so a
    // block-free file is no longer a valid resting state.
    expect(await syncManagedBlock(path)).toBe(true)
    expect(hasManagedBlock(await readFile(path, 'utf8'))).toBe(true)
    expect(await syncManagedBlock(path)).toBe(false)
  })

  it('rejects a non-ENOENT read failure instead of swallowing it', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    mockedReadFile.mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
    await expect(syncManagedBlock(path)).rejects.toThrow('EACCES')
  })
})

describe('apply', () => {
  it('writes the permanent block at startup and leaves it alone on a settings commit', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const { ctx, fiber } = await boot({ [NS]: { engine: 'in-process' } })
    apply(ctx, { patchPath: path })

    // The block goes in synchronously at attach: the plugin owns the slot in
    // every configuration, so it cannot wait for a selection to be made.
    const afterAttach = await readFile(path, 'utf8')
    expect(hasManagedBlock(afterAttach)).toBe(true)

    // A selection change is runtime state and must not reach boot state.
    await ctx.settings.update(NS, { engine: 'claude-code' })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(await readFile(path, 'utf8')).toBe(afterAttach)

    await fiber.dispose()
  })

  it('is idempotent: attach does not rewrite a file that already matches', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    const seed = applyManagedBlock('# seed\n')
    await writeFile(path, seed)
    const { ctx, fiber } = await boot({ [NS]: { engine: 'claude-code' } })
    apply(ctx, { patchPath: path })

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await readFile(path, 'utf8')).toBe(seed)

    await fiber.dispose()
  })

  it('forwards the engine-driver configuration to the hosted Claude Code factory', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n'))
    const { ctx, fiber } = await boot({ [NS]: { engine: 'claude-code' } })
    apply(ctx, {
      patchPath: path,
      permissionMode: 'plan',
      env: { ANTHROPIC_AUTH_TOKEN: 'x' },
      model: 'claude-opus-4-6',
      backend: 'anthropic',
      disposeGraceMs: 1000,
      maxTurns: 4,
    })
    // The Claude Code factory mounts as a plugin fiber, which starts
    // asynchronously after apply() returns.
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopClaudeCode')).toBeDefined()
    })
    const loop = ctx.get('agentLoopClaudeCode')!
    expect(loop.config).toMatchObject({
      permissionMode: 'plan',
      env: { ANTHROPIC_AUTH_TOKEN: 'x' },
      model: 'claude-opus-4-6',
      backend: 'anthropic',
      disposeGraceMs: 1000,
      maxTurns: 4,
    })

    await fiber.dispose()
  })

  it('logs and keeps running when the block write fails', async () => {
    const dir = await tempDir()
    // Point the file write at a path whose parent is a file: mkdir and rename
    // both fail, so the block write throws and the plugin reports it.
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'x')
    const badPath = join(blocker, 'cordis.patch.yml')
    const { ctx, fiber } = await boot({ [NS]: { engine: 'in-process' } })
    const errorSpy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    apply(ctx, { patchPath: badPath })

    expect(errorSpy.mock.calls.some(call => String(call[0]).includes('managed block write failed'))).toBe(true)
    // A profile the plugin cannot patch still routes in-process sessions, so
    // the engines mount regardless.
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopClaudeCode')).toBeDefined()
    })

    await fiber.dispose()
  })

  it('reports a non-ENOENT failure from the startup read without failing the plugin', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    mockedReadFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    })
    const { ctx, fiber } = await boot()
    const errorSpy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    apply(ctx, { patchPath: path })
    expect(errorSpy.mock.calls.some(call => String(call[0]).includes('EACCES'))).toBe(true)
    await fiber.dispose()
  })
})

async function safeRead(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** The loop-engine namespace branded for settings writes (the bare literal is not a SettingsNamespace). */
const NS_BRANDED = NS as SettingsNamespace

/** A stand-in for the base agent-loop's factory while it owns the slot. */
function fakeAgentFactory(): AgentFactory {
  return {
    createAgent: vi.fn(async () => { throw new Error('base factory must not serve claude sessions') }),
    resume: vi.fn(async () => { throw new Error('base factory must not serve claude sessions') }),
  } as unknown as AgentFactory
}

/** Fake host commands service: records registrations and hands out recording disposers. */
function fakeCommandsService() {
  const registered: CommandDefinition[] = []
  const disposers: Array<ReturnType<typeof vi.fn>> = []
  const register = vi.fn((def: CommandDefinition) => {
    registered.push(def)
    const dispose = vi.fn()
    disposers.push(dispose)
    return dispose
  })
  return { registered, disposers, register }
}

/** Fake host skills service: records provider factories and hands out a recording disposer. */
function fakeSkillsService() {
  const creates: Array<(control: SkillProviderControl) => SkillProvider> = []
  const disposer = vi.fn()
  const registerProvider = vi.fn((create: (control: SkillProviderControl) => SkillProvider) => {
    creates.push(create)
    return disposer
  })
  return { creates, disposer, registerProvider }
}


describe('apply command registrations', () => {
  it('registers the claude-code commands globally', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n'))
    const { ctx, fiber } = await boot({ [NS]: { engine: 'claude-code' } })
    const commands = fakeCommandsService()
    ctx.provide('commands', commands)
    apply(ctx, { patchPath: path })
    await new Promise(resolve => setTimeout(resolve, 20))

    // Slash commands are a client-side namespace, not a scoped registry, so
    // they cannot ride the per-agent seam and stay globally registered.
    expect(commands.registered.map(def => def.name)).toEqual(CLAUDE_CODE_COMMANDS.map(def => def.name))

    await fiber.dispose()
  })

  it('registers the commands regardless of the selected engine', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n'))
    const { ctx, fiber } = await boot({ [NS]: { engine: 'codex' } })
    const commands = fakeCommandsService()
    ctx.provide('commands', commands)
    apply(ctx, { patchPath: path })
    await new Promise(resolve => setTimeout(resolve, 20))

    // The selection is per-session now, so a claude session can be created at
    // any time and its commands must already be there.
    expect(commands.registered).toHaveLength(CLAUDE_CODE_COMMANDS.length)

    await fiber.dispose()
  })

  it('skips a command registration that collides with a dsh-native command', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n'))
    const { ctx, fiber } = await boot({ [NS]: { engine: 'claude-code' } })
    const commands = fakeCommandsService()
    const warnSpy = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    commands.register.mockImplementationOnce(() => {
      throw new Error('command "help" is already registered')
    })
    ctx.provide('commands', commands)
    apply(ctx, { patchPath: path })
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(commands.registered).toHaveLength(CLAUDE_CODE_COMMANDS.length - 1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skip claude-code command /help'))

    await fiber.dispose()
  })

  it('runs without a host commands service at all', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n'))
    const { ctx, fiber } = await boot({ [NS]: { engine: 'claude-code' } })
    apply(ctx, { patchPath: path })
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopClaudeCode')).toBeDefined()
    })

    await fiber.dispose()
  })
})

describe('apply per-session skill registration', () => {
  /**
   * Skill providers are no longer registered globally: the router wraps each
   * session's `setup` and registers the engine's provider through the agent's
   * OWN scope-tagged context, so the harness's layered registry shows it to
   * exactly that session. These tests drive that seam through `ctx.agents`.
   */
  async function bootRouted(engine: string) {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n'))
    const { ctx, fiber } = await boot({ [NS]: { engine } })
    const skills = fakeSkillsService()
    // The agent context inherits `skills` from the plugin context, which is
    // what the router's setup wrapper reads.
    ctx.provide('skills', skills)
    apply(ctx, { patchPath: path })
    return { ctx, fiber, skills }
  }

  it('registers no skill provider before any session exists', async () => {
    const { ctx, fiber, skills } = await bootRouted('claude-code')
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopClaudeCode')).toBeDefined()
    })
    // The old design registered one provider globally at mount; that is what
    // leaked `~/.claude/skills` into a codex session.
    expect(skills.creates).toHaveLength(0)

    await fiber.dispose()
  })

  it('registers the claude provider for a session created on claude-code', async () => {
    const { ctx, fiber, skills } = await bootRouted('claude-code')
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopClaudeCode')).toBeDefined()
    })

    const handle = await ctx.agents.create({
      sessionId: SessionId('skills-claude'),
      meta: { cwd: process.cwd() },
    })
    expect(skills.creates).toHaveLength(1)
    const control: SkillProviderControl = { signal: new AbortController().signal, invalidate: () => {} }
    expect(skills.creates[0]!(control)).toBeInstanceOf(ClaudeCodeSkillProvider)
    await handle.dispose()

    await fiber.dispose()
  })

  it('registers the codex provider for a session created on codex', async () => {
    const { ctx, fiber, skills } = await bootRouted('codex')
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopCodex')).toBeDefined()
    })

    const handle = await ctx.agents.create({
      sessionId: SessionId('skills-codex'),
      meta: { cwd: process.cwd() },
    })
    const control: SkillProviderControl = { signal: new AbortController().signal, invalidate: () => {} }
    expect(skills.creates[0]!(control)).toBeInstanceOf(CodexSkillProvider)
    await handle.dispose()

    await fiber.dispose()
  })

  it('registers the pi provider for a session created on pi', async () => {
    const { ctx, fiber, skills } = await bootRouted('pi')
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopPi')).toBeDefined()
    })

    const handle = await ctx.agents.create({
      sessionId: SessionId('skills-pi'),
      meta: { cwd: process.cwd() },
    })
    const control: SkillProviderControl = { signal: new AbortController().signal, invalidate: () => {} }
    expect(skills.creates[0]!(control)).toBeInstanceOf(PiSkillProvider)
    await handle.dispose()

    await fiber.dispose()
  })

  it('registers no engine provider for an in-process session', () => {
    // The base loop injects `llm` and `tools`, which this suite does not boot,
    // so it cannot be mounted here; `mountBaseLoop` is covered directly below.
    // What matters at this seam is the decorator's engine mapping: the three
    // driver engines contribute a provider and `in-process` contributes none,
    // because the base loop brings the harness's own skills.
    const creates: Array<(control: SkillProviderControl) => SkillProvider> = []
    const agentCtx = {
      get: () => ({ registerProvider: (create: (control: SkillProviderControl) => SkillProvider) => {
        creates.push(create)
        return () => {}
      } }),
    } as unknown as Context

    registerEngineSkills('in-process', agentCtx)
    expect(creates).toHaveLength(0)

    registerEngineSkills('claude-code', agentCtx)
    expect(creates).toHaveLength(1)
  })
})

describe('per-session routing', () => {
  it('creates each session on the engine selected at that moment', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n'))
    const { ctx, fiber } = await boot({ [NS]: { engine: 'codex' } })
    apply(ctx, { patchPath: path })
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopCodex')).toBeDefined()
    })

    const first = await ctx.agents.create({
      sessionId: SessionId('routing-codex'),
      meta: { cwd: process.cwd() },
    })

    // Switching mid-flight must not disturb the session already running.
    await ctx.settings.update(NS_BRANDED, { engine: 'claude-code' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(first.agent).toBeDefined()

    const second = await ctx.agents.create({
      sessionId: SessionId('routing-claude'),
      meta: { cwd: process.cwd() },
    })
    expect(second.agent).toBeDefined()
    // Distinct engines serve them: the agents are different classes.
    expect(second.agent.constructor).not.toBe(first.agent.constructor)

    await second.dispose()
    await first.dispose()
    await fiber.dispose()
  })

  it('records the creating engine durably so a later resume can recover it', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n'))
    const { ctx, fiber } = await boot({ [NS]: { engine: 'codex' } })
    apply(ctx, { patchPath: path })
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopCodex')).toBeDefined()
    })

    const created = await ctx.agents.create({
      sessionId: SessionId('resume-codex'),
      meta: { cwd: process.cwd() },
    })
    await created.dispose()

    // The selection moves on, but the record pins the session to the engine
    // that wrote its history — this is what makes resume correct. The full
    // dispatch is asserted against the router directly in tests/router.spec.ts.
    await ctx.settings.update(NS_BRANDED, { engine: 'claude-code' })
    await new Promise(resolve => setTimeout(resolve, 20))

    const store = new EngineRecordStore(
      () => ctx.get('sessionPersistence') as never,
    )
    expect(await store.recall('resume-codex')).toBe('codex')

    await fiber.dispose()
  })
})

describe('engine driver configuration', () => {
  it('forwards the codex driver configuration', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n'))
    const { ctx, fiber } = await boot({ [NS]: { engine: 'codex' } })
    apply(ctx, {
      patchPath: path,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-failure',
      env: { CX_ENV: '1' },
      model: 'gpt-5.2-codex',
    })
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopCodex')).toBeDefined()
    })
    expect(ctx.get('agentLoopCodex')!.config).toMatchObject({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-failure',
      env: { CX_ENV: '1' },
      model: 'gpt-5.2-codex',
    })

    await fiber.dispose()
  })

  it('forwards the pi driver configuration', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n'))
    const { ctx, fiber } = await boot({ [NS]: { engine: 'pi' } })
    apply(ctx, {
      patchPath: path,
      sandboxMode: 'workspace-write',
      env: { PI_ENV: '1' },
      model: 'pi-deployment-model',
      piProvider: 'anthropic',
      piThinking: 'high',
    })
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopPi')).toBeDefined()
    })
    expect(ctx.get('agentLoopPi')!.config).toMatchObject({
      sandboxMode: 'workspace-write',
      env: { PI_ENV: '1' },
      model: 'pi-deployment-model',
      provider: 'anthropic',
      thinkingLevel: 'high',
    })

    await fiber.dispose()
  })

  it('reports an engine whose fiber fails to start and leaves the rest mounted', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n'))
    const { ctx, fiber } = await boot({ [NS]: { engine: 'claude-code' } })
    const errorSpy = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    // A non-finite grace makes the claude loop's config boundary throw. Codex
    // and pi do not validate it, so they must still come up.
    apply(ctx, { patchPath: path, disposeGraceMs: Number.NaN })

    await vi.waitFor(() => {
      expect(errorSpy.mock.calls.some(call => String(call[0]).includes('claude-code factory failed to start'))).toBe(true)
    })
    expect(ctx.get('agentLoopClaudeCode')).toBeUndefined()
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopCodex')).toBeDefined()
    })

    await fiber.dispose()
  })

  it('fails a session loudly when its engine is not mounted', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n'))
    const { ctx, fiber } = await boot({ [NS]: { engine: 'claude-code' } })
    vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    apply(ctx, { patchPath: path, disposeGraceMs: Number.NaN })
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopCodex')).toBeDefined()
    })

    // Silently falling back would run the session on an engine that cannot
    // read its history — the exact defect per-session routing removes.
    await expect(ctx.agents.create({
      sessionId: SessionId('unmounted-engine'),
      meta: { cwd: process.cwd() },
    })).rejects.toThrow(/engine "claude-code" is not mounted/)

    await fiber.dispose()
  })
})

describe('mountBaseLoop', () => {
  it('mounts the base loop with an empty declarative agent list', async () => {
    const ctx = new Context()
    const mounted: string[] = []
    const loopCtx = {
      plugin: vi.fn((_plugin: unknown, config: unknown) => {
        mounted.push(JSON.stringify(config))
        return Promise.resolve({}) as never
      }),
    } as unknown as Context

    mountBaseLoop(ctx, loopCtx, (engine, plugin) => {
      mounted.push(engine)
      void plugin()
    })
    await vi.waitFor(() => {
      expect(mounted).toContain('in-process')
    })

    // Sessions are always created on demand through the router, so the base
    // loop's boot-time composition list must be empty.
    expect(mounted).toContain(JSON.stringify({ agents: [] }))
  })

  it('loses only the in-process engine when the peer package is absent', async () => {
    const ctx = new Context()
    const warnSpy = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    // The base loop is a peer dependency: a deployment that omits it must not
    // fail the whole plugin tree.
    vi.doMock('@deepseek-ai/dsh-agent-loop', () => {
      throw new Error('Cannot find package')
    })
    vi.resetModules()
    const { mountBaseLoop: fresh } = await import('../src/index.ts')

    const mount = vi.fn()
    fresh(ctx, {} as Context, mount)
    await vi.waitFor(() => {
      expect(warnSpy.mock.calls.some(call =>
        String(call[0]).includes('in-process engine unavailable'))).toBe(true)
    })
    expect(mount).not.toHaveBeenCalled()

    vi.doUnmock('@deepseek-ai/dsh-agent-loop')
    vi.resetModules()
  })

  it('skips the mount when its generation went inactive before the import resolved', async () => {
    const ctx = new Context()
    // A stale generation: the inject-scope fiber unloaded (its providers
    // reprovisioned) while the dynamic import was in flight. `assertActive`
    // throws for such a fiber, and the mount must be skipped so the base loop
    // never lands on a context whose parent no longer holds `tools`/`llm`.
    const loopCtx = {
      fiber: { assertActive: () => { throw new Error('cannot create effect on inactive context') } },
      plugin: vi.fn(() => Promise.resolve({}) as never),
    } as unknown as Context

    const mount = vi.fn()
    mountBaseLoop(ctx, loopCtx, mount)
    // Give the dynamic import a chance to resolve, then confirm nothing mounted.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(mount).not.toHaveBeenCalled()
    expect((loopCtx.plugin as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })
})

describe('apply durable-record wiring', () => {
  it('resumes a session on the engine its record names', async () => {
    const root = await tempDir()
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n'))

    // Seed a durable session the way a previous process would have left one.
    const seedCtx = new Context()
    await seedCtx.plugin(SessionStore)
    await seedCtx.plugin(JsonlSessionPersistence, { root })
    const seeded = seedCtx.sessions.create(SessionId('recorded-codex'), {
      meta: { cwd: process.cwd() },
      seed: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ],
    })
    await seedCtx.sessions.flush(seeded)
    await seedCtx.fiber.dispose()

    const { ctx, fiber } = await boot({ [NS]: { engine: 'claude-code' } })
    await ctx.plugin(JsonlSessionPersistence, { root })
    apply(ctx, { patchPath: path })
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopCodex')).toBeDefined()
    })

    // Pre-seed the record the way createAgent would, then resume while the
    // selection points at a different engine: the record must win, because
    // codex is the only engine that can read this session's provenance.
    // The cwd is part of the key: the JSONL backend files a session under its
    // project directory, so a record written without it is unreadable here.
    const store = new EngineRecordStore(() => ctx.get('sessionPersistence') as never)
    await store.remember({ id: 'recorded-codex', cwd: process.cwd() }, 'codex')

    const resumed = await ctx.agents.resume({
      resumeSessionId: SessionId('recorded-codex'),
      meta: { cwd: process.cwd() },
    })
    expect(resumed.agent.constructor.name).toMatch(/Codex/)

    await resumed.dispose()
    await fiber.dispose()
  })

  it('warns instead of failing when the orphan sweep cannot run', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n'))
    const { ctx, fiber } = await boot({ [NS]: { engine: 'in-process' } })
    const warnSpy = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    // A regular file where the record directory belongs makes readdir throw
    // ENOTDIR. Startup must survive it: the sweep is housekeeping, not wiring.
    await mkdir(resolveDshHome(), { recursive: true })
    await writeFile(join(resolveDshHome(), 'loop-engine'), 'not a directory', 'utf8')

    apply(ctx, { patchPath: path })
    await vi.waitFor(() => {
      expect(warnSpy.mock.calls.some(call =>
        String(call[0]).includes('orphan record sweep failed'))).toBe(true)
    })

    await fiber.dispose()
  })
})

describe('apply engine RPC wiring', () => {
  /**
   * A fake host Connection that records the channels registered on it.
   *
   * `rpc.handle` is the only member the plugin touches. It mirrors one detail of
   * the real `HostConnectionService` that a looser fake hid for a whole release:
   * registering a channel registers a *route*, via `owner.webServer.register(...)`
   * on the fiber that read the service (`client/connection/src/rpc-host.ts:172-175`).
   * When that fiber has no `webServer`, the real implementation throws on the
   * undefined read — so this fake throws too. Without that, a plugin injecting
   * only `connection` looked perfectly healthy in tests while every request to
   * the channel 405'd in the browser.
   *
   * The disposer is async because the real one awaits route removal.
   */
  function fakeConnection(webServerOf: () => unknown) {
    const channels = new Map<string, (endpoint: string, payload: unknown, signal: AbortSignal) => unknown>()
    return {
      channels,
      rpc: {
        handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => unknown, options: { authority: string }) {
          if (webServerOf() === undefined) {
            throw new TypeError(`fake connection: ${channel} registered on a fiber with no webServer`)
          }
          // The host reads `options.authority` immediately; omitting the
          // argument throws inside the effect, which cordis swallows into the
          // fiber, leaving the route silently unregistered and every request
          // 405ing. Reproduced here so the arity cannot regress unnoticed.
          if (options?.authority === undefined) {
            throw new TypeError("Cannot read properties of undefined (reading 'authority')")
          }
          channels.set(channel, handler)
          return async () => { channels.delete(channel) }
        },
      },
    }
  }

  /** Boot the plugin with a Connection provided, and wait for the channel. */
  async function bootConnected(provideBefore: boolean) {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n'))
    const { ctx, fiber } = await boot({ [NS]: { engine: 'codex' } })
    const connection = fakeConnection(() => ctx.get('webServer'))
    if (provideBefore) {
      ctx.provide('webServer', { register: () => () => {} })
      ctx.provide('connection', connection)
    }
    apply(ctx, { patchPath: path })
    // The services arriving *after* apply is the case that broke in production
    // twice over: a bare `ctx.get('connection')` missed the connection
    // permanently, and injecting `connection` without `webServer` ran this
    // callback before the server existed, so the channel never mounted.
    // Deliberately provided in the order that leaves `webServer` last.
    if (!provideBefore) {
      ctx.provide('connection', connection)
      ctx.provide('webServer', { register: () => () => {} })
    }
    await vi.waitFor(() => {
      expect(connection.channels.has('/loop-engine')).toBe(true)
    })
    return { ctx, fiber, connection }
  }

  it('registers the channel when the Connection is already provided', async () => {
    const { fiber, connection } = await bootConnected(true)
    expect([...connection.channels.keys()]).toEqual(['/loop-engine'])
    await fiber.dispose()
  })

  it('registers the channel when the Connection arrives after apply', async () => {
    // The regression this guards: `connection` is provided by a sibling plugin
    // that may still be loading, and reading it eagerly left the composer with
    // no channel and therefore no visible engine control.
    const { fiber, connection } = await bootConnected(false)
    expect(connection.channels.has('/loop-engine')).toBe(true)
    await fiber.dispose()
  })

  it('waits for the web server before registering the channel', async () => {
    // Registering a channel registers a route, so the callback must not run
    // until `webServer` exists. With `inject(['connection'])` alone it ran as
    // soon as the connection arrived, threw on the undefined `webServer`, and
    // left the channel unregistered for the life of the process — which is
    // exactly what "switching does nothing" looked like from the browser.
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n'))
    const { ctx, fiber } = await boot({ [NS]: { engine: 'codex' } })
    const connection = fakeConnection(() => ctx.get('webServer'))
    ctx.provide('connection', connection)
    apply(ctx, { patchPath: path })

    // Connection alone must not be enough to attempt registration.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(connection.channels.has('/loop-engine')).toBe(false)

    ctx.provide('webServer', { register: () => () => {} })
    await vi.waitFor(() => {
      expect(connection.channels.has('/loop-engine')).toBe(true)
    })
    await fiber.dispose()
  })

  it('reserves an engine through bind and creates that session on it', async () => {
    const { ctx, fiber, connection } = await bootConnected(true)
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopPi')).toBeDefined()
    })
    const handler = connection.channels.get('/loop-engine')!
    const signal = new AbortController().signal

    // The profile default is codex; the reservation must beat it.
    expect(await handler('bind', { sessionId: 'rpc-reserved', engine: 'pi' }, signal))
      .toEqual({ ok: true, value: { engine: 'pi' } })

    const handle = await ctx.agents.create({
      sessionId: SessionId('rpc-reserved'),
      meta: { cwd: process.cwd() },
    })
    expect(handle.agent.constructor.name).toMatch(/Pi/)
    await handle.dispose()

    await fiber.dispose()
  })

  it('resolves a session with no record to the profile default', async () => {
    const { fiber, connection } = await bootConnected(true)
    const handler = connection.channels.get('/loop-engine')!
    const signal = new AbortController().signal

    // No persistence is mounted here, so `recall` finds nothing and falls
    // through to `in-process` — the safe default an unpatched profile boots on.
    expect(await handler('resolve', { sessionId: 'rpc-unknown' }, signal))
      .toEqual({ ok: true, value: { engine: 'in-process' } })

    await fiber.dispose()
  })

  it('resolves to the profile default when the record store throws', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n'))
    const { ctx, fiber } = await boot({ [NS]: { engine: 'codex' } })
    const connection = fakeConnection(() => ctx.get('webServer'))
    ctx.provide('webServer', { register: () => () => {} })
    ctx.provide('connection', connection)
    apply(ctx, { patchPath: path })
    await vi.waitFor(() => {
      expect(connection.channels.has('/loop-engine')).toBe(true)
    })
    const handler = connection.channels.get('/loop-engine')!

    // A record file that exists but cannot be read is not a miss: `recall`
    // rethrows anything that is not ENOENT, which is the only path to the
    // channel's `fallback`.
    mockedReadFile.mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }))

    // The profile default — not `in-process` — because the store failed rather
    // than reported no record.
    expect(await handler('resolve', { sessionId: 'rpc-broken' }, new AbortController().signal))
      .toEqual({ ok: true, value: { engine: 'codex' } })

    await fiber.dispose()
  })

  it('withdraws the channel when the plugin unwinds', async () => {
    const { ctx, connection } = await bootConnected(true)
    // `apply` runs directly on the root context here (not as a child plugin),
    // so its effects — the inject fiber included — unwind with that context.
    await ctx.fiber.dispose()
    await vi.waitFor(() => {
      expect(connection.channels.has('/loop-engine')).toBe(false)
    })
  })

  it('mounts without a Connection at all', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, applyManagedBlock('# seed\n'))
    const { ctx, fiber } = await boot({ [NS]: { engine: 'in-process' } })
    apply(ctx, { patchPath: path })
    // Per-session routing is node-side, so a headless profile still routes;
    // only the browser controls degrade.
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopCodex')).toBeDefined()
    })
    await fiber.dispose()
  })
})
