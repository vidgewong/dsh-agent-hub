/**
 * Guards `dsh.client.inject` in package.json against the services the browser
 * half actually reaches for.
 *
 * These two lists live in different files and are enforced at different times,
 * which is exactly why they drift. `dsh.client.inject` feeds the `__DSH_BOOT__`
 * manifest embedded in index.html: the loader will not start this plugin's
 * client module until every listed package has loaded. The in-code
 * `ctx.inject([...])` then waits for the *services* those packages provide.
 *
 * A service missing from the manifest does not fail the build, the typecheck,
 * or any unit test — the module simply starts too early, its `ctx.inject`
 * callback never fires, and the feature is silently absent in the browser. That
 * shipped once: without `ui-conversation` and `connection`, so the composer
 * seat could never resolve an engine and read "Engine" forever. It was
 * invisible to every other check in this repo. Hence this test.
 *
 * Naming a package that has no client boot row of its own is safe but inert:
 * both the host's `orderByModuleGraph` and the browser's `arriveGraphRow`
 * (`client/modules/src/client/system.ts:165-167`) skip an inject they cannot
 * resolve to a row rather than stalling on it. `dsh-api-session-controller` is
 * such a package — the installed web build has no boot row for it at all, and
 * `sessions` reaches the page from `dsh-client-runtime`'s bundle (verified
 * against the served artifact: `provide("sessions", …)` and
 * `provide("workspaces", …)` both live there). Both controllers are declared
 * below against `dsh-client-runtime` for that reason, and the controller
 * package stays in the manifest as documentation of a real dependency rather
 * than as a load gate.
 *
 * @module tests/client-manifest
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** The repo's own manifest, read as data rather than imported. */
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { dsh?: { client?: { inject?: string[] } } }

/** The client entry's source, scanned for the services it waits on. */
const clientSource = readFileSync(
  fileURLToPath(new URL('../src/client/index.ts', import.meta.url)),
  'utf8',
)

/**
 * Service name → package that provides it, for every service the browser half
 * injects or reads off a context. Verified against the *served* bundles rather
 * than the harness checkout, because the two have drifted: the source declares
 * the controllers in their own packages
 * (`api/session-controller/src/client/sessions/service.ts:263`), but the
 * installed web build ships no boot row for either controller and provides
 * `sessions` and `workspaces` from `dsh-client-runtime`'s bundle. What gates
 * the module is the row, so the row's package is what is mapped here.
 *
 * `slots`, `locale` and `settingsScope` are covered too — they are in the
 * plugin-level `inject`, so a missing package would strand the whole module.
 */
const PROVIDERS: Readonly<Record<string, string>> = {
  slots: '@deepseek-ai/dsh-client-ui-settings',
  locale: '@deepseek-ai/dsh-client-locale',
  settingsScope: '@deepseek-ai/dsh-client-ui-settings',
  conversation: '@deepseek-ai/dsh-client-ui-conversation',
  connection: '@deepseek-ai/dsh-client-connection',
  sessions: '@deepseek-ai/dsh-client-runtime',
  workspaces: '@deepseek-ai/dsh-client-runtime',
}

/** Services named in any `inject` array or `ctx.get('...')` in the client entry. */
function servicesUsedByClient(source: string): Set<string> {
  const found = new Set<string>()
  for (const match of source.matchAll(/\.get\('([A-Za-z]+)'\)/g)) {
    found.add(match[1]!)
  }
  for (const match of source.matchAll(/inject(?:\s*=|\()\s*\[([^\]]*)\]/g)) {
    for (const name of match[1]!.matchAll(/'([A-Za-z]+)'/g)) {
      found.add(name[1]!)
    }
  }
  return found
}

describe('client boot manifest', () => {
  const declared = manifest.dsh?.client?.inject ?? []
  const used = servicesUsedByClient(clientSource)

  it('finds the services the client entry depends on', () => {
    // A sanity check on the scanner itself: if the source is refactored past
    // what these patterns match, the coverage assertion below would pass
    // vacuously and the guard would rot into a no-op.
    expect(used.size).toBeGreaterThanOrEqual(5)
    expect(used).toContain('connection')
    expect(used).toContain('sessions')
    expect(used).toContain('workspaces')
  })

  it.each([...new Set(Object.values(PROVIDERS))])(
    'gates the client module on %s',
    (pkg) => {
      expect(declared).toContain(pkg)
    },
  )

  it('declares a provider package for every service the client uses', () => {
    // The real assertion. Every service reached for in the browser must have a
    // known provider, and that provider must gate the module's boot — otherwise
    // the `ctx.inject` callback silently never runs in production.
    const unmapped = [...used].filter(name => PROVIDERS[name] === undefined)
    expect(unmapped).toEqual([])

    const ungated = [...used].filter(name => !declared.includes(PROVIDERS[name]!))
    expect(ungated).toEqual([])
  })
})
