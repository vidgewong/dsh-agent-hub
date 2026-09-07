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

/**
 * Maximum number of bind hints retained in the client. A user picking engines
 * repeatedly without navigating away cannot grow the map past this bound;
 * the oldest entries are evicted first (Map preserves insertion order).
 */
const MAX_HINTS = 32

/** Narrow an arbitrary wire value to a known engine id. */
function decodeEngine(value: unknown): LoopEngineId | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { engine } = value as { engine?: unknown }
  return LOOP_ENGINE_IDS.find(id => id === engine)
}

/** Calls the plugin's own channel, tolerating a profile that has no Connection. */
export class EngineRpc {
  /**
   * Client-side hints written by {@link bind}: when the client binds a session
   * to an engine, the answer is already known — the subsequent {@link resolve}
   * for the same session id can return it immediately without waiting for the
   * host RPC, which races the sidecar file write that `createAgent` fires
   * asynchronously.
   *
   * The map is bounded by {@link MAX_HINTS} so a page lifetime that creates
   * many sessions does not accumulate unbounded memory. It is never emptied by
   * a `resolve` hit: multiple consumers (the composer and the header badge)
   * share one `EngineRpc` instance, so the first resolve must not steal the
   * hint from the second.
   */
  private readonly hints = new Map<string, LoopEngineId>()

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
   * On success the engine is also cached as a client-side hint so the
   * immediately following {@link resolve} (fired by the composer's
   * `useEffect` when the session id changes) returns the engine without a
   * round trip — closing the race between `sessions.open` and the host's
   * asynchronous sidecar write.
   *
   * @param sessionId - id the caller will pass to `sessions.create`.
   * @param engine - engine that session must run on.
   * @returns whether the reservation landed.
   */
  async bind(sessionId: string, engine: LoopEngineId): Promise<boolean> {
    const result = await this.call('bind', { sessionId, engine })
    if (result !== undefined) {
      this.hints.set(sessionId, engine)
      // Evict oldest entries to bound memory in a long-lived page that
      // creates many sessions without navigating away.
      for (const oldest of this.hints.keys()) {
        if (this.hints.size <= MAX_HINTS) break
        this.hints.delete(oldest)
      }
      return true
    }
    return false
  }

  /**
   * Read the engine a session is actually bound to.
   *
   * When this session was just bound via {@link bind} in the same page
   * lifetime, the client-side hint is returned immediately — the host RPC is
   * skipped entirely, avoiding the race where the sidecar file that
   * `createAgent` writes has not landed yet.
   *
   * @param sessionId - the session to look up.
   * @param signal - abort when the seat unmounts or the session changes.
   * @returns the engine, or undefined when unknown or unreachable.
   */
  async resolve(sessionId: string, signal?: AbortSignal): Promise<LoopEngineId | undefined> {
    const hint = this.hints.get(sessionId)
    if (hint !== undefined) return hint
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
