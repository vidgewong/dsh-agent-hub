/**
 * The `/loop-engine` Connection RPC channel: the browser's only route to the
 * node half's per-session engine state.
 *
 * Two facts about the harness make this channel necessary rather than merely
 * convenient:
 *
 *  - **Agent creation is eager.** `createAgent` fires when a session is
 *    *opened*, not when its first prompt is sent, so by the time a user can
 *    click anything in the composer the engine is already chosen. A client that
 *    wants a specific engine must therefore say so *before* creating the
 *    session — hence `bind`, which reserves an engine for a session id the
 *    client mints itself.
 *  - **The engine lives in a node-side sidecar.** Nothing in the session log,
 *    header, or settings carries it (see {@link ../engine-record.ts} for why
 *    each of those is closed), so the browser cannot read it from any existing
 *    projection — hence `resolve`.
 *
 * A custom Connection channel is the smallest seam that provides both. The
 * alternative, a `@Remote` service on the typert gateway, would work on the
 * host but requires hand-written strict zod descriptors on the client
 * (`requireStrictDescriptor` rejects reflection-derived ones), which is a large
 * contract surface for two internal methods. This plugin owns both ends of this
 * channel, so it validates its own payloads and needs no codec at all.
 *
 * @module dsh-agent-hub/rpc
 */

import { LOOP_ENGINE_IDS, type LoopEngineId } from './settings.ts'

/** Channel path this plugin owns. Reserved names (`/api`) are refused by the host. */
export const LOOP_ENGINE_RPC_CHANNEL = '/loop-engine'

/** Carrier-neutral result shape the Connection RPC transport expects back. */
export type RpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }

/** One logical endpoint handler, as `connection.rpc.handle` supplies it. */
export type RpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<RpcResult<unknown>>

/**
 * Trust fence the host applies before a request reaches this channel's handler.
 *
 * `trusted-host` accepts any authority in the deployment's configured
 * `trustedHosts`; `loopback` narrows to loopback only. This channel takes
 * `trusted-host` because it must work wherever the composer works — a dsh
 * reachable over a LAN authority serves the same UI, and a stricter fence would
 * 403 the seat's own requests on exactly those deployments.
 */
export type ConnectionRpcAuthority = 'trusted-host' | 'loopback'

/** Registration policy `rpc.handle` requires for a channel. */
export interface ConnectionRpcHandlerOptions {
  /** Browser authority accepted by every endpoint in this channel. */
  readonly authority: ConnectionRpcAuthority
}

/**
 * The host Connection surface this module borrows. Declared structurally so the
 * plugin needs no peer dependency on the connection package, and so a profile
 * without a Connection (headless, SDK) degrades instead of failing to mount.
 *
 * `options` is **required**, and getting that wrong fails in a way worth
 * spelling out: the host reads `options.authority` on the first line of
 * `register`, so omitting the argument throws `Cannot read properties of
 * undefined (reading 'authority')` *inside the effect*. Cordis swallows that
 * into the fiber, the plugin keeps running, every engine still works — and the
 * route is simply never added, so every request to the channel falls through to
 * the plugin-bundle server and comes back 405. Nothing logs at the default
 * level. Structural typing is what let this compile: the declaration below is
 * the plugin's own, so it cannot disagree with the installed package unless it
 * is kept in step with it by hand.
 */
export interface ConnectionLike {
  readonly rpc: {
    handle(
      channel: string,
      handler: RpcHandler,
      options: ConnectionRpcHandlerOptions,
    ): () => Promise<void>
  }
}

/** The router operations this channel drives. */
export interface EngineRpcTarget {
  /** Claim an engine for a session id the client is about to create. */
  reserve(sessionId: string, engine: LoopEngineId): void
  /** Read back the engine a session is actually bound to. */
  recall(sessionId: string): Promise<LoopEngineId>
  /** The profile default, for a session that has no record yet. */
  fallback(): LoopEngineId
}

/** Reject a malformed request the same way the gateway would. */
function badRequest(message: string): RpcResult<never> {
  return { ok: false, error: { code: 'gateway/bad-request', message, details: {} } }
}

/** Read a non-empty string field, or undefined when it is absent or the wrong type. */
function stringField(payload: unknown, field: string): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = (payload as Record<string, unknown>)[field]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Narrow an arbitrary wire string to a known engine id. */
function engineField(payload: unknown): LoopEngineId | undefined {
  const value = stringField(payload, 'engine')
  return LOOP_ENGINE_IDS.find(id => id === value)
}

/**
 * Build the `/loop-engine` handler.
 *
 * Exported separately from {@link installEngineRpc} so the endpoints are
 * testable without a Connection.
 *
 * @param target - the router and record store operations to drive.
 * @returns the handler to register on the channel.
 */
export function createEngineRpcHandler(target: EngineRpcTarget): RpcHandler {
  return async (endpoint, payload) => {
    const sessionId = stringField(payload, 'sessionId')
    if (sessionId === undefined) return badRequest(`${endpoint}: sessionId must be a non-empty string`)

    switch (endpoint) {
      case 'bind': {
        const engine = engineField(payload)
        if (engine === undefined) {
          return badRequest(`bind: engine must be one of ${LOOP_ENGINE_IDS.join(', ')}`)
        }
        target.reserve(sessionId, engine)
        return { ok: true, value: { engine } }
      }
      case 'resolve': {
        // A session created before this plugin, or one whose record was lost,
        // reads as the profile default rather than failing the call: the
        // composer showing the wrong-but-plausible engine beats it showing an
        // error, and the router applies the same fallback on resume.
        const engine = await target.recall(sessionId).catch(() => target.fallback())
        return { ok: true, value: { engine } }
      }
      default:
        return badRequest(`unknown endpoint ${JSON.stringify(endpoint)}`)
    }
  }
}

/**
 * Register the channel when the profile has a Connection.
 *
 * The Connection is injected conditionally by the gateway, so a headless or SDK
 * profile legitimately has none. There the plugin keeps working — per-session
 * routing is a node-side property — and only the browser controls degrade.
 *
 * @param connection - the host connection, or undefined when absent.
 * @param register - installs the handler under the plugin's effect lifecycle.
 * @param target - the router and record store operations to drive.
 * @returns whether the channel was registered.
 */
export function installEngineRpc(
  connection: ConnectionLike | undefined,
  register: (install: () => () => Promise<void>, label: string) => void,
  target: EngineRpcTarget,
): boolean {
  if (connection === undefined) return false
  const handler = createEngineRpcHandler(target)
  register(
    () => connection.rpc.handle(LOOP_ENGINE_RPC_CHANNEL, handler, { authority: 'trusted-host' }),
    `loop-engine.rpc(${LOOP_ENGINE_RPC_CHANNEL})`,
  )
  return true
}
