/**
 * Loop engine display copy (Chinese product copy; comments in English). Used by
 * the composer engine picker and the session-header engine badge.
 * @module dsh-agent-hub/client/locales
 */

/** Copy keys of the loop engine seats. */
export interface LoopEngineKey {
  /** Option/label: the built-in DeepSeek in-process loop. */
  engineInProcess: string
  /** Option label: the Claude Code CLI driver. */
  engineClaudeCode: string
  /** Option label: the Codex CLI driver. */
  engineCodex: string
  /** Option label: the Pi CLI driver. */
  enginePi: string
  /** Composer tooltip: picking a different engine starts a new session. */
  switchCreatesSession: string
  /** Tooltip of the read-only seat / header badge: this session's engine is fixed. */
  boundNotice: string
  /** Composer label while this session's engine is still being read. */
  engineResolving: string
  /** Composer label when this session's engine could not be read. */
  engineUnknown: string
  /** Composer tooltip when the engine could not be read: picking still starts a session. */
  engineUnknownNotice: string
  /** Notice shown for the Claude Code engine: model selection is native. */
  claudeModelNotice: string
}

/** Simplified Chinese copy. */
export const zh: Record<keyof LoopEngineKey, string> = {
  engineInProcess: 'DeepSeek Loop',
  engineClaudeCode: 'Claude Code CLI',
  engineCodex: 'Codex CLI',
  enginePi: 'Pi CLI',
  switchCreatesSession: '当前会话的引擎在创建时已固定。选择其它引擎将立即新建一个会话并切换过去。',
  boundNotice: '本会话已绑定该引擎，创建后不可更改。要换引擎请新建会话。',
  engineResolving: '引擎…',
  engineUnknown: '引擎',
  engineUnknownNotice: '读取本会话引擎失败。选择一个引擎仍可新建会话并切换过去。',
  claudeModelNotice: '当前使用 Claude Code 引擎：实际模型由 Claude Code 原生决定，页面上的模型选择不生效。',
}

/** English copy. */
export const en: Record<keyof LoopEngineKey, string> = {
  engineInProcess: 'DeepSeek Loop',
  engineClaudeCode: 'Claude Code CLI',
  engineCodex: 'Codex CLI',
  enginePi: 'Pi CLI',
  switchCreatesSession: 'This session\'s engine was fixed when it was created. Choosing another engine starts a new session and switches to it.',
  boundNotice: 'This session is bound to this engine and cannot be changed. Start a new session to use a different one.',
  engineResolving: 'Engine…',
  engineUnknown: 'Engine',
  engineUnknownNotice: 'This session\'s engine could not be read. Choosing one still starts a new session on it.',
  claudeModelNotice: 'Claude Code engine active: the actual model is decided natively by Claude Code; the model selector in this session has no effect.',
}
