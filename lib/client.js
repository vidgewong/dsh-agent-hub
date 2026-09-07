var module = { exports: {} }; var exports = module.exports; window.__ModuleLoader__.load({ id: "@vidge/dsh-agent-hub", factory: (require) => {
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/LoopEngineComposerSelect.tsx
var import_react = require("react");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

// src/client/engine-visuals.ts
var ENGINE_COLORS = {
  "in-process": "#4d6bfe",
  "claude-code": "#d97757",
  codex: "#10a37f",
  pi: "#a78bfa"
};
function engineColor(engine) {
  return engine === void 0 ? "var(--dsw-alias-label-tertiary)" : ENGINE_COLORS[engine];
}
function engineLabelKey(engine) {
  switch (engine) {
    case "claude-code":
      return "engineClaudeCode";
    case "codex":
      return "engineCodex";
    case "pi":
      return "enginePi";
    default:
      return "engineInProcess";
  }
}

// src/client/LoopEngineComposerSelect.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var ENGINE_OPTIONS = [
  { value: "in-process", key: "engineInProcess" },
  { value: "claude-code", key: "engineClaudeCode" },
  { value: "codex", key: "engineCodex" },
  { value: "pi", key: "enginePi" }
];
var dot = (color) => ({
  boxSizing: "border-box",
  width: 8,
  height: 8,
  borderRadius: 999,
  background: color,
  flex: "none",
  display: "inline-block"
});
var trigger = {
  appearance: "none",
  boxSizing: "border-box",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 8px",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 10,
  background: "var(--dsw-alias-bg-layer-1)",
  color: "var(--dsw-alias-label-primary)",
  font: "inherit",
  fontSize: 12,
  lineHeight: "20px",
  whiteSpace: "nowrap",
  cursor: "pointer"
};
var triggerBusy = { ...trigger, opacity: 0.5, cursor: "default" };
var frozen = {
  boxSizing: "border-box",
  display: "inline-flex",
  alignItems: "center",
  padding: "4px 8px",
  color: "var(--dsw-alias-label-secondary)",
  font: "inherit",
  fontSize: 12,
  lineHeight: "20px",
  whiteSpace: "nowrap"
};
function LoopEngineComposerSelect(props) {
  const { rpc, switcher, sessionId, t } = props;
  const [open, setOpen] = (0, import_react.useState)(false);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const triggerRef = (0, import_react.useRef)(null);
  const [engine, setEngine] = (0, import_react.useState)(void 0);
  const [resolving, setResolving] = (0, import_react.useState)(false);
  (0, import_react.useEffect)(() => {
    if (sessionId === void 0) {
      setEngine(void 0);
      setResolving(false);
      return;
    }
    const abort = new AbortController();
    setEngine(void 0);
    setResolving(true);
    void rpc.resolve(sessionId, abort.signal).then((resolved) => {
      if (abort.signal.aborted) return;
      setEngine(resolved);
      setResolving(false);
    });
    return () => {
      abort.abort();
    };
  }, [rpc, sessionId]);
  const label = engine !== void 0 ? t(engineLabelKey(engine)) : t(resolving ? "engineResolving" : "engineUnknown");
  const notice = engine === "claude-code" ? t("claudeModelNotice") : engine === void 0 && !resolving ? t("engineUnknownNotice") : t("switchCreatesSession");
  if (!rpc.available) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: frozen, title: t("boundNotice"), children: [
      engine !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: dot(engineColor(engine)) }),
      label
    ] });
  }
  const onSelect = (next) => {
    setOpen(false);
    const value = next;
    if (value === engine || busy) return;
    setBusy(true);
    void switcher.startSessionOn(value).then((created) => {
      if (created) setEngine(value);
    }).finally(() => {
      setBusy(false);
    });
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    import_dsh_client_ui_primitives.Menu,
    {
      open,
      onClose: () => {
        setOpen(false);
      },
      items: ENGINE_OPTIONS.map((option) => ({
        id: option.value,
        label: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { display: "inline-flex", alignItems: "center", gap: 8 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: dot(engineColor(option.value)) }),
          t(option.key)
        ] })
      })),
      selectedId: engine,
      onSelect,
      align: "start",
      portal: true,
      getAnchorRect: () => triggerRef.current?.getBoundingClientRect() ?? null,
      anchor: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
        "button",
        {
          type: "button",
          ref: triggerRef,
          "aria-haspopup": "menu",
          "aria-expanded": open,
          disabled: busy,
          style: busy ? triggerBusy : trigger,
          title: notice,
          onClick: () => {
            setOpen(!open);
          },
          children: [
            engine !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: dot(engineColor(engine)) }),
            label,
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconChevronDownOutline14, { size: 14 })
          ]
        }
      )
    }
  );
}

// src/client/LoopEngineHeaderBadge.tsx
var import_react2 = require("react");
var import_jsx_runtime2 = require("react/jsx-runtime");
var dot2 = (color) => ({
  boxSizing: "border-box",
  width: 8,
  height: 8,
  borderRadius: 999,
  background: color,
  flex: "none"
});
var badge = {
  boxSizing: "border-box",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "2px 8px",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 999,
  color: "var(--dsw-alias-label-secondary)",
  font: "inherit",
  fontSize: 12,
  lineHeight: "18px",
  whiteSpace: "nowrap"
};
function LoopEngineHeaderBadge(props) {
  const { rpc, t, sessionId } = props;
  const [engine, setEngine] = (0, import_react2.useState)(void 0);
  (0, import_react2.useEffect)(() => {
    if (sessionId === void 0 || rpc === void 0) {
      setEngine(void 0);
      return;
    }
    const abort = new AbortController();
    setEngine(void 0);
    void rpc.resolve(sessionId, abort.signal).then((resolved) => {
      if (abort.signal.aborted) return;
      setEngine(resolved);
    });
    return () => {
      abort.abort();
    };
  }, [rpc, sessionId]);
  if (engine === void 0 || t === void 0) return null;
  const notice = engine === "claude-code" ? t("claudeModelNotice") : t("boundNotice");
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: badge, title: notice, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: dot2(engineColor(engine)) }),
    t(engineLabelKey(engine))
  ] });
}

// src/client/SessionListTint.tsx
var import_react3 = require("react");

// src/namespace.ts
var LOOP_ENGINE_IDS = ["in-process", "claude-code", "codex", "pi"];

// src/client/SessionListTint.tsx
var ENGINE_ATTR = "data-loop-engine";
var TINT_PERCENT = 16;
var TINT_SELECTED_PERCENT = 40;
function tintStylesheet() {
  return LOOP_ENGINE_IDS.flatMap((engine) => {
    const color = ENGINE_COLORS[engine];
    return [
      `[${ENGINE_ATTR}="${engine}"]{background-color:color-mix(in srgb, ${color} ${TINT_PERCENT}%, transparent);box-shadow:inset 2px 0 0 0 ${color};}`,
      `[role="treeitem"][${ENGINE_ATTR}="${engine}"][aria-selected="true"]{background-color:color-mix(in srgb, ${color} ${TINT_SELECTED_PERCENT}%, transparent);box-shadow:inset 3px 0 0 0 ${color};}`
    ];
  }).join("\n");
}
function readSessionId(el) {
  try {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    if (key === void 0) return void 0;
    let fiber = el[key];
    for (let depth = 0; fiber != null && depth < 12; depth++) {
      const id = fiber.memoizedProps?.node?.id;
      if (typeof id === "string") return id;
      fiber = fiber.return;
    }
  } catch {
  }
  return void 0;
}
function SessionListTint(props) {
  const { rpc, sessions } = props;
  (0, import_react3.useEffect)(() => {
    if (rpc === void 0 || typeof document === "undefined") return;
    const style = document.createElement("style");
    style.setAttribute("data-loop-engine-tint", "");
    style.textContent = tintStylesheet();
    document.head.appendChild(style);
    const cache = /* @__PURE__ */ new Map();
    const pending = /* @__PURE__ */ new Set();
    let disposed = false;
    let frame = 0;
    const validIds = () => {
      try {
        return sessions?.list.getSnapshot().byId ?? {};
      } catch {
        return {};
      }
    };
    const apply2 = () => {
      const byId = validIds();
      const rows = document.querySelectorAll('[role="treeitem"]');
      rows.forEach((el) => {
        const id = readSessionId(el);
        if (id === void 0 || !(id in byId)) {
          if (el.hasAttribute(ENGINE_ATTR)) el.removeAttribute(ENGINE_ATTR);
          return;
        }
        const known = cache.get(id);
        if (known !== void 0) {
          if (el.getAttribute(ENGINE_ATTR) !== known) el.setAttribute(ENGINE_ATTR, known);
          return;
        }
        if (!pending.has(id)) {
          pending.add(id);
          void rpc.resolve(id).then((engine) => {
            pending.delete(id);
            if (disposed || engine === void 0) return;
            cache.set(id, engine);
            schedule();
          });
        }
      });
    };
    const schedule = () => {
      if (disposed || frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        apply2();
      });
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    const unsubscribe = sessions?.list.subscribe?.(schedule);
    apply2();
    return () => {
      disposed = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      observer.disconnect();
      unsubscribe?.();
      style.remove();
      document.querySelectorAll(`[${ENGINE_ATTR}]`).forEach((el) => el.removeAttribute(ENGINE_ATTR));
    };
  }, [rpc, sessions]);
  return null;
}

// src/client/engine-rpc.ts
var CHANNEL = "/loop-engine";
var MAX_HINTS = 32;
function decodeEngine(value) {
  if (typeof value !== "object" || value === null) return void 0;
  const { engine } = value;
  return LOOP_ENGINE_IDS.find((id) => id === engine);
}
var EngineRpc = class {
  /**
   * @param connection - the browser connection, or undefined when the profile has none.
   */
  constructor(connection) {
    this.connection = connection;
  }
  connection;
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
  hints = /* @__PURE__ */ new Map();
  /** Whether the channel is reachable; false makes the composer read-only. */
  get available() {
    return this.connection !== void 0;
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
  async bind(sessionId, engine) {
    const result = await this.call("bind", { sessionId, engine });
    if (result !== void 0) {
      this.hints.set(sessionId, engine);
      for (const oldest of this.hints.keys()) {
        if (this.hints.size <= MAX_HINTS) break;
        this.hints.delete(oldest);
      }
      return true;
    }
    return false;
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
  async resolve(sessionId, signal) {
    const hint = this.hints.get(sessionId);
    if (hint !== void 0) return hint;
    return decodeEngine(await this.call("resolve", { sessionId }, signal));
  }
  /**
   * Issue one call, folding transport and endpoint failures into `undefined`.
   *
   * A failure here is never worth breaking the composer over: the engine is a
   * label and a convenience, and the session works regardless.
   */
  async call(endpoint, payload, signal) {
    const connection = this.connection;
    if (connection === void 0) return void 0;
    try {
      const result = await connection.rpc.call(CHANNEL, endpoint, payload, signal);
      return result.ok ? result.value : void 0;
    } catch {
      return void 0;
    }
  }
};

// src/client/session-location.ts
function sessionLocation(sessions, workspaces) {
  const current = sessions.current;
  if (current === void 0) return {};
  const workspaceId = workspaces?.find((item) => item.sessionIds.includes(current))?.workspaceId;
  if (workspaceId !== void 0) return { workspaceId };
  const cwd = sessions.byId[current]?.cwd;
  return cwd === void 0 ? {} : { cwd };
}

// src/client/locales.ts
var zh = {
  engineInProcess: "DeepSeek Loop",
  engineClaudeCode: "Claude Code CLI",
  engineCodex: "Codex CLI",
  enginePi: "Pi CLI",
  switchCreatesSession: "\u5F53\u524D\u4F1A\u8BDD\u7684\u5F15\u64CE\u5728\u521B\u5EFA\u65F6\u5DF2\u56FA\u5B9A\u3002\u9009\u62E9\u5176\u5B83\u5F15\u64CE\u5C06\u7ACB\u5373\u65B0\u5EFA\u4E00\u4E2A\u4F1A\u8BDD\u5E76\u5207\u6362\u8FC7\u53BB\u3002",
  boundNotice: "\u672C\u4F1A\u8BDD\u5DF2\u7ED1\u5B9A\u8BE5\u5F15\u64CE\uFF0C\u521B\u5EFA\u540E\u4E0D\u53EF\u66F4\u6539\u3002\u8981\u6362\u5F15\u64CE\u8BF7\u65B0\u5EFA\u4F1A\u8BDD\u3002",
  engineResolving: "\u5F15\u64CE\u2026",
  engineUnknown: "\u5F15\u64CE",
  engineUnknownNotice: "\u8BFB\u53D6\u672C\u4F1A\u8BDD\u5F15\u64CE\u5931\u8D25\u3002\u9009\u62E9\u4E00\u4E2A\u5F15\u64CE\u4ECD\u53EF\u65B0\u5EFA\u4F1A\u8BDD\u5E76\u5207\u6362\u8FC7\u53BB\u3002",
  claudeModelNotice: "\u5F53\u524D\u4F7F\u7528 Claude Code \u5F15\u64CE\uFF1A\u5B9E\u9645\u6A21\u578B\u7531 Claude Code \u539F\u751F\u51B3\u5B9A\uFF0C\u9875\u9762\u4E0A\u7684\u6A21\u578B\u9009\u62E9\u4E0D\u751F\u6548\u3002"
};
var en = {
  engineInProcess: "DeepSeek Loop",
  engineClaudeCode: "Claude Code CLI",
  engineCodex: "Codex CLI",
  enginePi: "Pi CLI",
  switchCreatesSession: "This session's engine was fixed when it was created. Choosing another engine starts a new session and switches to it.",
  boundNotice: "This session is bound to this engine and cannot be changed. Start a new session to use a different one.",
  engineResolving: "Engine\u2026",
  engineUnknown: "Engine",
  engineUnknownNotice: "This session's engine could not be read. Choosing one still starts a new session on it.",
  claudeModelNotice: "Claude Code engine active: the actual model is decided natively by Claude Code; the model selector in this session has no effect."
};

// src/client/index.ts
var NS = "settings.loop-engine";
var inject = ["slots", "locale"];
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "loop-engine: copy dictionaries");
  const t = ctx.locale.bind(NS);
  ctx.inject(["slots", "conversation", "connection"], (scope) => {
    const rpc = new EngineRpc(scope.get("connection"));
    const switcher = {
      async startSessionOn(engine) {
        const sessions = scope.get("sessions");
        if (sessions === void 0) return false;
        const location = sessionLocation(
          sessions.list.getSnapshot(),
          scope.get("workspaces")?.list.getSnapshot().items
        );
        const sessionId = crypto.randomUUID();
        if (!await rpc.bind(sessionId, engine)) return false;
        try {
          await sessions.create({ sessionId, ...location });
        } catch (error) {
          console.warn("loop-engine: could not start a session on", engine, error);
          return false;
        }
        sessions.open(sessionId);
        return true;
      }
    };
    const composerInjected = () => ({ rpc, switcher, t });
    const badgeInjected = () => ({ rpc, t });
    const tintInjected = () => ({
      rpc,
      sessions: scope.get("sessions")
    });
    scope.effect(() => scope.slots.register({
      name: "conversation.input.right",
      id: "loop-engine",
      order: 0,
      locale: NS,
      inject: composerInjected
    }, LoopEngineComposerSelect), "loop-engine: composer engine select");
    scope.effect(() => scope.slots.register({
      name: "conversation.session.header.actions",
      id: "loop-engine",
      order: -100,
      locale: NS,
      inject: badgeInjected
    }, LoopEngineHeaderBadge), "loop-engine: session header engine badge");
    scope.effect(() => scope.slots.register({
      name: "shell.overlay",
      id: "loop-engine-tint",
      order: 0,
      inject: tintInjected
    }, SessionListTint), "loop-engine: session list engine tint");
  });
}
return module.exports; } });
//# sourceMappingURL=client.js.map
