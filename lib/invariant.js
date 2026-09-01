// src/patch-manager.ts
var MANAGED_BLOCK_BEGIN = "# -- dsh-loop-engine managed block";
var MANAGED_BLOCK_END = "# -- /dsh-loop-engine managed block --";
var END_MARKER_LINE = `${MANAGED_BLOCK_END}
`;
function renderManagedBlock() {
  return [
    `${MANAGED_BLOCK_BEGIN} --`,
    "- id: agent-loop",
    "  disabled: true",
    END_MARKER_LINE
  ].join("\n");
}
function hasManagedBlock(text) {
  return text.includes(MANAGED_BLOCK_BEGIN);
}
function managedSpan(text) {
  const begin = text.indexOf(MANAGED_BLOCK_BEGIN);
  if (begin === -1) return { head: text, tail: "", present: false, blankBefore: false };
  const afterBegin = begin + MANAGED_BLOCK_BEGIN.length;
  const endAt = text.indexOf(MANAGED_BLOCK_END, afterBegin);
  const spanEnd = endAt === -1 ? text.length : endAt + END_MARKER_LINE.length;
  const before = text.slice(0, begin);
  const blankBefore = before.endsWith("\n\n");
  return {
    head: blankBefore ? before.slice(0, -1) : before,
    tail: text.slice(spanEnd),
    present: true,
    blankBefore
  };
}
function ensureTrailingNewline(text) {
  return text.endsWith("\n") ? text : `${text}
`;
}
var EMPTY_FLOW_SEQ_RE = /^[ \t]*\[\][ \t]*$/;
function isEmptyFlowSeqDocument(text) {
  let sawEmptySeq = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (!sawEmptySeq && EMPTY_FLOW_SEQ_RE.test(line)) {
      sawEmptySeq = true;
      continue;
    }
    return false;
  }
  return sawEmptySeq;
}
function stripEmptyFlowSeq(text) {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => EMPTY_FLOW_SEQ_RE.test(line));
  lines.splice(at, 1);
  return lines.join("\n");
}
function applyManagedBlock(text) {
  const block = renderManagedBlock();
  const span = managedSpan(text);
  if (!span.present) {
    const base = ensureTrailingNewline(
      isEmptyFlowSeqDocument(text) ? stripEmptyFlowSeq(text).trimEnd() : text
    );
    return `${base}
${block}`;
  }
  return `${span.head}${span.blankBefore ? "\n" : ""}${block}${span.tail}`;
}

// src/invariant.ts
var PACKAGE_NAME = "dsh-agent-hub";
var name = "loop-engine-invariant";
var inject = ["invariants"];
var install = (ctx, fail) => {
  void ctx;
  const seed = "# dsh profile patch layer\n";
  const applied = applyManagedBlock(seed);
  if (applyManagedBlock(applied) !== applied) fail("managed-block application is not a fixed point");
  if (!hasManagedBlock(applied)) fail("managed block must be present after application");
  if (!renderManagedBlock().includes("- id: agent-loop")) fail("managed block must disable the base agent-loop row");
  if (!renderManagedBlock().includes("disabled: true")) fail("managed block must disable, not merely target, the base row");
  const legacy = `${seed}
${MANAGED_BLOCK_BEGIN}: codex --
- id: agent-loop
  disabled: true
${MANAGED_BLOCK_END}
`;
  const upgraded = applyManagedBlock(legacy);
  if (upgraded !== applied) fail("a legacy engine-tagged block must upgrade to the permanent block");
};
var apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=invariant.js.map
