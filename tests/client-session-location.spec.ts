/**
 * Where the engine switcher's new session lands.
 *
 * The rule under test is a host contract, not a preference:
 * `session.create` takes `workspaceId` **or** `cwd` and rejects both
 * (`api/session-controller/src/commands.ts:72-74`), and only the `workspaceId`
 * branch runs `workspace.attachSession` (`:96-106`). A session created with a
 * bare `cwd` therefore belongs to no workspace even when that directory *is* a
 * workspace's path — and the UI then asks the user to choose a workspace again,
 * immediately after they chose one. That shipped: picking Claude Code CLI from
 * inside a workspace dropped the user back at the workspace picker, and only
 * the default workspace appeared unaffected because a session there has no
 * membership to lose.
 *
 * @module tests/client-session-location
 */

import { describe, expect, it } from 'vitest'
import {
  sessionLocation,
  type SessionListLike,
  type WorkspaceViewLike,
} from '../src/client/session-location.ts'

/** A snapshot with one open session sitting in `/w/project`. */
const inProject: SessionListLike = {
  current: 's1',
  byId: { s1: { cwd: '/w/project' } },
}

/** That directory's workspace, which owns the open session. */
const projectWorkspace: WorkspaceViewLike = {
  workspaceId: 'ws-project',
  sessionIds: ['s0', 's1'],
}

describe('sessionLocation', () => {
  it('inherits the workspace that owns the current session', () => {
    expect(sessionLocation(inProject, [projectWorkspace]))
      .toEqual({ workspaceId: 'ws-project' })
  })

  it('never sends a workspace and a directory together', () => {
    // The host rejects a request carrying both, so a "belt and braces" spread
    // of `{ workspaceId, cwd }` would fail every switch with
    // `gateway/bad-request` rather than being merely redundant.
    const location = sessionLocation(inProject, [projectWorkspace])
    expect(Object.keys(location).sort()).toEqual(['workspaceId'])
  })

  it('scans past workspaces that do not own the session', () => {
    const other: WorkspaceViewLike = { workspaceId: 'ws-other', sessionIds: ['s9'] }
    expect(sessionLocation(inProject, [other, projectWorkspace]))
      .toEqual({ workspaceId: 'ws-project' })
  })

  it('falls back to the directory when no workspace claims the session', () => {
    // The default-workspace case, and any session created outside the
    // workspace UI: there is no membership to inherit, and the directory is
    // still worth carrying so the new session opens in the same place.
    expect(sessionLocation(inProject, [])).toEqual({ cwd: '/w/project' })
  })

  it('falls back to the directory when the profile has no workspace controller', () => {
    expect(sessionLocation(inProject, undefined)).toEqual({ cwd: '/w/project' })
  })

  it('sends nothing when the session has neither a workspace nor a directory', () => {
    // The host then applies its own default cwd, which beats guessing one.
    expect(sessionLocation({ current: 's1', byId: { s1: {} } }, [])).toEqual({})
  })

  it('sends nothing when there is no open session to inherit from', () => {
    expect(sessionLocation({ current: undefined, byId: {} }, [projectWorkspace]))
      .toEqual({})
  })

  it('sends nothing when the current session is missing from the snapshot', () => {
    expect(sessionLocation({ current: 'gone', byId: {} }, [])).toEqual({})
  })
})
