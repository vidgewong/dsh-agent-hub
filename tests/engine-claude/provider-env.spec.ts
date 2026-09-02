/**
 * Unit tests for deriving the Claude Code child's provider environment from
 * dsh's own `llm-pi-ai` settings.
 *
 * The module reads two services it does not own — `settings` and `credentials`
 * — through `ctx.get`, so a bare Context with each one provided is the whole
 * fixture. Every path out of it is a fallback rather than a failure, which is
 * what makes the negative cases worth pinning: a route that silently derives
 * nothing looks identical to one that was never configured.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { deriveProviderEnv } from '../../src/engine-claude/provider-env.ts'

/** One `llm-pi-ai` provider entry, as the settings service would return it. */
type Profile = Record<string, unknown>

/**
 * Build a context carrying the two services the module reads.
 *
 * @param providers - the `llm-pi-ai` provider table, or undefined to omit the section.
 * @param secrets - credential name to value; an absent name resolves to undefined.
 * @returns a context ready to pass to {@link deriveProviderEnv}.
 */
function harness(
  providers: Record<string, Profile> | undefined,
  secrets: Record<string, string> = { MB_KEY: 'sk-route' },
): Context {
  const ctx = new Context()
  ctx.provide('settings', {
    get: (ns: string) => ns === 'llm-pi-ai' && providers !== undefined
      ? { providers }
      : undefined,
  })
  ctx.provide('credentials', {
    resolve: (ref: string) => Promise.resolve(
      ref in secrets ? { value: secrets[ref] } : undefined,
    ),
  })
  return ctx
}

/** An Anthropic-protocol route against an explicit endpoint. */
const anthropicRoute: Profile = {
  api: 'anthropic-messages',
  baseURL: 'https://litellm.example',
  apiKeyEnv: 'MB_KEY',
}

describe('deriveProviderEnv', () => {
  it('maps an anthropic-messages route to an endpoint and a token', async () => {
    const derived = await deriveProviderEnv(harness({ mb: anthropicRoute }), 'mb')
    expect(derived?.env).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'sk-route',
      ANTHROPIC_BASE_URL: 'https://litellm.example',
    })
    expect(derived?.diagnostic).toContain('https://litellm.example')
  })

  it('maps a bedrock route to a bearer token and a placeholder region', async () => {
    // The bearer is what switches the AWS client off SigV4, which a corporate
    // gateway does not implement; the region is required for the client to
    // construct at all and the explicit endpoint makes its value irrelevant.
    const derived = await deriveProviderEnv(harness({
      'amazon-bedrock': { baseURL: 'https://gateway.example', apiKeyEnv: 'MB_KEY' },
    }), 'amazon-bedrock')
    expect(derived?.env).toEqual({
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_BEARER_TOKEN_BEDROCK: 'sk-route',
      ANTHROPIC_BEDROCK_BASE_URL: 'https://gateway.example',
      AWS_REGION: 'us-east-1',
    })
  })

  it('lays a route\'s childEnv over the derived entries', async () => {
    const derived = await deriveProviderEnv(harness({
      mb: { ...anthropicRoute, childEnv: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } },
    }), 'mb')
    expect(derived?.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://litellm.example',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    })
  })

  it('lets childEnv correct an entry the protocol mapping got wrong', async () => {
    // The placeholder region above is a guess this module makes on the route's
    // behalf. A route that knows better must be able to say so without a code
    // change here.
    const derived = await deriveProviderEnv(harness({
      'amazon-bedrock': {
        baseURL: 'https://gateway.example',
        apiKeyEnv: 'MB_KEY',
        childEnv: { AWS_REGION: 'eu-central-1' },
      },
    }), 'amazon-bedrock')
    expect(derived?.env.AWS_REGION).toBe('eu-central-1')
  })

  it('changes nothing for a route that sets no childEnv', async () => {
    const derived = await deriveProviderEnv(harness({ mb: anthropicRoute }), 'mb')
    expect(Object.keys(derived?.env ?? {}).sort())
      .toEqual(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'])
  })

  it('names a route\'s childEnv keys in the diagnostic without their values', async () => {
    // The line is appended to the session log, and childEnv is operator-supplied
    // — it may hold a token as readily as a TLS switch.
    const derived = await deriveProviderEnv(harness({
      mb: { ...anthropicRoute, childEnv: { NODE_TLS_REJECT_UNAUTHORIZED: '0', SOME_TOKEN: 'sk-secret' } },
    }), 'mb')
    expect(derived?.diagnostic).toContain('NODE_TLS_REJECT_UNAUTHORIZED')
    expect(derived?.diagnostic).toContain('SOME_TOKEN')
    expect(derived?.diagnostic).not.toContain('sk-secret')
    expect(derived?.diagnostic).not.toContain('sk-route')
  })

  it('derives nothing for a protocol the CLI cannot speak', async () => {
    // An OpenAI-protocol route has no CLI equivalent, and inventing one would
    // point the child at an endpoint that cannot answer it — including when the
    // route carries a childEnv, which must not be forwarded on its own.
    const derived = await deriveProviderEnv(harness({
      mb: {
        api: 'openai-completions',
        baseURL: 'https://litellm.example/v1',
        apiKeyEnv: 'MB_KEY',
        childEnv: { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
      },
    }), 'mb')
    expect(derived).toBeUndefined()
  })

  it('derives nothing when no provider was named', async () => {
    expect(await deriveProviderEnv(harness({ mb: anthropicRoute }), undefined)).toBeUndefined()
  })

  it('derives nothing for a route the settings do not configure', async () => {
    expect(await deriveProviderEnv(harness({ mb: anthropicRoute }), 'other')).toBeUndefined()
  })

  it('derives nothing when the route names no credential', async () => {
    const { apiKeyEnv: _omitted, ...keyless } = anthropicRoute
    expect(await deriveProviderEnv(harness({ mb: keyless }), 'mb')).toBeUndefined()
  })

  it('derives nothing when the route\'s credential is unset or empty', async () => {
    expect(await deriveProviderEnv(harness({ mb: anthropicRoute }, {}), 'mb')).toBeUndefined()
    expect(await deriveProviderEnv(harness({ mb: anthropicRoute }, { MB_KEY: '' }), 'mb')).toBeUndefined()
  })

  it('derives nothing when the settings section is absent', async () => {
    expect(await deriveProviderEnv(harness(undefined), 'mb')).toBeUndefined()
  })

  it('derives nothing when settings are not mounted at all', async () => {
    // A profile need not mount settings; a route this plugin cannot read is a
    // fallback, not a failure.
    const ctx = new Context()
    ctx.provide('credentials', { resolve: () => Promise.resolve({ value: 'sk-route' }) })
    expect(await deriveProviderEnv(ctx, 'mb')).toBeUndefined()
  })

  it('derives nothing when credentials are not mounted at all', async () => {
    const ctx = new Context()
    ctx.provide('settings', { get: () => ({ providers: { mb: anthropicRoute } }) })
    expect(await deriveProviderEnv(ctx, 'mb')).toBeUndefined()
  })

  it('warns and falls back when resolving the credential throws', async () => {
    const ctx = new Context()
    ctx.provide('settings', { get: () => ({ providers: { mb: anthropicRoute } }) })
    ctx.provide('credentials', {
      resolve: () => Promise.reject(new Error('store unreadable')),
    })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    try {
      expect(await deriveProviderEnv(ctx, 'mb')).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})
