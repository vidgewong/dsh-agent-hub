/**
 * Per-session engine record tests: sidecar placement, recovery, and GC.
 * @module tests/engine-record
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { EngineRecordStore, fallbackDir, fallbackPathFor, type RecordPersistence } from '../src/engine-record.ts'

let home: string
let previousHome: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-omniloop-'))
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})

/**
 * A persistence stub owning one artifact per session, like the jsonl backend.
 *
 * It reproduces the property that made the real backend expose the routing
 * bug: the artifact path is keyed by the session's `cwd`, and a `locate` call
 * that omits it addresses the `_no-cwd` bucket instead of the session's own
 * project directory.
 */
function artifactBackend(
  dir: string,
  known: Map<string, string | undefined> = new Map(),
): RecordPersistence {
  return {
    locate: meta => ({
      kind: 'file',
      path: join(dir, meta.cwd === undefined ? '_no-cwd' : encodeURIComponent(meta.cwd), `${meta.id}.jsonl`),
    }),
    inspect: async (id) => {
      if (!known.has(id)) throw new Error(`no such session ${id}`)
      const cwd = known.get(id)
      return { meta: { id, ...cwd === undefined ? {} : { cwd } } }
    },
  }
}

/** A persistence stub with no per-session artifact, like the SQLite backend. */
function tableBackend(known: Set<string> = new Set()): RecordPersistence {
  return {
    locate: () => undefined,
    inspect: async (id) => {
      if (!known.has(id)) throw new Error(`no such session ${id}`)
      return { meta: { id } }
    },
  }
}

describe('sidecar placement', () => {
  it('writes beside the backend artifact when the backend owns one', async () => {
    const dir = join(home, 'sessions')
    await mkdir(dir, { recursive: true })
    const cwd = '/work/project'
    const store = new EngineRecordStore(() => artifactBackend(dir, new Map([['s1', cwd]])))

    await store.remember({ id: 's1', cwd }, 'codex')

    const text = await readFile(join(dir, encodeURIComponent(cwd), 's1.jsonl.loop-engine.json'), 'utf8')
    expect(JSON.parse(text)).toEqual({ engine: 'codex', sessionId: 's1' })
    expect(await store.recall('s1')).toBe('codex')
  })

  it('places the record in the session cwd directory, not the _no-cwd bucket', async () => {
    // The regression this guards: the JSONL backend groups sessions by cwd, so
    // a record written without it lands in `_no-cwd/` while the session lives
    // under its project directory. Nothing then reads it back and every resume
    // silently falls through to the in-process default.
    const dir = join(home, 'sessions')
    await mkdir(dir, { recursive: true })
    const cwd = '/work/project'
    const store = new EngineRecordStore(() => artifactBackend(dir, new Map([['s1', cwd]])))

    await store.remember({ id: 's1', cwd }, 'claude-code')

    expect(await readdir(dir)).toEqual([encodeURIComponent(cwd)])
    expect(await store.recall('s1')).toBe('claude-code')
  })

  it('falls back to the shared directory when the backend owns no artifact', async () => {
    const store = new EngineRecordStore(() => tableBackend())

    await store.remember({ id: 's1' }, 'pi')

    expect(await readFile(fallbackPathFor('s1'), 'utf8')).toContain('"engine":"pi"')
    expect(await store.recall('s1')).toBe('pi')
  })

  it('falls back when no persistence service is present at all', async () => {
    const store = new EngineRecordStore(() => undefined)

    await store.remember({ id: 's1' }, 'claude-code')

    expect(await store.recall('s1')).toBe('claude-code')
  })

  it('encodes session ids that are not path-safe', async () => {
    const store = new EngineRecordStore(() => tableBackend())

    await store.remember({ id: 'a/b' }, 'codex')

    expect(await store.recall('a/b')).toBe('codex')
    expect(await readdir(fallbackDir())).toEqual(['a%2Fb.json'])
  })

  it('replaces an existing record rather than appending', async () => {
    const store = new EngineRecordStore(() => tableBackend())

    await store.remember({ id: 's1' }, 'codex')
    await store.remember({ id: 's1' }, 'pi')

    expect(await store.recall('s1')).toBe('pi')
    // The atomic temp+rename must leave no debris behind.
    expect(await readdir(fallbackDir())).toEqual(['s1.json'])
  })
})

describe('recall', () => {
  it('defaults a session with no record to in-process', async () => {
    const store = new EngineRecordStore(() => tableBackend())
    // Sessions written before per-session routing carry no record; the base
    // loop is what an unpatched profile boots with.
    expect(await store.recall('legacy')).toBe('in-process')
  })

  it('reads a fallback record when the backend later gained an artifact path', async () => {
    const dir = join(home, 'sessions')
    await mkdir(dir, { recursive: true })
    // Written while the deployment used a table backend...
    await new EngineRecordStore(() => tableBackend()).remember({ id: 's1' }, 'pi')
    // ...read after it switched to an artifact backend.
    const store = new EngineRecordStore(() => artifactBackend(dir, new Map([['s1', '/work']])))

    expect(await store.recall('s1')).toBe('pi')
  })

  it('falls back when the backend cannot inspect the session', async () => {
    const dir = join(home, 'sessions')
    await mkdir(dir, { recursive: true })
    // The backend owns artifacts but knows nothing of this id, so the sidecar
    // path cannot be rebuilt. A lost record must cost the default engine, not
    // throw and take the whole resume down with it.
    const store = new EngineRecordStore(() => artifactBackend(dir))

    expect(await store.recall('unknown')).toBe('in-process')
  })

  it('ignores a malformed record body', async () => {
    const store = new EngineRecordStore(() => tableBackend())
    await mkdir(fallbackDir(), { recursive: true })
    await writeFile(fallbackPathFor('s1'), 'not json', 'utf8')

    expect(await store.recall('s1')).toBe('in-process')
  })

  it('ignores a record naming an unknown engine', async () => {
    const store = new EngineRecordStore(() => tableBackend())
    await mkdir(fallbackDir(), { recursive: true })
    await writeFile(fallbackPathFor('s1'), JSON.stringify({ engine: 'ancient' }), 'utf8')

    expect(await store.recall('s1')).toBe('in-process')
  })

  it('ignores a record whose body is JSON but not an object', async () => {
    const store = new EngineRecordStore(() => tableBackend())
    await mkdir(fallbackDir(), { recursive: true })
    await writeFile(fallbackPathFor('s1'), 'null', 'utf8')

    expect(await store.recall('s1')).toBe('in-process')
  })

  it('propagates a non-ENOENT read failure', async () => {
    const store = new EngineRecordStore(() => tableBackend())
    // A directory where the record file is expected surfaces EISDIR.
    await mkdir(fallbackPathFor('s1'), { recursive: true })

    await expect(store.recall('s1')).rejects.toThrow()
  })
})

describe('orphan collection', () => {
  it('removes records whose session no longer resolves', async () => {
    const live = new Set(['keep'])
    const store = new EngineRecordStore(() => tableBackend(live))
    await store.remember({ id: 'keep' }, 'codex')
    await store.remember({ id: 'gone' }, 'pi')

    expect(await store.collectOrphans()).toBe(1)
    expect(await readdir(fallbackDir())).toEqual(['keep.json'])
  })

  it('returns zero when the directory does not exist yet', async () => {
    const store = new EngineRecordStore(() => tableBackend())
    expect(await store.collectOrphans()).toBe(0)
  })

  it('skips the sweep when no persistence service is present', async () => {
    const store = new EngineRecordStore(() => undefined)
    await store.remember({ id: 's1' }, 'codex')

    // Without persistence there is no way to tell a live session from a dead
    // one, so removing anything would risk deleting a valid record.
    expect(await store.collectOrphans()).toBe(0)
    expect(await readdir(fallbackDir())).toEqual(['s1.json'])
  })

  it('ignores non-record files', async () => {
    const store = new EngineRecordStore(() => tableBackend())
    await mkdir(fallbackDir(), { recursive: true })
    await writeFile(join(fallbackDir(), 'README.txt'), 'hi', 'utf8')

    expect(await store.collectOrphans()).toBe(0)
    expect(await readdir(fallbackDir())).toEqual(['README.txt'])
  })

  it('bounds the sweep so a large history cannot stall startup', async () => {
    const store = new EngineRecordStore(() => tableBackend())
    for (const id of ['a', 'b', 'c']) await store.remember({ id }, 'codex')

    expect(await store.collectOrphans(2)).toBe(2)
    expect((await readdir(fallbackDir())).length).toBe(1)
  })

  it('propagates a non-ENOENT directory failure', async () => {
    const store = new EngineRecordStore(() => tableBackend())
    // A regular file where the record directory belongs surfaces ENOTDIR. The
    // sweep must not swallow it: a directory it cannot read is a deployment
    // fault, not an empty history.
    await mkdir(dirname(fallbackDir()), { recursive: true })
    await writeFile(fallbackDir(), 'not a directory', 'utf8')

    await expect(store.collectOrphans()).rejects.toThrow()
  })
})
