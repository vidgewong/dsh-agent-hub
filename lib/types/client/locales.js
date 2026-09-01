/**
 * Loop engine settings page copy (Chinese product copy; comments in English).
 * @module dsh-agent-hub/client/locales
 */
/** Simplified Chinese copy. */
export const zh = {
    nav: '循环引擎',
    description: '选择新建会话默认使用的 Agent 执行引擎。已存在的会话不受影响——引擎在会话创建时就已固定。',
    engineInProcess: '进程内引擎（默认）',
    engineClaudeCode: 'Claude Code CLI',
    engineCodex: 'Codex CLI',
    enginePi: 'Pi CLI',
    showInComposerLabel: '在对话页显示引擎选择器',
    unavailable: '循环引擎设置不可用',
    switchNotice: '这里设置的是**默认值**：只影响之后新建、且未单独指定引擎的会话。已有会话继续使用各自的引擎，无需刷新或重启。',
    switchCreatesSession: '当前会话的引擎在创建时已固定。选择其它引擎将立即新建一个会话并切换过去。',
    boundNotice: '本会话已绑定该引擎，创建后不可更改。要换引擎请新建会话。',
    engineResolving: '引擎…',
    engineUnknown: '引擎',
    engineUnknownNotice: '读取本会话引擎失败。选择一个引擎仍可新建会话并切换过去。',
    saving: '保存中…',
    claudeModelNotice: '当前使用 Claude Code 引擎：实际模型由 Claude Code 原生决定，页面上的模型选择不生效。',
};
/** English copy. */
export const en = {
    nav: 'Loop engine',
    description: 'The default agent execution engine for new sessions. Existing sessions are unaffected — a session\'s engine is fixed when it is created.',
    engineInProcess: 'In-process engine (default)',
    engineClaudeCode: 'Claude Code CLI',
    engineCodex: 'Codex CLI',
    enginePi: 'Pi CLI',
    showInComposerLabel: 'Show the engine selector in the chat page',
    unavailable: 'Loop engine settings are unavailable',
    switchNotice: 'This is a **default**: it applies only to sessions created later that do not pick an engine of their own. Existing sessions keep theirs — no reload, no restart.',
    switchCreatesSession: 'This session\'s engine was fixed when it was created. Choosing another engine starts a new session and switches to it.',
    boundNotice: 'This session is bound to this engine and cannot be changed. Start a new session to use a different one.',
    engineResolving: 'Engine…',
    engineUnknown: 'Engine',
    engineUnknownNotice: 'This session\'s engine could not be read. Choosing one still starts a new session on it.',
    saving: 'Saving…',
    claudeModelNotice: 'Claude Code engine active: the actual model is decided natively by Claude Code; the model selector in this session has no effect.',
};
//# sourceMappingURL=locales.js.map