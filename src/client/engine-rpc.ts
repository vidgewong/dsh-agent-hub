/**
 * Browser half of the `/loop-engine` Connection RPC channel.
 *
 * The composer needs two things the rest of the client cannot give it: the
 * engine a session is *actually* running (it lives in a node-side sidecar, not
 * in the log, header, or settings), and a way to claim an engine for a session
 * *before* that session is created (agent creation is eager, so there is no
 * later moment). Both are one `connection.rpc.call` away.
 *
 * The Connection is provided conditionally, so every method degrades to
 * `undefined` rather than throwing when it is absent — the composer then falls
 * back to a read-only label.
 *
 * @module dsh-agent-hub/client/engine-rpc
 */

// Imported from `../namespace.ts`, not `../settings.ts`: this is a *value*
// import, and `settings.ts` imports the host-side `dsh-settings` service, which
// the browser bundle inlines. Going through the zero-import module keeps the
// client artifact free of it.
import { LOOP_ENGINE_IDS, type LoopEngineId } from '../namespace.ts'

/** Channel path, kept in sync with the node half by shared literal. */
const CHANNEL = '/loop-engine'

/** Carrier-neutral result the Connection RPC transport returns. */
type RpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/**
 * The browser Connection surface this module borrows, declared structurally so
 * the client bundle needs no value import from the connection package.
 */
export interface ConnectionLike {
  readonly rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult<unknown>>
  }
}

/** Narrow an arbitrary wire value to a known engine id. */
function decodeEngine(value: unknown): LoopEngineId | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { engine } = value as { engine?: unknown }
  return LOOP_ENGINE_IDS.find(id => id === engine)
}

/** Calls the plugin's own channel, tolerating a profile that has no Connection. */
export class EngineRpc {
  /**
   * @param connection - the browser connection, or undefined when the profile has none.
   */
  constructor(private readonly connection: ConnectionLike | undefined) {}

  /** Whether the channel is reachable; false makes the composer read-only. */
  get available(): boolean {
    return this.connection !== undefined
  }

  /**
   * Claim an engine for a session id the caller is about to create.
   *
   * Must be awaited before the session is created: the host resolves the
   * reservation inside `createAgent`, which the harness fires eagerly at
   * session-open.
   *
   * @param sessionId - id the caller will pass to `sessions.create`.
   * @param engine - engine that session must run on.
   * @returns whether the reservation landed.
   */
  async bind(sessionId: string, engine: LoopEngineId): Promise<boolean> {
    const result = await this.call('bind', { sessionId, engine })
    return result !== undefined
  }

  /**
   * Read the engine a session is actually bound to.
   * @param sessionId - the session to look up.
   * @param signal - abort when the seat unmounts or the session changes.
   * @returns the engine, or undefined when unknown or unreachable.
   */
  async resolve(sessionId: string, signal?: AbortSignal): Promise<LoopEngineId | undefined> {
    return decodeEngine(await this.call('resolve', { sessionId }, signal))
  }

  /**
   * Issue one call, folding transport and endpoint failures into `undefined`.
   *
   * A failure here is never worth breaking the composer over: the engine is a
   * label and a convenience, and the session works regardless.
   */
  private async call(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const connection = this.connection
    if (connection === undefined) return undefined
    try {
      const result = await connection.rpc.call(CHANNEL, endpoint, payload, signal)
      return result.ok ? result.value : undefined
    } catch {
      return undefined
    }
  }
}
