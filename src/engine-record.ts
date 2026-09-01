/**
 * Durable per-session engine records.
 *
 * A session's engine must survive the process, because resuming a session on
 * a different engine replays history that engine cannot act on. The harness
 * offers no writable durable slot for this:
 *
 *  - `SessionHeader.agentPreset` is owned by the agent-presets subsystem — the
 *    web controller writes it through `composeAgent()` and asserts it unchanged
 *    on resume — and `SessionHeader` has no free-form dict (its fields are
 *    closed at two `meta` literals and the SQLite column list).
 *  - A custom session event is worse than unavailable: the persistence
 *    coordinator refuses to load any log carrying a type outside the generated
 *    `KNOWN_SESSION_EVENT_TYPES` unless the envelope sets `ignorable`, which
 *    `Session.append()` provides no way to do. An out-of-repo event would make
 *    every session this plugin wrote permanently unloadable.
 *
 * So the record lives in a plugin-owned sidecar keyed by session id, written
 * with the same atomic temp+rename discipline as the managed patch file.
 *
 * @module dsh-loop-engine/engine-record
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { LOOP_ENGINE_IDS, type LoopEngineId } from './settings.ts'

/** Backend-owned artifact location, as returned by `sessionPersistence.locate`. */
export interface SessionLocation {
  readonly kind: string
  readonly path: string
}

/**
 * The session metadata `locate` reads to derive an artifact path.
 *
 * `cwd` is NOT optional decoration: the JSONL backend groups sessions into a
 * per-project directory keyed by it (`projectDir(root, cwd)`), and an
 * `undefined` cwd selects the literal `_no-cwd` bucket. Passing only `id`
 * therefore returns a path in a directory the session does not live in — the
 * sidecar is written where nothing will ever read it, and every resume falls
 * through to the `in-process` default.
 */
export interface SessionMetaLike {
  readonly id: string
  readonly cwd?: string
}

/**
 * The persistence surface the record store borrows. Declared structurally so
 * this module needs no peer dependency on the persistence package, and so a
 * profile without persistence degrades to the shared fallback directory.
 */
export interface RecordPersistence {
  locate(meta: SessionMetaLike): SessionLocation | undefined
  inspect(id: string, signal?: AbortSignal): Promise<{ meta: SessionMetaLike }>
}

/** Sidecar file extension appended beside a backend's per-session artifact. */
const SIDECAR_SUFFIX = '.loop-engine.json'

/** Fallback directory for backends with no per-session artifact (e.g. SQLite). */
export function fallbackDir(): string {
  return join(resolveDshHome(), 'loop-engine')
}

/** The fallback record path for one session id. */
export function fallbackPathFor(sessionId: string): string {
  return join(fallbackDir(), `${encodeURIComponent(sessionId)}.json`)
}

/**
 * Atomically write a small JSON file (same-directory temp + rename), mirroring
 * the managed patch file's durability discipline.
 */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${randomUUID()}`
  await writeFile(tmp, `${JSON.stringify(value)}\n`, 'utf8')
  await rename(tmp, path)
}

/** Whether an error was an ENOENT (file or directory not found). */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Parse a record body, tolerating anything a foreign writer may have left. */
function engineOf(text: string): LoopEngineId | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const engine = (parsed as { engine?: unknown } | null)?.engine
  return (LOOP_ENGINE_IDS as readonly string[]).includes(engine as string)
    ? engine as LoopEngineId
    : undefined
}

/**
 * Reads and writes the per-session engine record.
 *
 * The store prefers a sidecar beside the backend's own per-session artifact so
 * the record travels with the session; backends that own no such artifact fall
 * back to a shared directory under the dsh home.
 */
export class EngineRecordStore {
  constructor(private readonly persistence: () => RecordPersistence | undefined) {}

  /**
   * Resolve the record path for a session, preferring the backend's artifact
   * directory. Uses `locate`, which explicitly does not read, create, or
   * materialize the artifact.
   *
   * `cwd` must be supplied whenever it is known: it selects the backend's
   * per-project directory, so omitting it silently addresses a different
   * directory than the one holding the session.
   */
  private pathFor(meta: SessionMetaLike): string {
    const located = this.persistence()?.locate(meta)
    return located === undefined
      ? fallbackPathFor(meta.id)
      : `${located.path}${SIDECAR_SUFFIX}`
  }

  /**
   * Record a session's engine. Called before the engine creates the session,
   * so the record is never missing for a session that exists.
   * @param meta - the session being created, including the `cwd` that keys its artifact directory.
   * @param engine - the engine that will own it.
   */
  async remember(meta: SessionMetaLike, engine: LoopEngineId): Promise<void> {
    await writeJsonAtomic(this.pathFor(meta), { engine, sessionId: meta.id })
  }

  /**
   * Recover a session's engine.
   *
   * The session's `cwd` is not known to the caller on the resume path — only
   * its id — so the backend's own header is consulted first to rebuild the
   * artifact path. A backend that cannot inspect (or a session it does not
   * know) degrades to the shared fallback directory rather than failing the
   * resume: a lost record costs the default engine, an exception costs the
   * session.
   *
   * Sessions written before this plugin gained per-session routing carry no
   * record; they ran on whichever engine was globally selected, and the base
   * in-process loop is the only safe default — it is what an unpatched profile
   * boots with.
   * @param sessionId - the session being resumed.
   * @returns the recorded engine, or `in-process` when no record exists.
   */
  async recall(sessionId: string): Promise<LoopEngineId> {
    const candidates = [fallbackPathFor(sessionId)]
    const located = await this.locateByInspect(sessionId)
    if (located !== undefined) candidates.unshift(located)

    for (const path of candidates) {
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (error) {
        if (isMissing(error)) continue
        throw error
      }
      const engine = engineOf(text)
      if (engine !== undefined) return engine
    }
    return 'in-process'
  }

  /**
   * Rebuild a session's sidecar path from the backend's stored header.
   *
   * `inspect` is the correct probe here rather than `prepare`: it is a
   * non-exclusive borrow that returns a validated header and leaves the
   * coordinator's reusable cold session in place for the real engine's
   * subsequent `prepare`, whereas `prepare` would take the exclusive
   * reservation out from under it.
   *
   * @param sessionId - the session whose artifact directory is wanted.
   * @returns the sidecar path, or `undefined` when it cannot be derived.
   */
  private async locateByInspect(sessionId: string): Promise<string | undefined> {
    const persistence = this.persistence()
    if (persistence === undefined) return undefined
    try {
      const { meta } = await persistence.inspect(sessionId)
      const located = persistence.locate(meta)
      return located === undefined ? undefined : `${located.path}${SIDECAR_SUFFIX}`
    } catch {
      return undefined
    }
  }

  /**
   * Drop fallback records whose session no longer resolves, bounded per run so
   * a large history cannot stall startup. Sidecars beside a backend artifact
   * need no sweep: the backend removes the directory with the session.
   * @param limit - maximum number of records to examine.
   */
  async collectOrphans(limit = 200): Promise<number> {
    const dir = fallbackDir()
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (error) {
      if (isMissing(error)) return 0
      throw error
    }
    const persistence = this.persistence()
    if (persistence === undefined) return 0
    let removed = 0
    for (const entry of entries.slice(0, limit)) {
      if (!entry.endsWith('.json')) continue
      const sessionId = decodeURIComponent(entry.slice(0, -'.json'.length))
      try {
        await persistence.inspect(sessionId)
      } catch {
        await rm(join(dir, entry), { force: true })
        removed += 1
      }
    }
    return removed
  }
}
