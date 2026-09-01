/**
 * Minimal ambient declaration for `@deepseek-ai/dsh-agent-loop`.
 *
 * The package is a peer dependency mounted behind the router as the
 * `in-process` engine, but it is not installed in this repo's node_modules —
 * it resolves against the profile's own harness line at runtime, which is also
 * why `build.mjs` keeps it external. Only the shape {@link mountBaseLoop}
 * actually uses is declared: the default-exported plugin class and the
 * `agents` field of its config.
 *
 * The constructor is what carries the config type: cordis infers a plugin's
 * config from its second constructor parameter (`GetPluginConfig`), so a class
 * declared without one types `ctx.plugin(AgentLoop, …)` as taking no config.
 */
declare module '@deepseek-ai/dsh-agent-loop' {
  import type { Context } from '@deepseek-ai/cordis'

  /** The subset of the loop's config this plugin supplies. */
  interface AgentLoopConfig {
    /**
     * Agents created at plugin startup. Always empty here: sessions are created
     * on demand through the router, never from this declarative list.
     */
    agents: unknown[]
  }

  /** The concrete agent-loop plugin, mounted through the router's shadowed context. */
  export default class AgentLoop {
    static inject: string[]
    constructor(ctx: Context, config: AgentLoopConfig)
  }
}
