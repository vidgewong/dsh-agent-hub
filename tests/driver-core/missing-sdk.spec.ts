/**
 * Unit tests for the shared "optional peer SDK is missing" turn error.
 *
 * The message is the only guidance a user gets at the moment an engine fails to
 * start, so it is asserted as a contract: it must name the engine, the package,
 * the pinned version, the profile-scoped install route, and the escape hatch.
 */

import { describe, expect, it } from 'vitest'
import {
  CLAUDE_CODE_SDK,
  CODEX_SDK,
  PI_SDK,
  missingSdkError,
  type EngineSdk,
} from '../../src/driver-core/missing-sdk.ts'
import pkg from '../../package.json' with { type: 'json' }

const SDKS: readonly EngineSdk[] = [CLAUDE_CODE_SDK, CODEX_SDK, PI_SDK]

describe('missingSdkError', () => {
  it('names the engine, the package, and the underlying cause', () => {
    const cause = new Error("Cannot find package '@anthropic-ai/claude-agent-sdk'")
    const error = missingSdkError(CLAUDE_CODE_SDK, cause)
    expect(error.message).toContain('the Claude Code engine requires "@anthropic-ai/claude-agent-sdk"')
    expect(error.message).toContain("Cannot find package '@anthropic-ai/claude-agent-sdk'")
  })

  it('spells out the profile-scoped install command with the pinned version', () => {
    const error = missingSdkError(CODEX_SDK, 'boom')
    expect(error.message).toContain('dsh plugin --profile <name> add @openai/codex@0.149.1')
    // The bare-pnpm-add trap is the one that actually bites, so it is stated.
    expect(error.message).toContain('pnpm add')
  })

  it('offers the no-SDK engine as an escape hatch', () => {
    const error = missingSdkError(PI_SDK, 'boom')
    expect(error.message).toContain('in-process')
  })

  it('pins every engine SDK at the version this package declares as a peer', () => {
    // A drifting version here would send users to install an SDK whose message
    // vocabulary this release was never tested against.
    const peers = pkg.peerDependencies as Record<string, string>
    for (const sdk of SDKS) {
      expect(peers[sdk.pkg]).toBe(sdk.version)
    }
  })

  it('declares every engine SDK as an optional peer', () => {
    const meta = pkg.peerDependenciesMeta as Record<string, { optional?: boolean }>
    for (const sdk of SDKS) {
      expect(meta[sdk.pkg]?.optional).toBe(true)
    }
  })
})
