/**
 * Pure string-transform tests for the managed patch block.
 *
 * The block is permanent and engine-independent under per-session routing:
 * this plugin always owns the AgentFactory slot, so the base `agent-loop` row
 * is always disabled and the block never encodes an engine.
 *
 * @module tests/patch-manager
 */

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  applyManagedBlock,
  hasManagedBlock,
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  renderManagedBlock,
} from '../src/patch-manager.ts'

const SEED = '# dsh profile patch layer\n'

describe('renderManagedBlock', () => {
  it('renders the permanent slot-freeing span', () => {
    const block = renderManagedBlock()
    expect(block.startsWith(`${MANAGED_BLOCK_BEGIN} --\n`)).toBe(true)
    expect(block).toContain('- id: agent-loop\n  disabled: true')
    // The engines live inside dsh-agent-hub; the block only disables the
    // base loop so the single AgentFactory slot has no collision.
    expect(block).not.toContain('agent-loop-claude-code')
    // No engine name: the selection is runtime state now, not boot state.
    expect(block).not.toMatch(/claude-code|codex|\bpi\b/)
    expect(block.endsWith(`${MANAGED_BLOCK_END}\n`)).toBe(true)
  })
})

describe('block presence', () => {
  it('detects absence', () => {
    expect(hasManagedBlock(SEED)).toBe(false)
    expect(hasManagedBlock('')).toBe(false)
  })

  it('detects presence', () => {
    expect(hasManagedBlock(`${SEED}\n${renderManagedBlock()}`)).toBe(true)
  })

  it('detects a legacy engine-tagged block', () => {
    const legacy = `${SEED}\n${MANAGED_BLOCK_BEGIN}: codex --\n- id: agent-loop\n  disabled: true\n${MANAGED_BLOCK_END}\n`
    expect(hasManagedBlock(legacy)).toBe(true)
  })
})

describe('applyManagedBlock', () => {
  it('appends the block to a file without one, preserving prior bytes', () => {
    const prior = '# my own patches\n- id: subagent-claude-code\n'
    const next = applyManagedBlock(prior)
    expect(next.startsWith(prior)).toBe(true)
    expect(next).toContain(renderManagedBlock())
  })

  it('is idempotent', () => {
    const once = applyManagedBlock(SEED)
    expect(applyManagedBlock(once)).toBe(once)
    expect(applyManagedBlock(applyManagedBlock(once))).toBe(once)
  })

  it('upgrades a legacy engine-tagged block in place', () => {
    const legacy = `${SEED}\n${MANAGED_BLOCK_BEGIN}: codex --\n- id: agent-loop\n  disabled: true\n${MANAGED_BLOCK_END}\n`
    const next = applyManagedBlock(legacy)
    // The engine name is gone, the disable row stays, and the file is still a
    // single well-formed patch list.
    expect(next).toBe(`${SEED}\n${renderManagedBlock()}`)
    expect(parse(next)).toEqual([{ id: 'agent-loop', disabled: true }])
  })

  it('upgrades a legacy in-process file (no block at all) by adding the block', () => {
    // Under the old scheme in-process meant an absent block and a live base
    // loop. The plugin now owns the slot in every case, so the block appears.
    const next = applyManagedBlock(SEED)
    expect(hasManagedBlock(next)).toBe(true)
    expect(parse(next)).toEqual([{ id: 'agent-loop', disabled: true }])
  })

  it('preserves lines after the block', () => {
    const prior = '# head\n'
    const trailer = '# tail\n- id: tool-x\n'
    const next = applyManagedBlock(`${prior}${trailer}`)
    expect(next.startsWith(`${prior}${trailer}`)).toBe(true)
    expect(hasManagedBlock(next)).toBe(true)
  })

  it('handles a file without a trailing newline', () => {
    const prior = '# head'
    const next = applyManagedBlock(prior)
    expect(next.startsWith(`${prior}\n\n${MANAGED_BLOCK_BEGIN}`)).toBe(true)
  })

  it('replaces a block that starts at file head without a blank separator', () => {
    const block = renderManagedBlock()
    expect(applyManagedBlock(block)).toBe(block)
  })

  it('treats an unterminated block (no end marker) as extending to the end', () => {
    const text = `# head\n\n${MANAGED_BLOCK_BEGIN} --\n- id: agent-loop\n  disabled: true\n`
    const next = applyManagedBlock(text)
    expect(next).toBe(`# head\n\n${renderManagedBlock()}`)
    expect(parse(next)).toEqual([{ id: 'agent-loop', disabled: true }])
  })
})

/**
 * The body dsh writes into a fresh profile's `cordis.patch.yml`: a comment
 * preamble plus an empty flow sequence. `[]` is a complete flow-style document,
 * so appending block sequence items after it is a YAML syntax error.
 */
const PROFILE_SEED = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

describe('applyManagedBlock on a real profile seed', () => {
  it('produces parseable YAML when adding a block to the `[]` seed', () => {
    const next = applyManagedBlock(PROFILE_SEED)
    expect(() => parse(next)).not.toThrow()
    expect(parse(next)).toEqual([{ id: 'agent-loop', disabled: true }])
  })

  it('keeps the comment preamble when dropping the empty sequence', () => {
    const next = applyManagedBlock(PROFILE_SEED)
    expect(next).toContain('# Your patch layer for this dsh profile')
    expect(next).not.toMatch(/^\s*\[\]\s*$/m)
  })

  it('stays a parseable array across repeated applications', () => {
    let text = PROFILE_SEED
    for (let i = 0; i < 4; i += 1) {
      text = applyManagedBlock(text)
      expect(() => parse(text)).not.toThrow()
      expect(parse(text)).toEqual([{ id: 'agent-loop', disabled: true }])
    }
  })

  it('does not disturb an `[]` that is a user entry rather than the whole body', () => {
    const withList = '# head\n- id: other\n  config: []\n'
    const next = applyManagedBlock(withList)
    expect(parse(next)).toEqual([
      { id: 'other', config: [] },
      { id: 'agent-loop', disabled: true },
    ])
  })
})
