/**
 * `/loop-engine` RPC channel tests: the browser's only route to per-session
 * engine state, and the seam that makes the composer's choice reach a session
 * created after it.
 * @module tests/rpc
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createEngineRpcHandler,
  installEngineRpc,
  LOOP_ENGINE_RPC_CHANNEL,
  type ConnectionLike,
  type EngineRpcTarget,
} from '../src/rpc.ts'
import type { LoopEngineId } from '../src/settings.ts'

/** A target recording reservations, with a configurable record store. */
function stubTarget(overrides: Partial<EngineRpcTarget> = {}): EngineRpcTarget & {
  reserved: [string, LoopEngineId][]
} {
  const reserved: [string, LoopEngineId][] = []
  return {
    reserved,
    reserve: (sessionId, engine) => { reserved.push([sessionId, engine]) },
    recall: async () => 'in-process',
    fallback: () => 'in-process',
    ...overrides,
  }
}

const signal = new AbortController().signal

describe('bind', () => {
  it('reserves the engine for a session that does not exist yet', async () => {
    const target = stubTarget()
    const handler = createEngineRpcHandler(target)

    const result = await handler('bind', { sessionId: 's1', engine: 'codex' }, signal)

    expect(result).toEqual({ ok: true, value: { engine: 'codex' } })
    expect(target.reserved).toEqual([['s1', 'codex']])
  })

  it('rejects an engine outside the known set', async () => {
    const target = stubTarget()
    const handler = createEngineRpcHandler(target)

    // A wire value is untrusted input: accepting it would reserve an engine the
    // router cannot mount, failing the session at creation instead of here.
    const result = await handler('bind', { sessionId: 's1', engine: 'ancient' }, signal)

    expect(result).toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
    expect(target.reserved).toEqual([])
  })

  it('rejects a missing engine', async () => {
    const handler = createEngineRpcHandler(stubTarget())
    expect(await handler('bind', { sessionId: 's1' }, signal))
      .toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
  })
})

describe('resolve', () => {
  it('reads back the engine a session is bound to', async () => {
    const handler = createEngineRpcHandler(stubTarget({ recall: async () => 'pi' }))

    expect(await handler('resolve', { sessionId: 's1' }, signal))
      .toEqual({ ok: true, value: { engine: 'pi' } })
  })

  it('falls back to the profile default when the record cannot be read', async () => {
    // The composer showing a plausible engine beats it showing an error, and
    // the router applies the same fallback on resume.
    const handler = createEngineRpcHandler(stubTarget({
      recall: async () => { throw new Error('unreadable') },
      fallback: () => 'claude-code',
    }))

    expect(await handler('resolve', { sessionId: 's1' }, signal))
      .toEqual({ ok: true, value: { engine: 'claude-code' } })
  })
})

describe('request validation', () => {
  it.each([
    ['a missing sessionId', {}],
    ['an empty sessionId', { sessionId: '' }],
    ['a non-string sessionId', { sessionId: 7 }],
    ['a null payload', null],
    ['a primitive payload', 'nonsense'],
  ])('rejects %s', async (_label, payload) => {
    const handler = createEngineRpcHandler(stubTarget())
    expect(await handler('resolve', payload, signal))
      .toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
  })

  it('rejects an unknown endpoint', async () => {
    const handler = createEngineRpcHandler(stubTarget())
    expect(await handler('destroy', { sessionId: 's1' }, signal))
      .toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
  })
})

describe('installEngineRpc', () => {
  it('registers the plugin channel under the caller effect', () => {
    const dispose = async (): Promise<void> => {}
    // The real host reads `options.authority` on the first line of `register`,
    // so a missing third argument throws there rather than failing a type
    // check — this fake reproduces that instead of accepting any arity.
    const handle = vi.fn((_channel: string, _handler: unknown, options: { authority: string }) => {
      if (options.authority === undefined) {
        throw new TypeError("Cannot read properties of undefined (reading 'authority')")
      }
      return dispose
    })
    const connection = { rpc: { handle } } as unknown as ConnectionLike
    const effects: string[] = []

    const installed = installEngineRpc(
      connection,
      (install, label) => { effects.push(label); install() },
      stubTarget(),
    )

    expect(installed).toBe(true)
    // `trusted-host` rather than `loopback`: a dsh reached over a LAN authority
    // serves the same composer, and `loopback` would 403 the seat there.
    expect(handle).toHaveBeenCalledWith(
      LOOP_ENGINE_RPC_CHANNEL,
      expect.any(Function),
      { authority: 'trusted-host' },
    )
    expect(effects).toEqual([`loop-engine.rpc(${LOOP_ENGINE_RPC_CHANNEL})`])
  })

  it('degrades when the profile has no connection', () => {
    // Headless and SDK profiles mount no Connection. Per-session routing is
    // node-side and keeps working; only the browser controls go read-only.
    const register = vi.fn()

    expect(installEngineRpc(undefined, register, stubTarget())).toBe(false)
    expect(register).not.toHaveBeenCalled()
  })
})
