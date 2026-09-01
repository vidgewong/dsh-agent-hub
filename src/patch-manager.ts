/**
 * Managed-block editing for a profile's `cordis.patch.yml`.
 *
 * The plugin owns one contiguous block inside the user's patch file, delimited
 * by a begin/end marker pair, and rewrites only that span — everything else the
 * user wrote (other patches, their comments) survives byte for byte. The
 * block's content is the loader patch that takes the loop engine over: it
 * disables the base bundle's `agent-loop` row so this plugin's factory can
 * register without colliding, because the harness admits exactly one
 * AgentFactory:
 *
 *   # -- dsh-loop-engine managed block --
 *   - id: agent-loop
 *     disabled: true
 *   # -- /dsh-loop-engine managed block --
 *
 * The block is now PERMANENT and engine-independent. Under per-session routing
 * this plugin always owns the slot — it registers a router that dispatches to
 * whichever engine a session belongs to, and it hosts the base in-process loop
 * itself as one of those engines. The block therefore no longer carries an
 * engine name and no longer changes when the user picks a different engine;
 * that choice is now runtime state, not boot state.
 *
 * All functions here are pure string transforms — file I/O and durability live
 * in the plugin's apply.
 *
 * @module dsh-loop-engine/patch-manager
 */

/** Begin marker of the plugin-managed span inside a profile patch file. */
export const MANAGED_BLOCK_BEGIN = '# -- dsh-loop-engine managed block'

/** End marker of the plugin-managed span inside a profile patch file. */
export const MANAGED_BLOCK_END = '# -- /dsh-loop-engine managed block --'

/** The block's trailing newline convention (one blank line before the end marker). */
const END_MARKER_LINE = `${MANAGED_BLOCK_END}\n`

/**
 * Render the permanent managed block. The plugin always owns the AgentFactory
 * slot, so the base `agent-loop` row is always disabled.
 */
export function renderManagedBlock(): string {
  return [
    `${MANAGED_BLOCK_BEGIN} --`,
    '- id: agent-loop',
    '  disabled: true',
    END_MARKER_LINE,
  ].join('\n')
}

/** Whether a patch-file text contains the managed block span. */
export function hasManagedBlock(text: string): boolean {
  return text.includes(MANAGED_BLOCK_BEGIN)
}

/** Split a patch-file text at the managed span; absent span means it appends. */
function managedSpan(
  text: string,
): { head: string; tail: string; present: boolean; blankBefore: boolean } {
  const begin = text.indexOf(MANAGED_BLOCK_BEGIN)
  if (begin === -1) return { head: text, tail: '', present: false, blankBefore: false }
  const afterBegin = begin + MANAGED_BLOCK_BEGIN.length
  const endAt = text.indexOf(MANAGED_BLOCK_END, afterBegin)
  const spanEnd = endAt === -1 ? text.length : endAt + END_MARKER_LINE.length
  // The plugin writes one blank line before its begin marker; preserve it when
  // removing the span so the file does not accumulate blank lines.
  const before = text.slice(0, begin)
  const blankBefore = before.endsWith('\n\n')
  return {
    head: blankBefore ? before.slice(0, -1) : before,
    tail: text.slice(spanEnd),
    present: true,
    blankBefore,
  }
}

/** Normalize a file so the managed span sits on its own lines with a blank separator. */
function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

/**
 * A line holding only an empty flow sequence — the body dsh writes into a fresh
 * profile's `cordis.patch.yml`.
 */
const EMPTY_FLOW_SEQ_RE = /^[ \t]*\[\][ \t]*$/

/**
 * Whether the text's only YAML content is an empty flow sequence (`[]`).
 * Comments and blank lines do not count as content.
 */
function isEmptyFlowSeqDocument(text: string): boolean {
  let sawEmptySeq = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (!sawEmptySeq && EMPTY_FLOW_SEQ_RE.test(line)) {
      sawEmptySeq = true
      continue
    }
    return false
  }
  return sawEmptySeq
}

/**
 * Drop the sole `[]` body, keeping every comment and blank line.
 *
 * `[]` is a complete flow-style document: appending block sequence items after
 * it is a YAML syntax error, so it has to go before a block can be written. An
 * empty list carries no information, so removing it loses nothing.
 *
 * Only ever called behind {@link isEmptyFlowSeqDocument}, which returns true
 * exactly when such a line exists, so the search always hits.
 */
function stripEmptyFlowSeq(text: string): string {
  const lines = text.split('\n')
  const at = lines.findIndex((line) => EMPTY_FLOW_SEQ_RE.test(line))
  lines.splice(at, 1)
  return lines.join('\n')
}

/**
 * Ensure the permanent managed block is present, preserving every byte outside
 * the managed span. Appends the span when absent; rewrites it in place when
 * present, which also upgrades a legacy engine-tagged marker from the era when
 * the block encoded the selected engine.
 *
 * This is a belt-and-braces layer, not the mechanism that disables the base
 * loop. Disabling `agent-loop` is a boot-time fact and only the bundle patch can
 * state it: the loader applies bundle layers while expanding entries, whereas
 * this profile layer is applied afterwards and this very write happens inside
 * apply() — by which point `AgentLoop`'s constructor has already claimed the
 * sole AgentFactory slot. The row therefore lives in this package's own
 * `cordis.patch.yml`, and what lands here merely re-disables an already-disabled
 * row, which is idempotent. It is kept so a profile that pins an older bundle,
 * or that lists `agent-loop` itself, still boots.
 *
 * The file must always parse as a top-level YAML *array*: app-boot's
 * `parsePatchList` throws `must be a top-level YAML array of loader patch
 * entries` on anything else, which fails the whole plugin tree — including this
 * plugin's own `insert` row, so no agent factory registers at all.
 *
 * A fresh profile's file is `[]`, a complete flow-style document. Block
 * sequence items cannot follow it, so the `[]` is dropped when the block goes
 * in. The reverse direction no longer exists: the block is permanent, so it is
 * never removed and can never leave a comments-only file behind.
 *
 * @param text - current patch-file text.
 * @returns the rewritten patch-file text.
 */
export function applyManagedBlock(text: string): string {
  const block = renderManagedBlock()
  const span = managedSpan(text)
  if (!span.present) {
    const base = ensureTrailingNewline(
      isEmptyFlowSeqDocument(text) ? stripEmptyFlowSeq(text).trimEnd() : text,
    )
    return `${base}\n${block}`
  }
  return `${span.head}${span.blankBefore ? '\n' : ''}${block}${span.tail}`
}
