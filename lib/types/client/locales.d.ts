/**
 * Loop engine display copy (Chinese product copy; comments in English). Used by
 * the composer engine picker and the session-header engine badge.
 * @module dsh-omniloop/client/locales
 */
/** Copy keys of the loop engine seats. */
export interface LoopEngineKey {
    /** Option/label: the built-in DeepSeek in-process loop. */
    engineInProcess: string;
    /** Option label: the Claude Code CLI driver. */
    engineClaudeCode: string;
    /** Option label: the Codex CLI driver. */
    engineCodex: string;
    /** Option label: the Pi CLI driver. */
    enginePi: string;
    /** Composer tooltip: picking a different engine starts a new session. */
    switchCreatesSession: string;
    /** Tooltip of the read-only seat / header badge: this session's engine is fixed. */
    boundNotice: string;
    /** Composer label while this session's engine is still being read. */
    engineResolving: string;
    /** Composer label when this session's engine could not be read. */
    engineUnknown: string;
    /** Composer tooltip when the engine could not be read: picking still starts a session. */
    engineUnknownNotice: string;
    /** Notice shown for the Claude Code engine: model selection is native. */
    claudeModelNotice: string;
}
/** Simplified Chinese copy. */
export declare const zh: Record<keyof LoopEngineKey, string>;
/** English copy. */
export declare const en: Record<keyof LoopEngineKey, string>;
//# sourceMappingURL=locales.d.ts.map