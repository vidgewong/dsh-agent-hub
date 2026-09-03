/**
 * Claude Code loop Agent: drives one session through turn and step boundaries
 * with one Claude Agent SDK query per step. Claude Code owns its prompt,
 * tools, and permissions; the durable session log remains the source of truth
 * and the query prompt is a pure serialization of it.
 *
 * @module dsh-agent-hub/engine-claude/agent
 */
import { Inbox, agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent';
import { LlmError, createAssistantMessage, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm';
import { createScope } from '@deepseek-ai/dsh-scope';
import { canonicalHeader, headerEquals } from '@deepseek-ai/dsh-session';
import { mapAssistantMessage, mapStreamEvent, mapToolResults, maxChunkIndex, rebaseChunkIndices, } from "./mapping.js";
import { serializeHistory } from "../driver-core/prompt.js";
import { approvalReason, resolveSessionPermission } from "./permission.js";
import { DEFAULT_PERMISSION_MODE, claudeQueryOptions } from "./sdk.js";
import { deriveProviderEnv } from "./provider-env.js";
import { invokedSkillNames, isSkillName, renderSkillContent, } from "../driver-core/skill-inject.js";
/**
 * Engine label stamped on each assistant message's `source.provider`.
 *
 * This is provenance, not routing: it says which engine produced the message,
 * and nothing resolves it against `ctx.llm`. The *header*'s provider is a
 * different value entirely — see {@link ClaudeCodeAgent.assertRequestHeader}.
 */
const PROVIDER = 'claude-code';
/** Memoized module load, so a session's steps do not re-resolve the SDK. */
let claudeQueryPromise;
/**
 * Resolve the official SDK's `query` on first use.
 *
 * Deliberately dynamic. The SDK is an optional peer: a deployment that never
 * selects the Claude Code engine should not have to install it, and this module
 * is reached from the plugin's static import graph — a top-level import would
 * make a missing package fail the whole plugin tree at load time, taking every
 * other engine down with it. Importing here confines the failure to the engine
 * that actually needs it, and surfaces it as a turn error naming the fix.
 *
 * @returns the SDK's `query` function.
 * @throws when the optional peer is not installed.
 */
async function loadClaudeQuery() {
    claudeQueryPromise ??= import('@anthropic-ai/claude-agent-sdk').then((mod) => mod.query, (error) => {
        // Clear the slot so a later step retries rather than replaying a failure
        // the user may have fixed by installing the package in the meantime.
        claudeQueryPromise = undefined;
        throw new Error('the Claude Code engine requires "@anthropic-ai/claude-agent-sdk", which is not '
            + 'installed. Add it to this profile, or pick another engine for this session. '
            + `(${String(error)})`);
    });
    return claudeQueryPromise;
}
/**
 * Model label logged when no layer named a model: Claude Code then owns its
 * model natively, and the header still has to say something.
 */
const NATIVE_MODEL_LABEL = 'claude-code-native';
/**
 * Provider label logged beside {@link NATIVE_MODEL_LABEL} when no layer named a
 * route either.
 *
 * A header must carry a provider, and every honest candidate is wrong here:
 * naming a real route would claim a backend the child was never pointed at, and
 * an empty string reads as a missing field. So the header names the engine, and
 * the composer stays blocked until a model is picked — which is correct, because
 * at this point dsh genuinely does not know where the turn went.
 */
const NATIVE_PROVIDER_LABEL = PROVIDER;
/** Map one SDK result failure subtype to a stable provider-neutral code. */
function failureCode(subtype) {
    switch (subtype) {
        case 'error_during_execution':
        case 'error_max_turns':
        case 'error_max_budget_usd':
        case 'error_max_structured_output_retries':
            return `CLAUDE_CODE_${subtype.toUpperCase()}`;
        default:
            return 'CLAUDE_CODE_ERROR';
    }
}
/** Drives one session through turn and step boundaries on Claude Code. */
export class ClaudeCodeAgent {
    loopCtx;
    id;
    options;
    session;
    config;
    inbox;
    phase;
    activityDone = Promise.resolve();
    /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
    scope;
    ctx;
    /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
    dispatch;
    /** Whether this loop instance has appended its initial/resume request anchor. */
    requestHeaderLogged = false;
    constructor(loopCtx, id, options, session, config) {
        this.loopCtx = loopCtx;
        this.id = id;
        this.options = options;
        this.session = session;
        this.config = config;
        this.dispatch = agentEvents(loopCtx, this);
        this.inbox = new Inbox(session, {
            inserted: (message) => { this.dispatch.emit('agent/inbox/inserted', { message }); },
            discarded: (message) => { this.dispatch.emit('agent/inbox/discarded', { message }); },
            claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }); },
        });
        const lastTurn = session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0;
        this.phase = { kind: 'idle', lastTurn };
        this.scope = createScope(loopCtx, this);
        this.ctx = this.scope.ctx.extend({ agent: this });
    }
    get status() {
        return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running';
    }
    /** Commit a phase and publish its externally visible status transition. */
    setPhase(next) {
        const previousStatus = this.status;
        this.phase = next;
        const status = this.status;
        if (status !== previousStatus) {
            this.dispatch.emit('agent/status', { status });
        }
    }
    send(message, target, wakeup) {
        const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted;
        const resolvedTarget = wakingAfterAbort ? 'next-turn' : target;
        this.inbox.splice(resolvedTarget, Infinity, 0, [message]);
        if (wakeup)
            this.wakeDriver(wakingAfterAbort);
    }
    /**
     * Queue a message for the next turn and wake the driver.
     * @param input - the user message to deliver.
     */
    followup(input) {
        this.send(input, 'next-turn', true);
    }
    /**
     * Queue a message for the running step and wake the driver.
     * @param input - the user message to deliver.
     */
    steer(input) {
        this.send(input, 'next-step', true);
    }
    /**
     * Queue a message for the running step without waking the driver.
     * @param input - the user message to deliver.
     */
    inject(input) {
        this.send(input, 'next-step', false);
    }
    cancel(cause, options = {}) {
        if (!options.keepInbox) {
            this.inbox.clear();
            if (this.phase.kind !== 'idle')
                this.phase.wakeRequested = false;
        }
        if (this.phase.kind !== 'idle')
            this.phase.abort.abort(cause);
    }
    /**
     * Run a maintenance job while the agent is idle.
     * @param job - the maintenance operation, receiving the phase abort signal.
     * @returns the maintenance result.
     */
    runMaintenance(job) {
        if (this.phase.kind !== 'idle')
            throw new Error(`agent "${this.id}" already has active work`);
        const done = Promise.withResolvers();
        const maintenance = {
            kind: 'maintenance',
            abort: new AbortController(),
            lastTurn: this.phase.lastTurn,
            wakeRequested: false,
        };
        this.setPhase(maintenance);
        this.activityDone = done.promise;
        return (async () => {
            try {
                return await job(maintenance.abort.signal);
            }
            finally {
                this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn });
                if (maintenance.wakeRequested && this.inbox.hasPending)
                    this.wakeDriver();
                done.resolve();
            }
        })();
    }
    /**
     * Start one driver, or latch its wake behind maintenance or an aborted
     * activity. A wake sent while idle always opens its turn boundary, even
     * when its message was cleared; only a latched replay is suppressed when
     * the queue no longer holds the wake.
     * @param wakeAfterAbort - the {@link send} classification, captured before
     *   the inbox insertion so a reentrant cancel cannot reclassify it.
     */
    wakeDriver(wakeAfterAbort = false) {
        if (this.phase.kind !== 'idle') {
            const reason = this.phase.abort.signal.reason;
            if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
                this.phase.wakeRequested = true;
            }
            return;
        }
        const driver = Promise.withResolvers();
        this.activityDone = driver.promise;
        this.setPhase({
            kind: 'running',
            abort: new AbortController(),
            turn: this.phase.lastTurn,
            step: 0,
            wakeRequested: false,
        });
        this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject);
    }
    async whenIdle() {
        let activity;
        do {
            await (activity = this.activityDone);
        } while (activity !== this.activityDone);
    }
    /** Report one failure at its live boundary, then preserve it for driver containment. */
    throwError(error) {
        const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn;
        const step = this.phase.kind === 'running' ? this.phase.step : 0;
        this.dispatch.emit('agent/error', { turn, step, error });
        throw error;
    }
    async kick() {
        try {
            while (await this.turn()) { }
        }
        catch (_error) {
            // Reported failures and cancellation are contained at the driver boundary.
        }
        finally {
            /* v8 ignore start -- kick owns a running phase until this driver boundary */
            /* v8 ignore next -- kick owns a running phase until this driver boundary */
            if (this.phase.kind === 'running') {
                const { turn, wakeRequested } = this.phase;
                this.setPhase({ kind: 'idle', lastTurn: turn });
                if (wakeRequested && this.inbox.hasPending)
                    this.wakeDriver();
            } /* v8 ignore stop */
        }
    }
    async preStep(target, position) {
        /* v8 ignore start -- private callers establish the running phase before proposing a step */
        /* v8 ignore next -- private callers establish the running phase before proposing a step */
        if (this.phase.kind !== 'running')
            throw new Error(`agent "${this.id}": pre-step outside running phase`); /* v8 ignore stop */
        const signal = this.phase.abort.signal;
        const claimed = this.inbox.claim(target, position.turn);
        const decision = await this.dispatch.waterfall('agent/pre-step', { messages: claimed, ...position, signal }, () => Promise.resolve({ kind: 'enter', messages: claimed }));
        signal.throwIfAborted();
        if (decision.kind === 'reject')
            return decision;
        // Inject skill content for user-invoked skills.  The dsh-tool-skill
        // handler that normally does this lives on the agent-preset context
        // chain, which the Claude Code agent's context does not descend from,
        // so we replicate the gesture-scan and injection here.
        const injected = await this.injectSkills(decision.messages, signal);
        signal.throwIfAborted();
        return injected !== decision.messages
            ? { kind: 'enter', messages: [...injected] }
            : { ...decision };
    }
    /**
     * Scan the step's user messages for `/name` skill gestures, load each
     * matching skill, and inject the rendered skill content into the message
     * batch.  This mirrors what dsh-tool-skill does for the in-process engine.
     * @param messages - the current step's message batch.
     * @param signal - cancellation signal (aborted loads are silently dropped).
     * @returns the original batch when no skill was invoked, or an extended
     *   batch with injected skill-content messages appended.
     */
    async injectSkills(messages, signal) {
        const names = invokedSkillNames(messages);
        if (names.length === 0)
            return messages;
        const skills = this.loopCtx.get('skills');
        if (skills === undefined)
            return messages;
        const cwd = this.session.header.cwd;
        const injections = [];
        for (const name of names) {
            /* v8 ignore start -- SKILL_GESTURE only captures kebab-case names, so this guard never fires */
            /* v8 ignore next -- SKILL_GESTURE only captures kebab-case names, so this guard never fires */
            if (!isSkillName(name))
                continue;
            /* v8 ignore stop */
            let skill;
            try {
                skill = await skills.get(name, { signal, scope: this, ...(cwd === undefined ? {} : { cwd }) });
            }
            catch {
                continue; // load failure → silently skip
            }
            if (skill === undefined || !skill.invocation.userInvocable)
                continue;
            if (signal.aborted)
                return messages;
            injections.push(createUserMessage({
                content: [{ type: 'text', text: renderSkillContent(skill) }],
                source: { kind: 'skill-invocation', name, form: 'instructions' },
            }));
        }
        return injections.length > 0 ? [...messages, ...injections] : messages;
    }
    /**
     * Resolve the native permission handling for one query. A deployment-pinned
     * mode wins outright; otherwise the session's durable dsh permission knobs
     * decide per query (mid-session preset switches included): full access
     * bypasses native checks, an `ask` policy forwards each native permission
     * request to the dsh approval seam, and anything else fails closed with the
     * unattended deny-all stance.
     * @returns the permission fields of the query spec.
     */
    queryPermission() {
        if (this.config.permissionMode !== undefined)
            return { permissionMode: this.config.permissionMode };
        const permission = resolveSessionPermission(this.session.events);
        if (permission.kind === 'bypass')
            return { permissionMode: 'bypassPermissions' };
        if (permission.kind === 'ask') {
            const approval = this.loopCtx.get('approval');
            if (approval !== undefined) {
                return {
                    permissionMode: 'default',
                    onToolPermission: async (toolName, input, signal) => {
                        const outcome = await approval.request({
                            agent: this,
                            toolName,
                            reason: approvalReason(toolName, input),
                            signal,
                        });
                        return outcome === 'allowed-once' ? 'allow' : 'deny';
                    },
                };
            }
        }
        return { permissionMode: DEFAULT_PERMISSION_MODE };
    }
    /** Open one turn before claiming its first proposed step. */
    async turn() {
        if (this.phase.kind !== 'running') {
            this.throwError(new Error(`agent "${this.id}": turn without driver reservation`));
        }
        const phase = this.phase;
        const { signal } = phase.abort;
        signal.throwIfAborted();
        const turn = phase.turn + 1;
        try {
            this.session.append('turn/start', { turn });
        }
        catch (error) {
            this.throwError(error);
        }
        phase.turn = turn;
        let turnEnds = null;
        let target = 'next-turn';
        try {
            while (true) {
                signal.throwIfAborted();
                const step = phase.step + 1;
                const decision = await this.preStep(target, { turn, step });
                if (decision.kind === 'reject') {
                    turnEnds = { kind: 'blocked' };
                    return false;
                }
                if (turnEnds && decision.messages.length === 0)
                    break;
                if (phase.step === 0 && decision.messages.length === 0) {
                    turnEnds = { kind: 'completed' };
                    return false;
                }
                signal.throwIfAborted();
                this.session.append('step/start', { turn, step });
                phase.step = step;
                try {
                    for (const message of decision.messages) {
                        this.session.append('user/message', message, { surfaceOp: 'append' });
                    }
                    const stepEnd = await this.step();
                    if (turnEnds === null)
                        turnEnds = stepEnd;
                }
                finally {
                    // step() may have opened further steps for later SDK rounds; close
                    // whichever one is actually open (phase.step), not the one this
                    // iteration opened.
                    this.session.append('step/end', { turn, step: phase.step });
                }
                signal.throwIfAborted();
                if (turnEnds && this.inbox.nextStep.length === 0) {
                    await this.dispatch.serial('agent/turn-stopping', { turn, signal });
                    signal.throwIfAborted();
                }
                if (turnEnds && this.inbox.nextStep.length === 0)
                    break;
                target = 'next-step';
            }
        }
        catch (error) {
            if (signal.aborted) {
                turnEnds = { kind: 'aborted', reason: signal.reason };
                throw error;
            }
            turnEnds = {
                kind: 'error',
                error: error instanceof LlmError
                    ? error.failure
                    : { message: errorChain(error), code: 'UNKNOWN' },
            };
            this.throwError(error);
        }
        finally {
            try {
                // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
                this.session.append('turn/end', { turn, reason: turnEnds });
            }
            catch (error) {
                this.throwError(error);
            }
        }
        if (!this.inbox.hasPending)
            return false;
        phase.abort = new AbortController();
        phase.wakeRequested = false;
        phase.step = 0;
        return true;
    }
    /**
     * Resolve the model one query runs on, per-session selection first.
     *
     * The layers, in precedence order:
     *
     *  1. **The `agent/request` waterfall.** This is the seam the dsh model
     *     picker actually drives. api-proxy installs `installModelSelection` on
     *     every agent's own context, which listens on `system-prompt/assemble`
     *     to *snapshot* the session's selection and on `agent/request` to *apply*
     *     the snapshot — two stages, so a mid-turn switch lands on a later step
     *     rather than splitting the prompt from the route. Both must be
     *     dispatched, and in that order: the request listener reads
     *     `selection.assembled`, which only the assemble listener writes, so
     *     dispatching the request waterfall alone yields nothing.
     *  2. `AgentOptions.model` — the create-time seed.
     *  3. `agentDefaultModel` — the global default.
     *  4. The deployment's pinned `config.model`.
     *  5. Nothing, leaving the CLI on its own model.
     *
     * Every layer is optional and every failure degrades to the next one: a
     * minimal profile mounts neither service, and a listener that throws must
     * cost this session its turn no more than a missing service does.
     *
     * @param signal - the step's cancellation signal, forwarded to prompt assembly.
     * @returns the chosen id (undefined leaves the CLI on its own default),
     * its provider route, and the layer that chose it.
     */
    async resolveModel(signal) {
        const selected = await this.selectionFromWaterfall(signal);
        if (selected !== undefined)
            return selected;
        if (this.options.model !== undefined) {
            return { model: this.options.model, provider: this.options.provider, source: 'session' };
        }
        const defaults = this.loopCtx.get('agentDefaultModel');
        if (defaults !== undefined) {
            try {
                const selection = defaults.currentSelection();
                if (selection.model !== '') {
                    return { model: selection.model, provider: selection.provider, source: 'default' };
                }
            }
            catch (error) {
                this.ctx.logger.warn('claude-code: default model selection unavailable: %s', error);
            }
        }
        if (this.config.model !== undefined) {
            return { model: this.config.model, provider: undefined, source: 'config' };
        }
        return { model: undefined, provider: undefined, source: 'native' };
    }
    /**
     * Ask the host what this session is routed to, through the two waterfalls
     * that carry a per-session selection.
     *
     * The seed handed to `agent/request` is the same one the in-process loop
     * seeds with — the agent's own options — so a host that installs no listener
     * gets its own answer back and this returns undefined, leaving the layers
     * below untouched. A listener that replaces it wins.
     *
     * The assemble pass is dispatched for its *side effect* on the selection
     * state; its returned prompt is discarded, because Claude Code builds its own
     * prompt and dsh's assembly never reaches the child. That makes this a real
     * (if small) cost per step: the host's prompt providers run and their output
     * is dropped. It is the price of reaching a selection whose only publisher is
     * that listener pair.
     *
     * @param signal - the step's cancellation signal.
     * @returns the selection when a listener supplied one, else undefined.
     */
    async selectionFromWaterfall(signal) {
        const phase = this.phase;
        /* v8 ignore start -- step() is the sole caller and establishes the running phase before resolving */
        /* v8 ignore next -- step() is the sole caller and establishes the running phase before resolving */
        if (phase.kind !== 'running')
            return undefined;
        /* v8 ignore stop */
        const { turn, step } = phase;
        const seed = {
            provider: this.options.provider ?? '',
            model: this.options.model ?? '',
        };
        try {
            const systemPrompt = this.loopCtx.get('systemPrompt');
            if (systemPrompt !== undefined) {
                await systemPrompt.assemble(assembleContextFor(this, signal));
            }
            const proposed = await this.dispatch.waterfall('agent/request', { turn, step, signal }, () => Promise.resolve(seed));
            if (proposed.model === '' || proposed.provider === '')
                return undefined;
            if (proposed.provider === seed.provider && proposed.model === seed.model)
                return undefined;
            return { model: proposed.model, provider: proposed.provider, source: 'selection' };
        }
        catch (error) {
            // A host listener is not this engine's to trust with the turn. Degrading
            // costs the session its per-session selection; propagating would cost it
            // the turn, on a path a minimal profile does not even have.
            this.ctx.logger.warn('claude-code: per-session model selection unavailable: %s', error);
            return undefined;
        }
    }
    /**
     * Append the request header, and re-append it whenever the route changes.
     *
     * The provider written here is the **real** dsh route (`copilot-proxy`,
     * `amazon-bedrock`, …), not this engine's name. That is not cosmetic:
     * api-proxy re-reads this field on every read as "the model this session is
     * on", resolves it against `ctx.llm.listProviders()`, and locks the composer
     * when the name is not a registered provider — so writing the engine name
     * here made every session demand a fresh model pick after each turn. The
     * engine that ran the turn is recorded in the `*.loop-engine.json` sidecar,
     * which is where per-session engine provenance already lives.
     *
     * Re-logging on change mirrors the in-process loop: the header is the log's
     * record of what each request ran under, so a mid-session model switch has to
     * produce a new snapshot or the log misattributes every later turn.
     *
     * @param selected - the model resolved for the step about to run.
     */
    noteRequestHeader(selected) {
        const header = canonicalHeader({
            config: {
                provider: selected.provider ?? NATIVE_PROVIDER_LABEL,
                model: selected.model ?? NATIVE_MODEL_LABEL,
            },
        });
        const baseline = this.session.requestHeader();
        if (!this.requestHeaderLogged) {
            this.session.append('request/header', {
                header,
                reason: baseline === undefined ? 'initial' : 'resume',
            });
            this.requestHeaderLogged = true;
            return;
        }
        if (baseline === undefined || !headerEquals(baseline, header)) {
            this.session.append('request/header', { header, reason: 'change' });
        }
    }
    /** Run one Claude Code query for the current step and map its transcript into the session log. */
    async step() {
        /* v8 ignore start -- private callers establish the running phase before executing a step */
        /* v8 ignore next -- private callers establish the running phase before executing a step */
        if (this.phase.kind !== 'running')
            throw new Error(`agent "${this.id}": step outside running phase`); /* v8 ignore stop */
        const { turn, abort: { signal } } = this.phase;
        // One SDK query can contain several assistant↔tool rounds. Each round is
        // mapped onto its OWN dsh step so the client trajectory (which groups nodes
        // by `turn:step` and anchors the assistant node to that step's last
        // assistant/message seq) interleaves each assistant message with the tool
        // calls it issued, instead of piling every tool call above one collapsed
        // assistant node. `step` is therefore mutable here, advanced by rollStep at
        // each round boundary; turn() closes whichever step this leaves open.
        let step = this.phase.step;
        const phase = this.phase;
        signal.throwIfAborted();
        const cwd = this.session.header.cwd;
        if (cwd === undefined || cwd.length === 0) {
            throw new Error(`agent "${this.id}": no working directory — start the session with cwd metadata`);
        }
        const history = this.session.deriveMessages();
        const prompt = serializeHistory(history);
        /* v8 ignore start -- a step only runs after claiming and durably appending at least one user message */
        if (prompt.length === 0) {
            throw new Error(`agent "${this.id}": cannot derive a prompt from an empty session log`);
        }
        /* v8 ignore stop */
        // Resolve the route BEFORE the header is written: the header records the
        // route this step runs on, so a resolution that happened after it would
        // log the previous step's answer.
        const selected = await this.resolveModel(signal);
        signal.throwIfAborted();
        this.noteRequestHeader(selected);
        signal.throwIfAborted();
        const controller = new AbortController();
        const cancel = () => {
            /* v8 ignore start -- a phase signal fires once; the controller cannot already be aborted when its single listener runs */
            /* v8 ignore next -- a phase signal fires once; the controller cannot already be aborted when its single listener runs */
            if (!controller.signal.aborted) {
                /* v8 ignore next -- the phase signal aborts with AgentCancelCause values only, which the durable log can record */
                controller.abort(signal.reason instanceof Error ? signal.reason : new Error(`agent "${this.id}" query aborted`));
            } /* v8 ignore stop */
        };
        signal.addEventListener('abort', cancel, { once: true });
        const diagnostics = [];
        try {
            // The route the selection names is dsh's own; derive the child's provider
            // environment from it rather than from whatever shell launched the host,
            // which a desktop-launched dsh does not have. Passed as `providerEnv` so
            // it displaces inheritance outright instead of merging with a stale
            // backend that would out-rank it; the deployment's `env` still layers on
            // top. When the route cannot be derived this is undefined and the child
            // environment is re-inherited exactly as before.
            const derived = await deriveProviderEnv(this.loopCtx, selected.provider);
            if (derived !== undefined)
                diagnostics.push(derived.diagnostic);
            const options = claudeQueryOptions({
                cwd,
                ...this.queryPermission(),
                env: this.config.env,
                ...derived === undefined ? {} : { providerEnv: derived.env },
                backend: this.config.backend,
                disposeGraceMs: this.config.disposeGraceMs,
                ...selected.model === undefined ? {} : { model: selected.model },
                ...selected.provider === undefined ? {} : { provider: selected.provider },
                ...this.config.maxTurns === undefined ? {} : { maxTurns: this.config.maxTurns },
                spawn: spec => this.loopCtx.subprocess.spawn(spec),
                onUnattended: (line) => { diagnostics.push(line); },
            }, controller);
            const officialQuery = await loadClaudeQuery();
            const query = officialQuery({ prompt, options });
            let finished = false;
            /** Seq numbers of the `assistant/chunk` events that streamed the current step, for replay linking. */
            const chunkSeqs = [];
            /** Per-raw-block-index tool identity, seeded by `mapStreamEvent` at a tool `content_block_start`. */
            const toolCalls = new Map();
            /** Accumulated reasoning per rebased block index, for the durable-message fallback below. */
            const reasoningByIndex = new Map();
            // ---- One API turn, one dsh step, one assistant/message ----------------
            //
            // The CLI splits ONE model turn across several SDK `assistant` messages
            // that share a `message.id` — typically thinking, then narration text,
            // then the `tool_use`. The dsh client projects a step's assistant node
            // with LAST-WINS semantics (`blocks: toAssistantBlocks(message.content)`),
            // so appending each fragment separately made the trailing tool_use-only
            // fragment erase the narration; and because a tool-call-only node is
            // filtered out by `hasVisibleContent`, the step lost its anchor entirely
            // and every tool node piled above some later surviving assistant node.
            //
            // So fragments are COALESCED into one buffer keyed by `message.id` and
            // flushed as a single `assistant/message` immediately before the
            // `tool/call` events of that same API turn — keeping the assistant seq
            // below its tools, which is exactly the order the trajectory renders by.
            // A new `message.id`, or a second flush inside one step, rolls the step.
            /** Coalesced content blocks of the API turn currently accumulating. */
            let pendingContent = [];
            /** Latest provider-reported accounting seen for the accumulating turn. */
            let pendingUsage;
            /** Model id reported by the accumulating turn's fragments. */
            let pendingModel;
            /** `message.id` of the accumulating API turn; a change starts a new one. */
            let pendingMessageId;
            /** Whether this dsh step already appended its one `assistant/message`. */
            let stepFlushed = false;
            /** Top-level call ids appended this query; nested results are filtered against it. */
            const ownCallIds = new Set();
            // ---- Streamed block-index rebasing ------------------------------------
            //
            // The client addresses live blocks by `blocks[chunk.index]`. Each SDK
            // assistant fragment restarts `content_block` indices at 0, so without a
            // rebase the tool fragment's index 0 overwrites the narration that
            // streamed at index 0 a moment earlier — the partial visibly loses its
            // text mid-stream. `blockOffset` shifts each fragment past the previous
            // one within the same dsh step.
            /** Amount added to raw block indices of the fragment being streamed. */
            let blockOffset = 0;
            /** Highest rebased index appended in this step, the base for the next fragment. */
            let maxSeenIndex = -1;
            /** Last raw index opened by a `content_block_start`; a non-increase marks a restart. */
            let lastRawStart;
            /**
             * Close the current dsh step and open the next one at an API-turn boundary.
             * turn() closes whichever step this leaves open (it reads `phase.step`).
             */
            const rollStep = () => {
                this.session.append('step/end', { turn, step });
                step += 1;
                phase.step = step;
                this.session.append('step/start', { turn, step });
                stepFlushed = false;
                chunkSeqs.length = 0;
                toolCalls.clear();
                reasoningByIndex.clear();
                blockOffset = 0;
                maxSeenIndex = -1;
                lastRawStart = undefined;
            };
            /**
             * Append the coalesced API turn as this step's single `assistant/message`.
             * A no-op when nothing accumulated, so it is safe to call at every
             * boundary.
             */
            const flushAssistant = () => {
                if (pendingContent.length === 0)
                    return;
                const content = pendingContent;
                const usage = pendingUsage;
                const model = pendingModel ?? NATIVE_MODEL_LABEL;
                pendingContent = [];
                pendingUsage = undefined;
                pendingModel = undefined;
                reasoningByIndex.clear();
                this.session.append('assistant/message', {
                    turn,
                    step,
                    message: createAssistantMessage({
                        content,
                        source: { provider: PROVIDER, model },
                    }),
                    ...usage === undefined ? {} : { usage },
                }, {
                    surfaceOp: 'append',
                    // Link the durable message to the chunks that streamed it, so replay
                    // can reconstruct the partial exactly as shown.
                    ...chunkSeqs.length === 0 ? {} : { sourceEventSeqs: [...chunkSeqs] },
                });
                stepFlushed = true;
            };
            /** Reasoning captured from stream deltas, as content blocks in index order. */
            const streamedReasoning = () => [...reasoningByIndex.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([, text]) => ({ type: 'reasoning', text }));
            signal.throwIfAborted();
            for await (const message of query) {
                signal.throwIfAborted();
                switch (message.type) {
                    case 'stream_event': {
                        // Subagent (Task) frames carry a parent tool id. They belong to a
                        // nested transcript, not this session's step, and interleaving them
                        // here would split the parent's API turn across bogus boundaries.
                        if (message.parent_tool_use_id !== null)
                            break;
                        const event = message.event;
                        if (event.type === 'content_block_start') {
                            // A fragment boundary shows up as a block index that does not
                            // advance. Rebase past everything this step already streamed.
                            if (lastRawStart !== undefined && event.index <= lastRawStart) {
                                blockOffset = maxSeenIndex + 1;
                            }
                            lastRawStart = event.index;
                        }
                        const chunks = rebaseChunkIndices(mapStreamEvent(event, toolCalls), blockOffset);
                        const highest = maxChunkIndex(chunks);
                        if (highest !== undefined && highest > maxSeenIndex)
                            maxSeenIndex = highest;
                        for (const chunk of chunks) {
                            chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq);
                            if (chunk.type === 'reasoning-delta') {
                                reasoningByIndex.set(chunk.index, (reasoningByIndex.get(chunk.index) ?? '') + chunk.text);
                            }
                        }
                        break;
                    }
                    case 'assistant': {
                        // Subagent narration and its nested tool_use blocks are the child
                        // transcript; the parent's Task tool/result already summarizes it.
                        if (message.parent_tool_use_id !== null)
                            break;
                        const mapped = mapAssistantMessage(message.message);
                        const messageId = message.message.id;
                        // A new API turn: close the coalesced one, and roll the step when
                        // this one already published its assistant message. A purely
                        // reasoning buffer is NOT closed here — providers that split
                        // thinking into its own message give that message its own id, and
                        // publishing the thinking alone would let the next message's
                        // last-wins projection erase it. It folds into the next turn instead.
                        const reasoningOnlyPending = pendingContent.length > 0
                            && pendingContent.every(block => block.type === 'reasoning');
                        if (pendingMessageId !== undefined && messageId !== pendingMessageId && !reasoningOnlyPending) {
                            flushAssistant();
                        }
                        if (stepFlushed)
                            rollStep();
                        pendingMessageId = messageId;
                        // Thinking fallback: some providers stream thinking deltas but omit
                        // thinking blocks from the assistant message. Retain the streamed
                        // reasoning so it survives the step's projection.
                        let content = mapped.content;
                        const haveReasoning = pendingContent.some(block => block.type === 'reasoning')
                            || content.some(block => block.type === 'reasoning');
                        if (reasoningByIndex.size > 0 && !haveReasoning) {
                            content = [...streamedReasoning(), ...content];
                        }
                        if (content.some(block => block.type === 'reasoning'))
                            reasoningByIndex.clear();
                        pendingContent = [...pendingContent, ...content];
                        if (mapped.usage !== undefined)
                            pendingUsage = mapped.usage;
                        pendingModel = mapped.model;
                        if (mapped.toolCalls.length > 0) {
                            // Publish the coalesced turn BEFORE its calls so the assistant
                            // node's anchor seq stays below the tool nodes it issued.
                            flushAssistant();
                            for (const call of mapped.toolCalls) {
                                ownCallIds.add(String(call.callId));
                                this.session.append('tool/call', {
                                    turn, step, callId: call.callId, name: call.name, arguments: call.arguments,
                                });
                            }
                        }
                        break;
                    }
                    case 'user': {
                        for (const result of mapToolResults(message.message)) {
                            // Only results for calls this step actually published: a subagent's
                            // nested tool results have no top-level call to pair with and would
                            // render as orphan nodes.
                            if (!ownCallIds.has(String(result.source.callId)))
                                continue;
                            this.session.append('tool/result', { turn, step, message: result }, { surfaceOp: 'append' });
                        }
                        break;
                    }
                    case 'result': {
                        // A query that ended mid-coalescing (trailing text, or thinking that
                        // never got a following fragment) publishes it here.
                        if (pendingContent.length === 0 && reasoningByIndex.size > 0) {
                            pendingContent = streamedReasoning();
                        }
                        if (pendingContent.length > 0 && stepFlushed)
                            rollStep();
                        flushAssistant();
                        pendingMessageId = undefined;
                        if (message.subtype === 'success') {
                            finished = true;
                        }
                        else {
                            const summary = message.errors[0] ?? `claude code query failed (${message.subtype})`;
                            throw new LlmError(summary, failureCode(message.subtype));
                        }
                        break;
                    }
                    default:
                        // init/status/permission/control messages are SDK transport; the
                        // durable log records only the model-visible transcript.
                        break;
                }
            }
            if (!finished) {
                throw new LlmError(`agent "${this.id}": claude-code query ended without a result message`, 'CLAUDE_CODE_NO_RESULT');
            }
            return { kind: 'completed' };
        }
        finally {
            signal.removeEventListener('abort', cancel);
            controller.abort();
            for (const line of diagnostics)
                this.ctx.logger.warn('%s', line);
        }
    }
}
/* jscpd:ignore-end */
//# sourceMappingURL=agent.js.map