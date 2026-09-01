/**
 * Loop engine settings page copy (Chinese product copy; comments in English).
 * @module dsh-agent-hub/client/locales
 */
/** Copy keys of the loop engine settings page. */
export interface LoopEngineKey {
    /** Settings navigation label. */
    nav: string;
    /** Panel description under the title. */
    description: string;
    /** Option label: the default in-process loop driver. */
    engineInProcess: string;
    /** Option label: the Claude Code CLI driver. */
    engineClaudeCode: string;
    /** Option label: the Codex CLI driver. */
    engineCodex: string;
    /** Option label: the Pi CLI driver. */
    enginePi: string;
    /** Settings toggle: show the engine picker in the chat page composer. */
    showInComposerLabel: string;
    /** Unavailable-state message. */
    unavailable: string;
    /** Notice explaining that the choice binds at session creation. */
    switchNotice: string;
    /** Composer tooltip: picking a different engine starts a new session. */
    switchCreatesSession: string;
    /** Tooltip of the read-only composer seat: this session's engine is already fixed. */
    boundNotice: string;
    /** Composer label while this session's engine is still being read. */
    engineResolving: string;
    /** Composer label when this session's engine could not be read. */
    engineUnknown: string;
    /** Composer tooltip when the engine could not be read: picking still starts a session. */
    engineUnknownNotice: string;
    /** Saving state label. */
    saving: string;
    /** Notice shown while the Claude Code engine owns the slot: model selection is native. */
    claudeModelNotice: string;
}
/** Simplified Chinese copy. */
export declare const zh: Record<keyof LoopEngineKey, string>;
/** English copy. */
export declare const en: Record<keyof LoopEngineKey, string>;
//# sourceMappingURL=locales.d.ts.map