/**
 * Regression probe for engine coexistence.
 *
 * This suite replaces the old runtime-switch symmetry probe. That probe
 * asserted a committed settings change must mount/unmount an engine in the same
 * process — the behaviour that lost a running session its factory mid-flight.
 * Under per-session routing the engines are all resident behind one router, so
 * the property to defend inverts: a switch must disturb *nothing*.
 *
 * @module tests/engine-coexistence
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { apply } from '../src/index.ts'
import { hasManagedBlock } from '../src/patch-manager.ts'
import { LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL } from '../src/namespace.ts'

const NS = LOOP_ENGINE_SETTINGS_NAMESPACE_LITERAL as SettingsNamespace

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
  while (cleanups.length > 0) await cleanups.pop()!()
  vi.restoreAllMocks()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'loop-coexist-'))
  cleanups.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  })
  return dir
}

/** Every engine driver that publishes a service under its own name. */
const DRIVER_SERVICES = ['agentLoopClaudeCode', 'agentLoopCodex', 'agentLoopPi'] as const

describe('engine coexistence', () => {
  it('mounts every engine driver at once regardless of the selection', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, '# seed\n')
    const { ctx, fiber } = await boot({ [NS]: { engine: 'in-process' } })
    apply(ctx, { patchPath: path })

    // Selecting in-process no longer withholds the other drivers: they are all
    // resident so any session can be resumed on the engine that created it.
    for (const service of DRIVER_SERVICES) {
      await vi.waitFor(() => {
        expect(ctx.get(service)).toBeDefined()
      })
    }

    await fiber.dispose()
  })

  it('leaves every engine mounted across a switch in both directions', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, '# seed\n')
    const { ctx, fiber } = await boot({ [NS]: { engine: 'in-process' } })
    apply(ctx, { patchPath: path })
    await vi.waitFor(() => {
      expect(ctx.get('agentLoopClaudeCode')).toBeDefined()
    })

    // The old defect: switching engines tore one driver down and stood another
    // up, so a session still running on the outgoing engine lost its factory.
    for (const engine of ['claude-code', 'codex', 'pi', 'in-process']) {
      await ctx.settings.update(NS, { engine })
      await new Promise(resolve => setTimeout(resolve, 20))
      for (const service of DRIVER_SERVICES) expect(ctx.get(service)).toBeDefined()
    }

    await fiber.dispose()
  })

  it('never rewrites the permanent managed block when the selection changes', async () => {
    const dir = await tempDir()
    const path = join(dir, 'cordis.patch.yml')
    await writeFile(path, '# seed\n')
    const { ctx, fiber } = await boot({ [NS]: { engine: 'in-process' } })
    apply(ctx, { patchPath: path })
    await new Promise(resolve => setTimeout(resolve, 20))

    const afterBoot = await readFile(path, 'utf8')
    expect(hasManagedBlock(afterBoot)).toBe(true)

    // Engine choice is runtime state now, so it must not reach boot state:
    // the block stays byte-identical and no `dsh web` restart is implied.
    await ctx.settings.update(NS, { engine: 'codex' })
    await ctx.settings.update(NS, { engine: 'pi' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await readFile(path, 'utf8')).toBe(afterBoot)

    await fiber.dispose()
  })
})
