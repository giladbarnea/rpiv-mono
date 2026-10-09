import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
	type ExtensionCommandContext,
	type ExtensionUIContext,
	initTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	buildSessionEntries,
	createMockCtx,
	createMockPi,
	makeAssistantMessage,
	makeTheme,
	makeUserMessage,
} from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBtwMessages, registerBtwCommand } from "./btw.js";

const openStreams: AssistantMessageEventStream[] = [];
const closeOverlays: Array<() => void> = [];

beforeEach(() => {
	initTheme("dark");
	vi.useFakeTimers();
});
afterEach(() => {
	for (const stream of openStreams.splice(0)) stream.end();
	for (const close of closeOverlays.splice(0)) close();
	vi.useRealTimers();
});

function setup() {
	const { pi, captured } = createMockPi();
	registerBtwCommand(pi);
	const stream = createAssistantMessageEventStream();
	openStreams.push(stream);
	const streamSimple = vi.fn<typeof import("@earendil-works/pi-ai/compat").streamSimple>(() => stream);
	const overlays: Component[] = [];
	const custom = vi.fn<ExtensionUIContext["custom"]>(
		(factory) =>
			new Promise((resolve) => {
				closeOverlays.push(() => resolve(undefined as never));
				const component = factory(
					{ requestRender: vi.fn(), terminal: { rows: 24 } } as unknown as TUI,
					makeTheme() as Theme,
					undefined as never,
					resolve,
				);
				overlays.push(component as Component);
			}),
	);
	const ctx = createMockCtx({
		hasUI: true,
		model: { provider: "test", id: "model", contextWindow: 200000, maxTokens: 8192 } as never,
		ui: { custom: custom as ExtensionUIContext["custom"], theme: makeTheme() as Theme },
	}) as ExtensionCommandContext;
	Object.defineProperty(ctx.modelRegistry, "runtime", { value: { streamSimple } });
	const command = captured.commands.get("btw")!;
	return { pi, captured, ctx, stream, streamSimple, custom, overlays, command };
}

function finish(stream: AssistantMessageEventStream, text: string): AssistantMessage {
	const message = makeAssistantMessage({ text });
	stream.push({ type: "done", reason: "stop", message });
	return message;
}

function textDelta(stream: AssistantMessageEventStream, text: string): void {
	stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: makeAssistantMessage({ text }) });
}

describe("/btw command", () => {
	it.each(["no UI", "no model", "empty question"])("rejects %s before starting the wait", async (reason) => {
		const { command, ctx, custom, streamSimple } = setup();
		if (reason === "no UI") ctx.hasUI = false;
		if (reason === "no model") ctx.model = undefined;
		await command.handler(reason === "empty question" ? "   " : "question", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledOnce();
		expect(ctx.ui.setStatus).not.toHaveBeenCalled();
		expect(custom).not.toHaveBeenCalled();
		expect(streamSimple).not.toHaveBeenCalled();
	});

	it("keeps thinking and empty deltas in the wait phase, then reports an empty response as a toast", async () => {
		const { command, ctx, stream, custom, streamSimple } = setup();
		const running = command.handler("question", ctx);
		await vi.waitFor(() => expect(streamSimple).toHaveBeenCalledOnce());
		stream.push({
			type: "thinking_delta",
			contentIndex: 0,
			delta: "private reasoning",
			partial: makeAssistantMessage({}),
		});
		textDelta(stream, "");
		await vi.advanceTimersByTimeAsync(80);
		expect(custom).not.toHaveBeenCalled();
		finish(stream, "");
		await running;
		expect(ctx.ui.notify).toHaveBeenCalledWith("/btw returned no text content.", "error");
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([false, true])("shows provider errors in the toast or the existing card (card open: %s)", async (opened) => {
		const { command, ctx, stream, custom, overlays, streamSimple } = setup();
		const running = command.handler("question", ctx);
		await vi.waitFor(() => expect(streamSimple).toHaveBeenCalledOnce());
		if (opened) {
			textDelta(stream, "partial");
			await vi.waitFor(() => expect(custom).toHaveBeenCalledOnce());
		}
		stream.push({
			type: "error",
			reason: "error",
			error: { ...makeAssistantMessage({}), stopReason: "error", errorMessage: "remote 502" },
		});
		await vi.advanceTimersByTimeAsync(0);
		if (opened) {
			expect(overlays[0].render(80).join("\n")).toContain("remote 502");
			expect(ctx.ui.notify).not.toHaveBeenCalled();
			overlays[0].handleInput?.("\u001b");
		} else {
			expect(ctx.ui.notify).toHaveBeenCalledWith("/btw call failed: remote 502", "error");
			expect(custom).not.toHaveBeenCalled();
		}
		await running;
		expect(buildBtwMessages(ctx, makeUserMessage("next")).messages).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("Esc after the first token aborts only the side call and drops late text and history", async () => {
		const { command, ctx, stream, streamSimple, overlays, custom } = setup();
		const mainController = new AbortController();
		Object.defineProperty(ctx, "signal", { value: mainController.signal });
		const running = command.handler("question", ctx);
		await vi.waitFor(() => expect(streamSimple).toHaveBeenCalledOnce());
		textDelta(stream, "partial");
		await vi.waitFor(() => expect(custom).toHaveBeenCalledOnce());
		overlays[0].handleInput?.("\u001b");
		expect(streamSimple.mock.calls[0][2]?.signal?.aborted).toBe(true);
		expect(mainController.signal.aborted).toBe(false);
		textDelta(stream, "late token");
		finish(stream, "late final");
		await running;
		expect(overlays[0].render(80).join("\n")).not.toContain("late");
		expect(buildBtwMessages(ctx, makeUserMessage("next")).messages).toHaveLength(1);
	});

	it("replays the provider's final message by reference on follow-up and clears it with x", async () => {
		const { command, ctx, stream, streamSimple, overlays, custom } = setup();
		const first = command.handler("first question", ctx);
		await vi.waitFor(() => expect(streamSimple).toHaveBeenCalledOnce());
		const finalMessage = finish(stream, "first answer");
		await vi.waitFor(() => expect(custom).toHaveBeenCalledOnce());
		await vi.advanceTimersByTimeAsync(0);
		overlays[0].handleInput?.("\u001b");
		await first;
		const secondStream = createAssistantMessageEventStream();
		openStreams.push(secondStream);
		streamSimple.mockReturnValueOnce(secondStream);
		const second = command.handler("follow-up", ctx);
		await vi.waitFor(() => expect(streamSimple).toHaveBeenCalledTimes(2));
		const firstRequest = streamSimple.mock.calls[0][1];
		const secondRequest = streamSimple.mock.calls[1][1];
		expect(secondRequest.messages[0]).toBe(firstRequest.messages[0]);
		expect(secondRequest.messages[1]).toBe(finalMessage);
		expect(secondRequest.systemPrompt).toContain("first question");
		finish(secondStream, "second answer");
		await vi.waitFor(() => expect(custom).toHaveBeenCalledTimes(2));
		await vi.advanceTimersByTimeAsync(0);
		overlays[1].handleInput?.("x");
		expect(buildBtwMessages(ctx, makeUserMessage("next")).messages).toHaveLength(1);
		overlays[1].handleInput?.("\u001b");
		await second;
	});

	it("shows the context-trim notice on a successful budgeted request", async () => {
		const { command, ctx, stream, overlays, custom } = setup();
		ctx.model = { ...ctx.model!, contextWindow: 30000, maxTokens: 1000 };
		vi.mocked(ctx.sessionManager.getBranch).mockReturnValue(
			buildSessionEntries([makeUserMessage("context ".repeat(20000))]),
		);
		const running = command.handler("question", ctx);
		finish(stream, "answer");
		await vi.waitFor(() => expect(custom).toHaveBeenCalledOnce());
		await vi.advanceTimersByTimeAsync(0);
		expect(overlays[0].render(80).join("\n")).toContain("context trimmed to fit budget");
		overlays[0].handleInput?.("\u001b");
		await running;
	});

	it("waits in the footer without taking editor keys, then opens the real card on the first text token", async () => {
		const { command, ctx, stream, streamSimple, custom, overlays, pi } = setup();
		const running = command.handler("why?", ctx);
		await vi.waitFor(() => expect(streamSimple).toHaveBeenCalledOnce());
		expect(custom).not.toHaveBeenCalled();
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("btw", expect.stringContaining("why?"));
		expect(ctx.ui.onTerminalInput).not.toHaveBeenCalled();

		textDelta(stream, "**First token**");
		await vi.waitFor(() => expect(custom).toHaveBeenCalledOnce());
		expect(overlays[0].render(80).join("\n")).toContain("First token");
		expect(overlays[0].render(80).join("\n")).not.toContain("**First token**");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("btw", undefined);
		finish(stream, "**First token** and the rest.");
		await vi.waitFor(() => expect(overlays[0].render(80).join("\n")).toContain("and the rest."));
		overlays[0].handleInput?.("\u001b");
		await running;
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stops the wait on session shutdown and discards late tokens without touching a stale context", async () => {
		const { command, captured, ctx, stream, streamSimple, custom } = setup();
		const ui = ctx.ui;
		const running = command.handler("old session", ctx);
		await vi.waitFor(() => expect(streamSimple).toHaveBeenCalledOnce());
		for (const shutdown of captured.events.get("session_shutdown") ?? []) await shutdown({}, ctx);
		expect(ui.setStatus).toHaveBeenLastCalledWith("btw", undefined);
		expect(vi.getTimerCount()).toBe(0);
		Object.defineProperty(ctx, "ui", {
			get: () => {
				throw new Error("stale after session replacement");
			},
		});
		Object.defineProperty(ctx, "sessionManager", {
			get: () => {
				throw new Error("stale after session replacement");
			},
		});
		textDelta(stream, "late text");
		finish(stream, "late final answer");
		await running;
		expect(custom).not.toHaveBeenCalled();
		expect(ui.notify).not.toHaveBeenCalled();
	});

	it("does not start a competing call while the first request owns the footer", async () => {
		const { command, ctx, stream, streamSimple } = setup();
		const running = command.handler("first", ctx);
		await vi.waitFor(() => expect(streamSimple).toHaveBeenCalledOnce());
		const second = command.handler("second", ctx);
		await vi.advanceTimersByTimeAsync(0);
		expect(streamSimple).toHaveBeenCalledOnce();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("already"), "warning");
		stream.push({ type: "error", reason: "aborted", error: { ...makeAssistantMessage({}), stopReason: "aborted" } });
		await Promise.all([running, second]);
	});

	it("reports a credential lookup exception as an early toast and stops the footer", async () => {
		const { command, ctx, custom } = setup();
		vi.mocked(ctx.modelRegistry.getApiKeyAndHeaders).mockRejectedValueOnce(new Error("credential lookup failed"));
		await command.handler("question", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("credential lookup failed"), "error");
		expect(custom).not.toHaveBeenCalled();
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("btw", undefined);
		expect(vi.getTimerCount()).toBe(0);
	});
});
