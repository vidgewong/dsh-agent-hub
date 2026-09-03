/**
 * One shared phrasing for "this engine's optional peer SDK is not installed".
 *
 * Every hosted engine keeps its SDK as an optional peer, so a profile installs
 * only the engines it actually uses. The failure therefore has to name the fix,
 * not just the symptom: the raw ERR_MODULE_NOT_FOUND says which specifier could
 * not be resolved but not which engine wanted it, which profile it belongs in,
 * or which version pairs with this release.
 *
 * Profiles run with `autoInstallPeers: false`, so an optional peer exists only
 * while something explicitly depends on it. That makes the *installation route*
 * part of the fix rather than a detail: a bare `pnpm add` in an unrelated
 * directory installs a package the host never resolves, and an SDK that merely
 * happens to sit in `node_modules` without a dependency edge is an orphan the
 * profile's next install prunes. So the message spells out the exact pinned
 * command that records the dependency.
 *
 * @module dsh-agent-hub/driver-core/missing-sdk
 */

/** Identity of one engine's optional peer SDK, as declared in `peerDependencies`. */
export interface EngineSdk {
  /** Human-facing engine name used to open the sentence. */
  readonly engine: string
  /** npm package specifier of the optional peer. */
  readonly pkg: string
  /** Exact version this release pins in `peerDependencies`. */
  readonly version: string
}

/** The Claude Code engine's optional peer. */
export const CLAUDE_CODE_SDK: EngineSdk = {
  engine: 'Claude Code',
  pkg: '@anthropic-ai/claude-agent-sdk',
  version: '0.3.220',
}

/** The Codex engine's optional peer. */
export const CODEX_SDK: EngineSdk = {
  engine: 'Codex',
  pkg: '@openai/codex',
  version: '0.149.1',
}

/** The Pi engine's optional peer. */
export const PI_SDK: EngineSdk = {
  engine: 'Pi',
  pkg: '@earendil-works/pi-coding-agent',
  version: '0.84.3',
}

/**
 * Build the turn error for an engine whose SDK could not be resolved.
 * @param sdk - the engine's optional peer identity.
 * @param cause - the underlying resolution failure, appended for diagnosis.
 * @returns an error naming the engine, the exact install command, and the cause.
 */
export function missingSdkError(sdk: EngineSdk, cause: unknown): Error {
  return new Error(
    `the ${sdk.engine} engine requires "${sdk.pkg}", which is not installed in this `
    + 'profile. Install it into the profile that runs dsh (a bare "pnpm add" elsewhere '
    + 'will not be resolved), then restart dsh:\n'
    + `  dsh plugin --profile <name> add ${sdk.pkg}@${sdk.version}\n`
    + 'Or pick another engine for this session — "in-process" needs no SDK. '
    + `(${String(cause)})`,
  )
}
