/**
 * Package-owned invariant companion for the managed patch block.
 *
 * The plugin's owned relationship is that the managed block is a permanent
 * fixed point: applying it is idempotent, it always yields the row that frees
 * the AgentFactory slot for this plugin's router, and it upgrades a legacy
 * engine-tagged block from the era when the block encoded the selection. The
 * companion asserts these against the pure transform.
 *
 * @module dsh-loop-engine/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import {
  applyManagedBlock,
  hasManagedBlock,
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  renderManagedBlock,
} from './patch-manager.ts'

const PACKAGE_NAME = 'dsh-loop-engine'

/** Cordis companion plugin name. */
export const name = 'loop-engine-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/**
 * Assert the managed-block transform is a permanent fixed point.
 * @param ctx - child context owned by this invariant registration (unused: the
 * check is pure; kept for the InvariantInstaller signature).
 * @param fail - reporter bound to the registering package name.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure): void => {
  void ctx
  const seed = '# dsh profile patch layer\n'
  /* v8 ignore start -- the checks below assert the transform's own fixed
  points; each is exercised by the patch-manager suite, and an honest failure
  only becomes reachable when that transform regresses. */
  const applied = applyManagedBlock(seed)
  if (applyManagedBlock(applied) !== applied) fail('managed-block application is not a fixed point')
  if (!hasManagedBlock(applied)) fail('managed block must be present after application')
  // The block must always disable the base loop: this plugin's router owns the
  // single AgentFactory slot in every configuration.
  if (!renderManagedBlock().includes('- id: agent-loop')) fail('managed block must disable the base agent-loop row')
  if (!renderManagedBlock().includes('disabled: true')) fail('managed block must disable, not merely target, the base row')
  // A legacy engine-tagged block must upgrade to the engine-independent one.
  const legacy = `${seed}\n${MANAGED_BLOCK_BEGIN}: codex --\n- id: agent-loop\n  disabled: true\n${MANAGED_BLOCK_END}\n`
  const upgraded = applyManagedBlock(legacy)
  if (upgraded !== applied) fail('a legacy engine-tagged block must upgrade to the permanent block')
  /* v8 ignore stop */
}

/**
 * Register the loop-engine invariant contribution.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))