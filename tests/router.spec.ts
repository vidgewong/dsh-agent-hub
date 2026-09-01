/**
 * Router and service-shadow tests: the seam that lets four engines share the
 * harness's single AgentFactory slot.
 * @module tests/router
 */

import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentFactory, AgentHandle } from '@deepseek-ai/dsh-agent'
import { LoopEngineRouter, shadowAgents, shadowSystemPrompt } from '../src/router.ts'
import type { LoopEngineId } from '../src/settings.ts'

/** A factory stand-in that records the ownerCtx and options it was handed. */
function stubFactory(tag: string): AgentFactory & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    async createAgent(ownerCtx, options) {
      calls.push({ op: 'create', ownerCtx, options })
      return { agent: { tag } as never, dispose: async () => {} } as AgentHandle
    },
    async resume(ownerCtx, options) {
      calls.push({ op: 'resume', ownerCtx, options })
      return { agent: { tag } as never, dispose: async () => {} } as AgentHandle
    },
  }
}

function routerWith(
  overrides: Partial<ConstructorParameters<typeof LoopEngineRouter>[0]> = {},
): LoopEngineRouter {
  return new LoopEngineRouter({
    engineForNewSession: () => 'codex',
    remember: async () => {},
    resolve: () => 'in-process',
    ...overrides,
  })
}

describe('shadowAgents', () => {
  it('captures setFactory and forwards every other member', () => {
    const captured: AgentFactory[] = []
    const real = {
      setFactory: vi.fn(() => () => {}),
      announce: vi.fn(() => 'announced'),
      label: 'real',
    }
    const shadow = shadowAgents(real, (factory) => {
      captured.push(factory)
      return () => {}
    })

    const factory = stubFactory('a')
    shadow.setFactory(factory)

    expect(captured).toEqual([factory])
    // The real slot is never touched, so the host registration stays free for
    // the router itself.
    expect(real.setFactory).not.toHaveBeenCalled()
    expect((shadow as unknown as { announce(): string }).announce()).toBe('announced')
    expect((shadow as unknown as { label: string }).label).toBe('real')
  })

  it('binds forwarded methods to the target so private state resolves', () => {
    class Registry {
      #secret = 'private'
      setFactory(): () => void { return () => {} }
      read(): string { return this.#secret }
    }
    const shadow = shadowAgents(new Registry(), () => () => {})
    // An unbound method invoked with the proxy as receiver would throw on the
    // private-field brand check.
    expect(shadow.read()).toBe('private')
  })

  it('lets an unmodified Service engine register through the shadow', async () => {
    const root = new Context()
    const captured: AgentFactory[] = []
    const real = { setFactory: () => () => {} }
    root.provide('agents', real as never, true)

    // Mimics the engines verbatim: a Service whose constructor calls
    // ctx.agents.setFactory(this) inside an effect.
    class FakeLoop extends Service {
      constructor(ctx: Context) {
        super(ctx, 'fakeLoop')
        ctx.effect(() => ctx.agents.setFactory(this as never), 'fakeLoop.setFactory()')
      }
    }

    const shadowed = root.extend({
      agents: shadowAgents(real, (factory) => {
        captured.push(factory)
        return () => {}
      }),
    })
    const fiber = shadowed.plugin(FakeLoop)
    await fiber

    expect(captured).toHaveLength(1)
    expect(captured[0]).toBeInstanceOf(FakeLoop)
  })
})

describe('shadowSystemPrompt', () => {
  it('registers a variable the first claimant wins and forwards the disposer', () => {
    const dispose = (): void => {}
    const real = { variable: vi.fn(() => dispose) }
    const claimed = new Set<string>()
    const shadow = shadowSystemPrompt(real, (name) => {
      if (claimed.has(name)) return false
      claimed.add(name)
      return true
    })

    const provider = (): string => 'anthropic'
    expect(shadow.variable('provider', provider)).toBe(dispose)
    expect(real.variable).toHaveBeenCalledWith('provider', provider)
  })

  it('drops a name a sibling engine already claimed instead of throwing', () => {
    // The real service throws `prompt variable "provider" is already
    // registered`; hosting four engines makes that collision certain, so the
    // shadow must absorb it and hand back a no-op disposer.
    const real = {
      variable: vi.fn((name: string) => {
        throw new Error(`prompt variable "${name}" is already registered`)
      }) as unknown as (name: string, provider: (context: unknown) => string | undefined) => () => void,
    }
    const shadow = shadowSystemPrompt(real, () => false)

    const disposer = shadow.variable('provider', () => 'x')
    expect(real.variable).not.toHaveBeenCalled()
    // The disposer must still be callable: the engine stores it in an effect.
    expect(() => disposer()).not.toThrow()
  })

  it('forwards every other member, binding methods to the target', () => {
    class Prompt {
      #persona = 'deployment'
      variable(): () => void { return () => {} }
      assemble(): string { return this.#persona }
      readonly label = 'real'
    }
    const shadow = shadowSystemPrompt(new Prompt(), () => true)

    // An unbound method invoked with the proxy as receiver would throw on the
    // private-field brand check.
    expect(shadow.assemble()).toBe('deployment')
    expect(shadow.label).toBe('real')
  })
})

describe('LoopEngineRouter dispatch', () => {
  it('creates on the engine selected for new sessions', async () => {
    const router = routerWith({ engineForNewSession: () => 'codex' })
    const codex = stubFactory('codex')
    router.register('codex', codex)
    router.register('pi', stubFactory('pi'))

    const ownerCtx = { marker: 'owner' } as unknown as Context
    await router.createAgent(ownerCtx, { sessionId: 's1' as never })

    expect(codex.calls).toHaveLength(1)
    // The ownerCtx must pass through verbatim: the factory contract requires
    // the engine to attach lifecycle to the caller's context.
    expect((codex.calls[0] as { ownerCtx: unknown }).ownerCtx).toBe(ownerCtx)
  })

  it('records the engine before delegating creation', async () => {
    const order: string[] = []
    const router = routerWith({
      engineForNewSession: () => 'pi',
      remember: async () => { order.push('remember') },
    })
    router.register('pi', {
      async createAgent() {
        order.push('create')
        return { agent: {} as never, dispose: async () => {} }
      },
      async resume() { throw new Error('unused') },
    })

    await router.createAgent({} as Context, { sessionId: 's1' as never })

    // Reversed, a crash between the two would strand a session with no
    // recoverable engine.
    expect(order).toEqual(['remember', 'create'])
  })

  it('forwards the session cwd to the record', async () => {
    // The persistence backend files a session's artifact under a directory
    // keyed by its cwd. A record written from the id alone lands in the
    // `_no-cwd` bucket, where no resume ever looks — the session then silently
    // reverts to the default engine.
    const remembered: { id: string; cwd?: string }[] = []
    const router = routerWith({
      engineForNewSession: () => 'pi',
      remember: async (meta) => { remembered.push(meta) },
    })
    router.register('pi', stubFactory('pi'))

    await router.createAgent({} as Context, {
      sessionId: 's1' as never,
      meta: { cwd: '/work/project' },
    })

    expect(remembered).toEqual([{ id: 's1', cwd: '/work/project' }])
  })

  it('omits cwd from the record when the session has none', async () => {
    const remembered: { id: string; cwd?: string }[] = []
    const router = routerWith({
      engineForNewSession: () => 'pi',
      remember: async (meta) => { remembered.push(meta) },
    })
    router.register('pi', stubFactory('pi'))

    await router.createAgent({} as Context, { sessionId: 's1' as never })

    // An explicit `cwd: undefined` would not match the backend's own optional
    // field, so the key is left off entirely.
    expect(remembered).toEqual([{ id: 's1' }])
    expect('cwd' in remembered[0]!).toBe(false)
  })

  it('resumes on the engine that created the session, not the current one', async () => {
    const router = routerWith({
      engineForNewSession: () => 'claude-code',
      resolve: () => 'codex',
    })
    const codex = stubFactory('codex')
    const claude = stubFactory('claude')
    router.register('codex', codex)
    router.register('claude-code', claude)

    await router.resume({} as Context, { resumeSessionId: 's1' as never })

    expect(codex.calls).toHaveLength(1)
    expect(claude.calls).toHaveLength(0)
  })

  it('awaits an async engine resolution', async () => {
    const router = routerWith({ resolve: async () => 'pi' })
    const pi = stubFactory('pi')
    router.register('pi', pi)

    await router.resume({} as Context, { resumeSessionId: 's1' as never })

    expect(pi.calls).toHaveLength(1)
  })

  it('fails loud when the selected engine is not mounted', async () => {
    const router = routerWith({ engineForNewSession: () => 'codex' })
    router.register('pi', stubFactory('pi'))

    // A silent fallback would run the session on an engine that cannot read
    // its history — the exact defect per-session routing removes.
    await expect(router.createAgent({} as Context, { sessionId: 's1' as never }))
      .rejects.toThrow(/engine "codex" is not mounted \(mounted: pi\)/)
  })

  it('names no mounted engines when the map is empty', async () => {
    const router = routerWith({ resolve: () => 'in-process' })
    await expect(router.resume({} as Context, { resumeSessionId: 's1' as never }))
      .rejects.toThrow(/mounted: none/)
  })

  it('withdraws a candidate on dispose and ignores a stale disposer', async () => {
    const router = routerWith({ engineForNewSession: () => 'pi' })
    const first = stubFactory('first')
    const dispose = router.register('pi', first)
    const second = stubFactory('second')
    router.register('pi', second)

    // The stale disposer must not evict the newer registration.
    dispose()
    await router.createAgent({} as Context, { sessionId: 's1' as never })
    expect(second.calls).toHaveLength(1)

    router.register('pi', second)
    const live = router.register('pi', second)
    live()
    await expect(router.createAgent({} as Context, { sessionId: 's2' as never }))
      .rejects.toThrow(/not mounted/)
  })

  it('shadowFor routes an engine registration into the router', async () => {
    const router = routerWith({ engineForNewSession: () => 'codex' })
    const real = { setFactory: vi.fn(() => () => {}) }
    const codex = stubFactory('codex')

    router.shadowFor('codex', real).setFactory(codex)

    await router.createAgent({} as Context, { sessionId: 's1' as never })
    expect(codex.calls).toHaveLength(1)
    expect(real.setFactory).not.toHaveBeenCalled()
  })
})

describe('LoopEngineRouter reservations', () => {
  it('creates on the reserved engine instead of the profile default', async () => {
    // The defect this fixes: agent creation is eager (it fires at session-open),
    // so a client cannot choose an engine after the fact. It reserves one for an
    // id it mints, then asks for that id to be created.
    const router = routerWith({ engineForNewSession: () => 'in-process' })
    const codex = stubFactory('codex')
    const base = stubFactory('base')
    router.register('codex', codex)
    router.register('in-process', base)

    router.reserve('s1', 'codex')
    await router.createAgent({} as Context, { sessionId: 's1' as never })

    expect(codex.calls).toHaveLength(1)
    expect(base.calls).toHaveLength(0)
  })

  it('records the reserved engine, not the default', async () => {
    const remembered: [string, LoopEngineId][] = []
    const router = routerWith({
      engineForNewSession: () => 'in-process',
      remember: async (meta, engine) => { remembered.push([meta.id, engine]) },
    })
    router.register('pi', stubFactory('pi'))

    router.reserve('s1', 'pi')
    await router.createAgent({} as Context, { sessionId: 's1' as never })

    // The sidecar is what every later resume reads; a default written here
    // would send the session to the wrong engine forever.
    expect(remembered).toEqual([['s1', 'pi']])
  })

  it('leaves an unreserved session on the profile default', async () => {
    const router = routerWith({ engineForNewSession: () => 'codex' })
    const codex = stubFactory('codex')
    router.register('codex', codex)
    router.register('pi', stubFactory('pi'))

    router.reserve('other', 'pi')
    await router.createAgent({} as Context, { sessionId: 's1' as never })

    expect(codex.calls).toHaveLength(1)
  })

  it('consumes a reservation so it cannot bind a later session', async () => {
    const router = routerWith({ engineForNewSession: () => 'in-process' })
    const pi = stubFactory('pi')
    const base = stubFactory('base')
    router.register('pi', pi)
    router.register('in-process', base)

    router.reserve('s1', 'pi')
    await router.createAgent({} as Context, { sessionId: 's1' as never })
    // Session ids are unique in practice, but a consumed reservation must not
    // linger: it would silently outrank the default for a reused id.
    await router.createAgent({} as Context, { sessionId: 's1' as never })

    expect(pi.calls).toHaveLength(1)
    expect(base.calls).toHaveLength(1)
  })

  it('lets a repeated reservation replace the earlier one', async () => {
    const router = routerWith({ engineForNewSession: () => 'in-process' })
    const codex = stubFactory('codex')
    router.register('codex', codex)
    router.register('pi', stubFactory('pi'))

    // A user changing their mind before the session exists.
    router.reserve('s1', 'pi')
    router.reserve('s1', 'codex')
    await router.createAgent({} as Context, { sessionId: 's1' as never })

    expect(codex.calls).toHaveLength(1)
  })

  it('evicts the oldest reservation past the bound', async () => {
    const router = routerWith({ engineForNewSession: () => 'in-process' })
    const pi = stubFactory('pi')
    const base = stubFactory('base')
    router.register('pi', pi)
    router.register('in-process', base)

    // Reservations are normally claimed immediately; the bound only guards the
    // degenerate case of picking repeatedly without ever creating a session.
    router.reserve('oldest', 'pi')
    for (let index = 0; index < 64; index += 1) router.reserve(`s${index}`, 'pi')

    await router.createAgent({} as Context, { sessionId: 'oldest' as never })
    expect(base.calls).toHaveLength(1)

    await router.createAgent({} as Context, { sessionId: 's63' as never })
    expect(pi.calls).toHaveLength(1)
  })
})

describe('LoopEngineRouter setup decoration', () => {
  it('passes setup through untouched when no decorator is configured', async () => {
    const router = routerWith({ engineForNewSession: () => 'pi' })
    const pi = stubFactory('pi')
    router.register('pi', pi)
    const setup = (): void => {}

    await router.createAgent({} as Context, { sessionId: 's1' as never, setup })

    expect((pi.calls[0] as { options: { setup: unknown } }).options.setup).toBe(setup)
  })

  it('omits setup entirely when the caller supplied none', async () => {
    const router = routerWith({ engineForNewSession: () => 'pi' })
    const pi = stubFactory('pi')
    router.register('pi', pi)

    await router.createAgent({} as Context, { sessionId: 's1' as never })

    expect((pi.calls[0] as { options: Record<string, unknown> }).options)
      .not.toHaveProperty('setup')
  })

  it('decorates with the engine and agent context, then runs the caller setup', async () => {
    const seen: [LoopEngineId, unknown][] = []
    const order: string[] = []
    const router = routerWith({
      engineForNewSession: () => 'codex',
      decorateSetup: (engine, agentCtx) => {
        seen.push([engine, agentCtx])
        order.push('decorate')
      },
    })
    const agentCtx = { tag: 'agent-scope' } as unknown as Context
    router.register('codex', {
      async createAgent(_owner, options) {
        // Engines invoke setup with the scope-tagged agent context; that is
        // what makes per-agent skill registration land in the right layer.
        await options.setup?.(agentCtx)
        return { agent: {} as never, dispose: async () => {} }
      },
      async resume() { throw new Error('unused') },
    })

    await router.createAgent({} as Context, {
      sessionId: 's1' as never,
      setup: () => { order.push('caller') },
    })

    expect(seen).toEqual([['codex', agentCtx]])
    expect(order).toEqual(['decorate', 'caller'])
  })

  it('decorates resume even when the caller passed no setup', async () => {
    const seen: LoopEngineId[] = []
    const router = routerWith({
      resolve: () => 'claude-code',
      decorateSetup: (engine) => { seen.push(engine) },
    })
    router.register('claude-code', {
      async createAgent() { throw new Error('unused') },
      async resume(_owner, options) {
        await options.setup?.({} as Context)
        return { agent: {} as never, dispose: async () => {} }
      },
    })

    await router.resume({} as Context, { resumeSessionId: 's1' as never })

    expect(seen).toEqual(['claude-code'])
  })
})
