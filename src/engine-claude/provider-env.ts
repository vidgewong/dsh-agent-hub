/**
 * Derive the Claude Code child's provider environment from dsh's own LLM
 * configuration, so a session reaches the same endpoint dsh itself would use.
 *
 * The alternative — re-inheriting `process.env` — only works when the host was
 * launched from a shell that already exported provider credentials. A dsh
 * started from a desktop launcher inherits none, the child falls back to the
 * CLI's own login state, and the turn dies as a 403 far from its cause. dsh
 * already knows the answer: `llm-pi-ai` holds the route's `baseURL` and the
 * name of its credential, and `credentials` resolves that name to a secret.
 * This module reads both and states the result as environment variables the
 * Agent SDK understands.
 *
 * Only the route's *transport* is derived. Which model runs is settled earlier
 * by the agent's own resolution (session choice, then `agentDefaultModel`), and
 * is passed in rather than re-read here. A route may also carry a `childEnv`
 * map, which is not derived at all but forwarded verbatim — the escape hatch
 * for what a protocol mapping cannot express.
 *
 * Everything is resolved per call. `credentials.resolve` is contractually a
 * per-call read — the store layers process env over `~/.dsh/.credentials.yaml`
 * over `.env` files, any of which may change under a long-lived host — so a
 * cached secret would outlive its source.
 *
 * @module dsh-agent-hub/engine-claude/provider-env
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * The `llm-pi-ai` provider entry this module reads.
 *
 * Declared structurally rather than imported: taking a peer dependency on
 * `@deepseek-ai/dsh-llm-pi-ai` to name two fields would make a profile that
 * routes some other way fail to install. The full entry carries ~20 more
 * fields (protocol, retry policy, image budgets); none bear on transport.
 */
interface PiAiProviderProfile {
  /** Endpoint the route talks to, overriding the catalog provider's default. */
  readonly baseURL?: string
  /**
   * Name of the credential holding this route's key. Not necessarily an
   * environment variable despite the name: it is a lookup key into the
   * credentials store, whose highest-priority layer happens to be the
   * process environment.
   */
  readonly apiKeyEnv?: string
  /**
   * Wire protocol, when the route declares one. Absent for a catalog route
   * like `amazon-bedrock`, which inherits its provider's own protocol —
   * which is exactly the case this module must recognize.
   */
  readonly api?: string
  /** Extra HTTP headers the route sends; forwarded to the child when present. */
  readonly headers?: Record<string, string>
  /**
   * Extra environment entries for the child, for this route only.
   *
   * Not a pi-ai field. `llm-pi-ai` validates its section against a schema whose
   * 22 keys this is not among, but Schemastery preserves unknown keys rather
   * than stripping them, so a route may carry one and every route that does not
   * simply leaves it undefined.
   *
   * It exists because a route's transport can need more than its protocol says.
   * An endpoint behind a private CA needs `NODE_TLS_REJECT_UNAUTHORIZED`, and
   * the only places to put it today are the launching shell or the plugin's own
   * `env` — both of which are process-wide, so pointing one route at a
   * corporate gateway would disable certificate verification for every other
   * route the host talks to, including public ones. Keyed to the route, it
   * applies exactly where it was asked for.
   *
   * Values are laid over the derived ones, so a route can also correct a
   * mapping this module got wrong for it.
   */
  readonly childEnv?: Record<string, string>
}

/** The `llm-pi-ai` settings section. */
interface PiAiSettings {
  readonly providers?: Record<string, PiAiProviderProfile>
}

/** The subset of `ctx.settings` used to read another plugin's namespace. */
interface SettingsLike {
  get(ns: string): unknown
}

/** The subset of `ctx.credentials` used to resolve a route's key. */
interface CredentialsLike {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

/**
 * Provider ids whose transport is AWS Bedrock. The id is not a free label: it
 * selects a pi-ai catalog provider, and `amazon-bedrock`'s catalog entry pins
 * the Bedrock Converse wire protocol. Claude Code speaks the same protocol
 * behind `CLAUDE_CODE_USE_BEDROCK`, so the two line up.
 */
const BEDROCK_PROVIDER_IDS = new Set(['amazon-bedrock'])

/**
 * Provider ids that speak the native Anthropic Messages protocol, which the
 * CLI reaches through `ANTHROPIC_BASE_URL` instead.
 */
const ANTHROPIC_PROVIDER_IDS = new Set(['anthropic'])

/** How a resolved route is carried to the child. */
export interface ProviderEnv {
  /** Environment entries to lay over the child's environment. */
  readonly env: Record<string, string>
  /** One line naming the route, for the session log. */
  readonly diagnostic: string
}

/**
 * Read one provider route out of dsh's `llm-pi-ai` settings.
 *
 * `ctx.get` rather than `inject`: a profile need not mount settings at all, and
 * a route this plugin cannot read is a fallback, not a failure.
 *
 * @param ctx - context to resolve the settings service through.
 * @param provider - the route id, as named by the model selection.
 * @returns the route's profile, or undefined when unavailable.
 */
function readProviderProfile(ctx: Context, provider: string): PiAiProviderProfile | undefined {
  const settings = ctx.get('settings') as SettingsLike | undefined
  if (settings === undefined) return undefined
  const section = settings.get('llm-pi-ai') as PiAiSettings | undefined
  return section?.providers?.[provider]
}

/**
 * Map a resolved route onto the environment variables the Agent SDK reads.
 *
 * The two supported shapes are the two the CLI can actually reach. A Bedrock
 * route becomes `CLAUDE_CODE_USE_BEDROCK` plus an explicit endpoint and a
 * bearer token — the bearer is what makes a corporate gateway work, since
 * supplying one switches the AWS client off SigV4 signing, which such a
 * gateway does not implement. An Anthropic route becomes `ANTHROPIC_BASE_URL`
 * plus an auth token.
 *
 * A route of neither kind yields nothing: the OpenAI-protocol providers dsh
 * also supports have no Claude Code equivalent, and inventing one would point
 * the child at an endpoint that cannot answer it.
 *
 * The route's own `childEnv` is laid over both shapes last, so it can add what
 * the protocol mapping cannot express and correct what it got wrong.
 *
 * @param provider - the route id.
 * @param profile - the route's settings entry.
 * @param key - the resolved credential value.
 * @returns environment entries, or undefined when the route has no CLI equivalent.
 */
function mapRouteToEnv(
  provider: string,
  profile: PiAiProviderProfile,
  key: string,
): Record<string, string> | undefined {
  const headers = profile.headers ?? {}
  const extra = profile.childEnv ?? {}
  if (BEDROCK_PROVIDER_IDS.has(provider)) {
    return {
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_BEARER_TOKEN_BEDROCK: key,
      ...profile.baseURL === undefined ? {} : { ANTHROPIC_BEDROCK_BASE_URL: profile.baseURL },
      // The SDK's Bedrock client requires a region even when the endpoint is
      // explicit and the gateway ignores it; without one the client refuses to
      // construct. A route pointing at a corporate gateway has no real region,
      // so this is a placeholder the endpoint override makes irrelevant.
      ...'AWS_REGION' in headers ? {} : { AWS_REGION: 'us-east-1' },
      ...extra,
    }
  }
  if (ANTHROPIC_PROVIDER_IDS.has(provider) || profile.api === 'anthropic-messages') {
    return {
      ANTHROPIC_AUTH_TOKEN: key,
      ...profile.baseURL === undefined ? {} : { ANTHROPIC_BASE_URL: profile.baseURL },
      ...extra,
    }
  }
  return undefined
}

/**
 * Build the child's provider environment from the route the selected model
 * belongs to.
 *
 * Returns undefined — leaving the caller's existing behavior intact — whenever
 * the route cannot be derived: no provider named, settings or credentials
 * absent, the route unconfigured, its credential unset, or its protocol one the
 * CLI cannot speak. Each of those is a profile that legitimately routes some
 * other way, so none is an error here; the caller still falls back to inherited
 * environment, and `backendDiagnostic` still reports when that leaves the child
 * with nothing.
 *
 * @param ctx - context to resolve `settings` and `credentials` through.
 * @param provider - route id from the resolved model selection.
 * @returns the environment overlay and a diagnostic, or undefined.
 */
export async function deriveProviderEnv(
  ctx: Context,
  provider: string | undefined,
): Promise<ProviderEnv | undefined> {
  if (provider === undefined) return undefined
  const profile = readProviderProfile(ctx, provider)
  if (profile === undefined) return undefined
  const ref = profile.apiKeyEnv
  if (ref === undefined) return undefined

  const credentials = ctx.get('credentials') as CredentialsLike | undefined
  if (credentials === undefined) return undefined
  let key: string | undefined
  try {
    key = (await credentials.resolve(ref))?.value
  } catch (error: unknown) {
    ctx.logger.warn('claude-code: credential "%s" could not be resolved: %s', ref, error)
    return undefined
  }
  if (key === undefined || key === '') return undefined

  const env = mapRouteToEnv(provider, profile, key)
  if (env === undefined) return undefined
  // Names only. This line is appended to the session log, and a route's
  // `childEnv` is operator-supplied — it may hold a token as readily as a TLS
  // switch, and the log is not the place to find out which.
  const extra = Object.keys(profile.childEnv ?? {})
  return {
    env,
    diagnostic: `claude-code: routing to dsh provider "${provider}"`
      + `${profile.baseURL === undefined ? '' : ` at ${profile.baseURL}`}`
      + ` (credential ${ref})`
      + `${extra.length === 0 ? '' : `; route env ${extra.join(', ')}`}`,
  }
}
