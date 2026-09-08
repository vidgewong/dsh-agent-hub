/**
 * Where a newly created session should be placed.
 *
 * Split out of the client entry because the entry cannot be imported under
 * vitest — it pulls the composer components, which expect the browser module
 * loader — while this decision is pure and worth a regression test of its own.
 * It has no imports so the browser bundle can take it as-is.
 *
 * @module dsh-omniloop/client/session-location
 */

/** The subset of a session summary this decision reads. */
export interface SessionSummaryLike {
  readonly cwd?: string
}

/** The subset of a workspace view this decision reads. */
export interface WorkspaceViewLike {
  readonly workspaceId: string
  readonly sessionIds: readonly string[]
}

/** The `sessions.list` snapshot fields this decision reads. */
export interface SessionListLike {
  readonly current?: string
  readonly byId: Record<string, SessionSummaryLike | undefined>
}

/**
 * Location argument for `sessions.create`.
 *
 * The two fields are mutually exclusive by host contract, not by style: the
 * create command rejects a request carrying both with `gateway/bad-request`
 * (`api/session-controller/src/commands.ts:72-74`). Hence a union of two
 * one-field shapes rather than an object with both optional.
 */
export type SessionLocation =
  | { readonly workspaceId: string }
  | { readonly cwd: string }
  | Record<string, never>

/**
 * Decide where the engine switcher's new session goes.
 *
 * Workspace membership is what the user actually chose, and it is *not*
 * implied by the directory: `create` attaches a session to a workspace only on
 * the `workspaceId` branch (`commands.ts:96-106`). Passing the current
 * session's `cwd` instead therefore produces a session in the right directory
 * that belongs to no workspace, and the UI asks the user to pick a workspace
 * all over again — which is exactly the bug this function exists to prevent.
 *
 * Membership is held by the workspace rather than the session, so finding it
 * means scanning `items` for one listing the current session. That is the same
 * lookup `uiWorkspace.startSession` does
 * (`client/ui-workspace/src/client/navigation.ts:117-120`).
 *
 * `cwd` is the fallback for a session that genuinely has no workspace — a
 * default-workspace profile, or a session created outside the workspace UI —
 * not a companion to `workspaceId`.
 *
 * @param sessions - the current `sessions.list` snapshot.
 * @param workspaces - the current workspace views, or undefined when the
 *   profile mounts no workspace controller.
 * @returns the location argument to spread into `sessions.create`.
 */
export function sessionLocation(
  sessions: SessionListLike,
  workspaces: readonly WorkspaceViewLike[] | undefined,
): SessionLocation {
  const current = sessions.current
  if (current === undefined) return {}

  const workspaceId = workspaces
    ?.find(item => item.sessionIds.includes(current))?.workspaceId
  if (workspaceId !== undefined) return { workspaceId }

  const cwd = sessions.byId[current]?.cwd
  return cwd === undefined ? {} : { cwd }
}
