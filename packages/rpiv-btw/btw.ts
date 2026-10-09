/**
 * @juicesharp/rpiv-btw — /btw side-question slash command.
 *
 * Asks the same primary model a one-off side question using the cloned primary
 * conversation as context. Answer streams into an ephemeral centered card
 * (never enters main agent's messages). History persists per-session-file
 * via globalThis-keyed storage; process-scoped only (no disk persistence).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, Message, StopReason, UserMessage } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { type CappedHistory, capHistory, type FitBranchResult, fitBranch } from "./btw-budget.js";
import { assistantMessageText, type BtwTurn, userMessageText } from "./btw-messages.js";
import { type BtwOverlayController, showBtwOverlay, startBtwWaiting } from "./btw-ui.js";
import { getRuntimeStreamSimple, loadIsContextOverflow, loadStreamSimple } from "./pi-compat.js";

// ---------------------------------------------------------------------------
// Constants — flat named consts, grouped by concern (advisor pattern, b9428e9)
// ---------------------------------------------------------------------------

// Identity
export const BTW_COMMAND_NAME = "btw";

// Storage — globalThis-keyed survives module re-import on /new, /fork, /resume.
// Lost on Pi process exit (intentional — no disk persistence).
export const BTW_STATE_KEY = Symbol.for("rpiv-btw");

// Cross-session pattern hint: how many recent question-strings to inject
export const CROSS_SESSION_HINT_LIMIT = 10;

// Messages (static)
const MSG_REQUIRES_INTERACTIVE = "/btw requires interactive mode";
const MSG_USAGE = "Usage: /btw <question>";
const MSG_NO_MODEL = "/btw requires an active model";
const MSG_ALREADY_RUNNING =
	"/btw is already open. Wait for the answer, then dismiss it before asking another question.";

// Errors (static)
const ERR_EMPTY_RESPONSE = "/btw returned no text content.";
const ERR_NO_FINAL_MESSAGE = "stream ended without a final message";

// Errors (parameterized)
const errMisconfigured = (label: string, err: string) => `/btw model (${label}) is misconfigured: ${err}`;
const errNoApiKey = (label: string) => `/btw model (${label}) has no API key available.`;
const errCallFailed = (err: string | undefined) => `/btw call failed: ${err ?? "unknown error"}`;
const errCallThrew = (msg: string) => `/btw call threw: ${msg}`;

// Budget (context-budgeting) constants — defined in btw-budget.ts (the leaf budget
// module; keeps the module cycle type-only at runtime), re-exported here so the
// package surface is unchanged.
export { BTW_CONTEXT_RESERVE, BTW_HISTORY_TOKEN_BUDGET, BTW_NO_ANCHOR_SAFETY_FACTOR } from "./btw-budget.js";
// BtwTurn + the message-text extractors live in the cycle-break leaf
// (packages/rpiv-btw/btw-messages.ts); re-exported here so the package surface is
// unchanged (packages/rpiv-btw/btw.test.ts / btw-ui.test.ts / btw-budget.test.ts still
// import them from "./btw.js"). Import-then-re-export (not `export … from`) because
// btw.ts consumes all three internally for hints, answers and session history.
export { assistantMessageText, type BtwTurn, userMessageText };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BtwState {
	histories: Map<string, BtwTurn[]>;
	snapshots: Map<string, { messages: Message[]; entries: SessionEntry[] }>;
}

export function branchToMessages(branch: SessionEntry[]): Message[] {
	const agentMessages = branch
		.filter((e): e is SessionEntry & { type: "message" } => e.type === "message")
		.map((e) => e.message);
	return convertToLlm(agentMessages);
}

// ---------------------------------------------------------------------------
// System prompt — loaded once at module init from prompts/btw-system.txt
// ---------------------------------------------------------------------------

export const BTW_SYSTEM_PROMPT = readFileSync(
	fileURLToPath(new URL("./prompts/btw-system.txt", import.meta.url)),
	"utf-8",
).trimEnd();

// ---------------------------------------------------------------------------
// Storage — globalThis-keyed, survives module re-import on /new, /fork, /resume.
// Standard Node.js `globalThis + Symbol.for()` idiom for cross-import-graph
// singleton state (used by OpenTelemetry, etc.); lost on process exit.
// ---------------------------------------------------------------------------

function getState(): BtwState {
	const g = globalThis as unknown as { [k: symbol]: BtwState | undefined };
	let state = g[BTW_STATE_KEY];
	if (!state) {
		state = {
			histories: new Map(),
			snapshots: new Map(),
		};
		g[BTW_STATE_KEY] = state;
	}
	return state;
}

function getSessionFile(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionFile() ?? `memory:${ctx.sessionManager.getSessionId()}`;
}

function getSessionHistory(ctx: ExtensionContext): BtwTurn[] {
	const key = getSessionFile(ctx);
	const state = getState();
	let turns = state.histories.get(key);
	if (!turns) {
		turns = [];
		state.histories.set(key, turns);
	}
	return turns;
}

function pushSessionTurn(ctx: ExtensionContext, turn: BtwTurn): void {
	getSessionHistory(ctx).push(turn);
}

export function clearSessionHistory(ctx: ExtensionContext): void {
	getState().histories.set(getSessionFile(ctx), []);
}

function getSnapshot(ctx: ExtensionContext): { messages: Message[]; entries: SessionEntry[] } | undefined {
	return getState().snapshots.get(getSessionFile(ctx));
}

function setSnapshot(ctx: ExtensionContext, snapshot: { messages: Message[]; entries: SessionEntry[] }): void {
	getState().snapshots.set(getSessionFile(ctx), snapshot);
}

export function invalidateSnapshot(ctx: ExtensionContext): void {
	getState().snapshots.delete(getSessionFile(ctx));
}

// Cross-session pattern hint — last N question-strings across ALL sessions.
function getCrossSessionHint(): string {
	const allTurns: { q: string; ts: number }[] = [];
	for (const turns of getState().histories.values()) {
		for (const t of turns) {
			allTurns.push({ q: userMessageText(t.userMessage), ts: t.userMessage.timestamp });
		}
	}
	if (allTurns.length === 0) return "";
	const recent = allTurns.sort((a, b) => a.ts - b.ts).slice(-CROSS_SESSION_HINT_LIMIT);
	const lines = recent.map((t, i) => `${i + 1}. ${t.q.replace(/\s+/g, " ").slice(0, 200)}`);
	return `\n\n## Recent /btw questions across sessions (oldest first)\n\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Executor — auth, message threading, streamSimple, four StopReason branches
// Modeled after rpiv-advisor/advisor.ts:225-336
// ---------------------------------------------------------------------------

export type BtwExecResult =
	| {
			kind: "success";
			answer: string;
			userMessage: UserMessage;
			assistantMessage: AssistantMessage;
			stopReason: StopReason;
			trimmed?: boolean;
	  }
	| { kind: "error"; error: string; stopReason?: StopReason }
	| { kind: "aborted"; stopReason: StopReason };

function readBranchSnapshot(ctx: ExtensionContext): { messages: Message[]; entries: SessionEntry[] } {
	const cached = getSnapshot(ctx);
	if (cached) return cached;
	// Cold start (no message_end fired yet) — fall back to a single live read.
	const branch = ctx.sessionManager.getBranch() as SessionEntry[];
	return { messages: branchToMessages(branch), entries: branch };
}

export interface BtwBuiltContext {
	messages: Message[];
	systemPrompt: string;
	droppedTurns: number;
	branchWasTrimmed: boolean;
	stubbed: boolean;
	keepBudget: number; // halved by the overflow-retry caller to tighten the branch budget
}

export function buildBtwMessages(
	ctx: ExtensionContext,
	userMessage: UserMessage,
	keepBudget?: number,
): BtwBuiltContext {
	// ctx.model is non-null here — executeBtw returns early on !model before calling.
	const model = ctx.model!;
	const history = getSessionHistory(ctx);
	const { messages, entries } = readBranchSnapshot(ctx);
	const systemPrompt = buildSystemPrompt();
	const fitInput = { entries, messages, model, systemPrompt, question: userMessage };

	let capped: CappedHistory;
	let fit: FitBranchResult;
	if (keepBudget === undefined) {
		// Fast-path parity: attempt the FULL history first (an Infinity budget admits
		// every turn) — when the whole request fits the window, the build is
		// byte-identical to the pre-budgeting assembly and the history cap never engages.
		capped = capHistory(history, Number.POSITIVE_INFINITY);
		fit = fitBranch({ ...fitInput, admittedEstimate: capped.estimate });
		if (fit.branchWasTrimmed || fit.stubbed) {
			// Over budget with full history → apply the history cap BEFORE branch
			// trimming, then re-fit the branch against the freed window. When the cap
			// drops nothing the inputs are identical — keep the first fit.
			const recapped = capHistory(history);
			if (recapped.droppedTurns > 0) {
				capped = recapped;
				fit = fitBranch({ ...fitInput, admittedEstimate: recapped.estimate });
			}
		}
	} else {
		// Overflow retry: the sent request has already proven too large — take the
		// capped history and trim/stub the branch straight to the halved budget.
		capped = capHistory(history);
		fit = fitBranch({ ...fitInput, admittedEstimate: capped.estimate, keepBudget });
	}
	const assembled: Message[] = [
		...fit.messages,
		...capped.admitted.flatMap((t) => [t.userMessage, t.assistantMessage]),
		userMessage,
	];
	return {
		messages: assembled,
		systemPrompt,
		droppedTurns: capped.droppedTurns,
		branchWasTrimmed: fit.branchWasTrimmed,
		stubbed: fit.stubbed,
		keepBudget: fit.keepBudget,
	};
}

function buildSystemPrompt(): string {
	return BTW_SYSTEM_PROMPT + getCrossSessionHint();
}

export async function executeBtw(
	question: string,
	ctx: ExtensionContext,
	controller: AbortController,
	onText: (accumulated: string) => void | Promise<void> = () => {},
): Promise<BtwExecResult> {
	const model = ctx.model;
	if (!model) {
		return { kind: "error", error: MSG_NO_MODEL };
	}
	const modelLabel = `${model.provider}:${model.id}`;

	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (controller.signal.aborted) return { kind: "aborted", stopReason: "aborted" };
		if (!auth.ok) {
			return { kind: "error", error: errMisconfigured(modelLabel, auth.error) };
		}
		// OAuth-backed providers resolve `{ ok: true }` with no literal apiKey — their
		// credentials are applied inside Pi's runtime facade. A missing key is only
		// fatal on legacy hosts without that facade, where the global completion
		// fallback needs the key passed explicitly.
		const runtimeStreamSimple = getRuntimeStreamSimple(ctx.modelRegistry);
		if (!auth.apiKey && !runtimeStreamSimple) {
			return { kind: "error", error: errNoApiKey(modelLabel) };
		}

		const userMessage: UserMessage = {
			role: "user",
			content: [{ type: "text", text: question }],
			timestamp: Date.now(),
		};
		// `let` because the overflow retry reassigns `built` with a halved budget;
		// buildBtwMessages returns BtwBuiltContext { messages, systemPrompt,
		// droppedTurns, branchWasTrimmed, stubbed, keepBudget }.
		let built = buildBtwMessages(ctx, userMessage);

		// Prefer Pi's auth-aware runtime facade (resolved once above, before the
		// missing-key guard). Unlike the global compatibility function, it runs
		// request preparation and applies credential-derived fields — OAuth
		// tokens, GitHub Copilot's OAuth-specific baseUrl. Do not pass the
		// preflight key/headers to that path: explicit overrides would bypass
		// that resolution.
		const streamSimple = runtimeStreamSimple ?? (await loadStreamSimple());
		const requestOptions = runtimeStreamSimple
			? { signal: controller.signal } // own AbortController, NOT ctx.signal
			: { apiKey: auth.apiKey, headers: auth.headers, signal: controller.signal };
		const overflowFn = await loadIsContextOverflow();
		const callStreamSimple = async (
			built: BtwBuiltContext,
		): Promise<{ kind: "aborted"; stopReason: StopReason } | { kind: "completed"; response: AssistantMessage }> => {
			if (controller.signal.aborted) return { kind: "aborted", stopReason: "aborted" };
			const stream = streamSimple(
				model,
				{ systemPrompt: built.systemPrompt, messages: built.messages, tools: [] },
				requestOptions,
			);
			let response: AssistantMessage | undefined;
			let accumulated = "";
			for await (const event of stream) {
				if (controller.signal.aborted) return { kind: "aborted", stopReason: "aborted" };
				if (event.type === "text_start" && accumulated) accumulated += "\n";
				if (event.type === "text_delta") {
					accumulated += event.delta;
					await onText(accumulated);
				}
				// Keep the provider's final object, including usage and signatures,
				// for reference-identical history. Deltas are display-only.
				if (event.type === "done") response = event.message;
				if (event.type === "error") response = event.error;
			}
			if (controller.signal.aborted) return { kind: "aborted", stopReason: "aborted" };
			if (!response) throw new Error(ERR_NO_FINAL_MESSAGE);
			if (response.stopReason === "aborted") {
				return { kind: "aborted", stopReason: response.stopReason };
			}
			return { kind: "completed", response };
		};
		let outcome = await callStreamSimple(built);
		if (outcome.kind === "aborted") return outcome;
		let response = outcome.response;
		// Overflow gate — exactly one retry. On the first response the host flags
		// as context overflow (any stopReason), rebuild the branch context with a
		// halved keepBudget and re-call once. The second result is handled directly,
		// so no third call is possible. Stream and loader throws land in the surrounding
		// catch. /btw's fresh side call retries all three overflow stopReasons
		// (error/stop/length), a deliberate divergence from the host's
		// stopReason-based willRetry.
		if (overflowFn?.(response, model.contextWindow)) {
			await onText(""); // a retry replaces any partial answer from the first attempt
			built = buildBtwMessages(ctx, userMessage, Math.floor(built.keepBudget / 2));
			outcome = await callStreamSimple(built);
			if (outcome.kind === "aborted") return outcome;
			response = outcome.response;
		}
		if (response.stopReason === "error") {
			return {
				kind: "error",
				error: errCallFailed(response.errorMessage),
				stopReason: response.stopReason,
			};
		}

		const answerText = assistantMessageText(response).trim();
		if (!answerText) {
			return { kind: "error", error: ERR_EMPTY_RESPONSE, stopReason: response.stopReason };
		}

		return {
			kind: "success",
			answer: answerText,
			userMessage,
			assistantMessage: response,
			stopReason: response.stopReason,
			trimmed: built.droppedTurns > 0 || built.branchWasTrimmed || built.stubbed,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (controller.signal.aborted) {
			return { kind: "aborted", stopReason: "aborted" as const };
		}
		return { kind: "error", error: errCallThrew(message) };
	}
}

// ---------------------------------------------------------------------------
// Registrars — command, message_end snapshot, compact/tree invalidation, shutdown cleanup
// ---------------------------------------------------------------------------

export function registerMessageEndSnapshot(pi: ExtensionAPI): void {
	pi.on("message_end", async (event, ctx) => {
		const msg = event.message;
		if (msg.role !== "assistant") return;
		if ((msg as AssistantMessage).stopReason === "toolUse") return;
		const branch = ctx.sessionManager.getBranch() as SessionEntry[];
		setSnapshot(ctx, { messages: branchToMessages(branch), entries: branch });
	});
}

export function registerInvalidationHooks(pi: ExtensionAPI): void {
	pi.on("session_compact", async (_e, ctx) => safeInvalidateSnapshot(ctx));
	pi.on("session_tree", async (_e, ctx) => safeInvalidateSnapshot(ctx));
}

// Auto-compaction races session disposal: pi-core invalidates the extension
// runner while still emitting session_compact, so `ctx` may be a dead proxy
// whose getters throw the stale error. The compacting session is being
// discarded — there is no snapshot worth invalidating — so swallow only the
// stale error. Any other error is a real bug and must propagate.
function safeInvalidateSnapshot(ctx: ExtensionContext): void {
	try {
		invalidateSnapshot(ctx);
	} catch (e) {
		if (!isStaleCtxError(e)) throw e;
	}
}

// pi-core's ExtensionRunner throws this exact phrase from an invalidated ctx
// proxy after session replacement/reload. Match the stable substring.
function isStaleCtxError(e: unknown): boolean {
	return /stale after session replacement/.test(String(e));
}

export function registerBtwCommand(pi: ExtensionAPI): void {
	let activeController: AbortController | undefined;
	// Pi emits shutdown before replacing the session or reloading extensions.
	// Cancel while ctx is still live, so neither the wait timer nor late tokens
	// can access the old session after its context has been invalidated.
	pi.on("session_shutdown", async () => activeController?.abort());
	pi.registerCommand(BTW_COMMAND_NAME, {
		description: "Ask a side question without polluting the main conversation",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (activeController) {
				ctx.ui.notify(MSG_ALREADY_RUNNING, "warning");
				return;
			}
			const controller = new AbortController();
			activeController = controller;
			try {
				await handleBtwCommand(args, ctx, controller);
			} finally {
				activeController = undefined;
			}
		},
	});
}

async function handleBtwCommand(
	args: string,
	ctx: ExtensionCommandContext,
	controller: AbortController,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(MSG_REQUIRES_INTERACTIVE, "error");
		return;
	}
	const question = args.trim();
	if (!question) {
		ctx.ui.notify(MSG_USAGE, "warning");
		return;
	}
	if (!ctx.model) {
		ctx.ui.notify(MSG_NO_MODEL, "error");
		return;
	}

	const historySnapshot = [...getSessionHistory(ctx)];
	const stopWaiting = startBtwWaiting(ctx, question);
	controller.signal.addEventListener("abort", stopWaiting, { once: true });
	let overlayPromise: Promise<void> | undefined;
	let overlayController: BtwOverlayController | undefined;
	const showAnswer = async (text: string): Promise<void> => {
		if (controller.signal.aborted) return;
		if (overlayController) {
			overlayController.setAnswer(text);
			return;
		}
		if (!text) return; // empty deltas and overflow resets must not take editor focus
		stopWaiting();
		const shown = showBtwOverlay({
			ctx,
			question,
			answer: text,
			history: historySnapshot,
			controller,
			onClearHistory: () => clearSessionHistory(ctx),
		});
		overlayPromise = shown.overlayPromise;
		overlayController = await shown.controllerReady;
	};

	let result: BtwExecResult;
	try {
		result = await executeBtw(question, ctx, controller, showAnswer);
	} finally {
		stopWaiting();
		controller.signal.removeEventListener("abort", stopWaiting);
	}
	if (controller.signal.aborted) return;

	switch (result.kind) {
		case "success": {
			await showAnswer(result.answer);
			if (controller.signal.aborted) return;
			if (result.trimmed) overlayController?.setTrimmed(); // success-only: TS narrows result here
			pushSessionTurn(ctx, {
				userMessage: result.userMessage,
				assistantMessage: result.assistantMessage,
			});
			// No disk persistence — process-scoped only
			break;
		}
		case "aborted": {
			// User Esc'd — overlay already dismissed via done(); no further action
			break;
		}
		case "error": {
			if (overlayController) overlayController.setError(result.error);
			else ctx.ui.notify(result.error, "error");
			break;
		}
	}

	await overlayPromise;
}
