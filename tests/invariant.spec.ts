/**
 * Invariant companion suite: the registration runs the fixed-point checks and
 * must not invoke the failure reporter for the current patch-manager.
 * @module tests/invariant
 */

import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { apply as applyInvariant } from '../src/invariant.ts'
import {
  applyManagedBlock,
  hasManagedBlock,
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
} from '../src/patch-manager.ts'

/** Minimal invariant registry: runs the installer synchronously at register. */
class FakeInvariants extends Service {
  registered: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'invariants')
  }

  register(packageName: string, installer: (ctx: Context, fail: (message: string) => never) => void): () => void {
    this.registered.push(packageName)
    // Mirror InvariantRegistry semantics: a violated check reports by throwing.
    installer(this.ctx!, fail)
    return () => {}
  }
}

function fail(message: string): never {
  throw new Error(message)
}

describe('loop-engine invariant companion', () => {
  it('registers under the package name and passes all fixed-point checks', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(FakeInvariants)
    await fiber
    const registry = ctx.get('invariants') as FakeInvariants

    const mounted = ctx.plugin({
      name: 'loop-engine-invariant',
      inject: ['invariants'],
      apply: applyInvariant,
    })
    await mounted
    expect(registry.registered).toEqual(['dsh-loop-engine'])

    await mounted.dispose()
    await fiber.dispose()
  })

  it('asserts the same fixed points the invariant checks', () => {
    // Independent restatement so a silent invariant regression is caught by
    // both the registration run and this explicit probe.
    const seed = '# dsh profile patch layer\n'
    const applied = applyManagedBlock(seed)
    expect(applyManagedBlock(applied)).toBe(applied)
    expect(hasManagedBlock(applied)).toBe(true)
    // The block is permanent and always frees the slot for the router.
    expect(applied).toContain('- id: agent-loop')
    expect(applied).toContain('disabled: true')

    // A block from the era when the marker encoded the selected engine must
    // upgrade in place, not accumulate a second block.
    const legacy = `${seed}\n${MANAGED_BLOCK_BEGIN}: codex --\n- id: agent-loop\n  disabled: true\n${MANAGED_BLOCK_END}\n`
    expect(applyManagedBlock(legacy)).toBe(applied)
  })
})