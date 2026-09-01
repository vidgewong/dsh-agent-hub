import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Composer loop-engine control, registered at the `conversation.input.right`
 * seat so it sits immediately left of the model select in the composer's tool
 * row.
 *
 * It shows **this session's actual engine**, read from the node half over the
 * plugin's own RPC channel. That distinction is the whole point of this
 * component. A session's engine is chosen inside `createAgent`, which the
 * harness fires eagerly when a session is *opened* — before a user can click
 * anything — so a control backed by the settings value would name "the last
 * thing picked anywhere" while the session ran something else. That was a real,
 * reported defect: the composer read "In-process engine" while Claude Code
 * answered.
 *
 * The seat never hides itself over a failed read. When the engine cannot be
 * resolved it says so and stays clickable: the picker is the only route to
 * another engine, so removing it would strand the user with no control and no
 * explanation — which is precisely how this looked when the channel silently
 * failed to register.
 *
 * Because the engine is fixed before the control is reachable, picking a
 * different one cannot change this session. It instead **creates a new one**:
 * the seat mints a session id, reserves the engine for it over the channel, and
 * asks the host to create exactly that id — bypassing `connectWorkspace`, which
 * would hand back the current blank session and defeat the purpose. The
 * abandoned blank session is left alone; discarding a session is the user's
 * call, not the picker's.
 *
 * Styling is token-driven inline styles like the section (the client-module
 * bundle is esbuild-built without a CSS loader).
 * @module dsh-agent-hub/client/composer
 */
import { useEffect, useRef, useState } from 'react';
import { IconChevronDownOutline14, Menu, } from '@deepseek-ai/dsh-client-ui-primitives';
const ENGINE_OPTIONS = [
    { value: 'in-process', key: 'engineInProcess' },
    { value: 'claude-code', key: 'engineClaudeCode' },
    { value: 'codex', key: 'engineCodex' },
    { value: 'pi', key: 'enginePi' },
];
/** Locale key of one engine's option label. */
function engineLabelKey(engine) {
    switch (engine) {
        case 'claude-code': return 'engineClaudeCode';
        case 'codex': return 'engineCodex';
        case 'pi': return 'enginePi';
        default: return 'engineInProcess';
    }
}
/** Compact quiet trigger, one row tall like the model pill. */
const trigger = {
    appearance: 'none',
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 8px',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 10,
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    font: 'inherit',
    fontSize: 12,
    lineHeight: '20px',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
};
const triggerBusy = { ...trigger, opacity: 0.5, cursor: 'default' };
/**
 * The read-only seat, used when no Connection is available to switch through.
 * No border or button affordance — it must not invite a click that cannot do
 * anything.
 */
const frozen = {
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    padding: '4px 8px',
    color: 'var(--dsw-alias-label-secondary)',
    font: 'inherit',
    fontSize: 12,
    lineHeight: '20px',
    whiteSpace: 'nowrap',
};
/**
 * Render the composer's loop-engine seat.
 * @param props - composed slot props.
 * @returns the control naming this session's engine, or null when the settings
 *   toggle hides it.
 */
export function LoopEngineComposerSelect(props) {
    const { rpc, switcher, useSnapshot, session, t } = props;
    const { status, showInComposer } = useSnapshot((snapshot) => snapshot);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const triggerRef = useRef(null);
    // This session's true engine, from the node half's durable record. It stays
    // `undefined` while the answer is outstanding and when it never arrives (an
    // absent Connection, a channel that failed to register, a transport error);
    // `resolving` separates those two so the seat can say which one it is.
    const [engine, setEngine] = useState(undefined);
    const [resolving, setResolving] = useState(false);
    const sessionId = session?.sessionId;
    useEffect(() => {
        if (sessionId === undefined) {
            setEngine(undefined);
            setResolving(false);
            return;
        }
        const abort = new AbortController();
        // Clear first: showing the previous session's engine against a new session
        // id is exactly the lie this component exists to remove.
        setEngine(undefined);
        setResolving(true);
        void rpc.resolve(sessionId, abort.signal).then((resolved) => {
            if (abort.signal.aborted)
                return;
            setEngine(resolved);
            setResolving(false);
        });
        return () => { abort.abort(); };
    }, [rpc, sessionId]);
    // Hidden only when the settings toggle clears the seat, or before the
    // settings scope has settled enough to know that. An unknown engine must NOT
    // hide the control: the picker is how a user reaches another engine at all,
    // and removing it on a failed read leaves them with no way to switch and no
    // sign anything went wrong.
    if (status === 'loading' || !showInComposer)
        return null;
    // Three display states: the resolved engine, "still reading", and "could not
    // read". The last two keep the picker live — creating a session on a chosen
    // engine does not depend on knowing the current one.
    const label = engine !== undefined
        ? t(engineLabelKey(engine))
        : t(resolving ? 'engineResolving' : 'engineUnknown');
    const notice = engine === 'claude-code'
        ? t('claudeModelNotice')
        : engine === undefined && !resolving
            ? t('engineUnknownNotice')
            : t('switchCreatesSession');
    // Without a Connection there is no way to reserve an engine for a new
    // session, so the seat reports the current one and stops there.
    if (!rpc.available) {
        return (_jsx("span", { style: frozen, title: t('boundNotice'), children: label }));
    }
    // Picking cannot change this session — its agent already exists — so it
    // creates a new session on the chosen engine and switches to it.
    const onSelect = (next) => {
        setOpen(false);
        const value = next;
        if (value === engine || busy)
            return;
        setBusy(true);
        void switcher.startSessionOn(value).finally(() => { setBusy(false); });
    };
    return (_jsx(Menu, { open: open, onClose: () => { setOpen(false); }, items: ENGINE_OPTIONS.map(option => ({ id: option.value, label: t(option.key) })), selectedId: engine, onSelect: onSelect, align: "start", portal: true, getAnchorRect: () => triggerRef.current?.getBoundingClientRect() ?? null, anchor: (_jsxs("button", { type: "button", ref: triggerRef, "aria-haspopup": "menu", "aria-expanded": open, disabled: busy, style: busy ? triggerBusy : trigger, title: notice, onClick: () => { setOpen(!open); }, children: [label, _jsx(IconChevronDownOutline14, { size: 14 })] })) }));
}
//# sourceMappingURL=LoopEngineComposerSelect.js.map