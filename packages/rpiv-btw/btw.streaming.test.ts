import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createMockCtx, makeAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { executeBtw } from "./btw.js";

describe("executeBtw streaming", () => {
	it("streams with keyless OAuth through the runtime without overriding credential-derived fields", async () => {
		const response = makeAssistantMessage({ text: "OAuth answer" });
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "text_delta", contentIndex: 0, delta: "OAuth answer", partial: response });
		stream.push({ type: "done", reason: "stop", message: response });
		const runtime = { streamSimple: vi.fn(() => stream) };
		const ctx = createMockCtx();
		ctx.model = { provider: "oauth-provider", id: "model", contextWindow: 200000, maxTokens: 8192 } as never;
		ctx.modelRegistry = {
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true })),
		} as never;
		Object.defineProperty(ctx.modelRegistry, "runtime", { value: runtime });
		const controller = new AbortController();
		const onText = vi.fn();

		const result = await executeBtw("question", ctx, controller, onText);

		expect(result.kind).toBe("success");
		expect(onText).toHaveBeenCalledWith("OAuth answer");
		if (result.kind !== "success") throw new Error("expected OAuth answer");
		expect(result.assistantMessage).toBe(response);
		expect(runtime.streamSimple).toHaveBeenCalledWith(ctx.model, expect.objectContaining({ tools: [] }), {
			signal: controller.signal,
		});
	});

	it("does not dispatch a request if shutdown happens during credential lookup", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "test", id: "model" } as never;
		let releaseAuth!: () => void;
		const auth = new Promise<{ ok: true; apiKey: string }>((resolve) => {
			releaseAuth = () => resolve({ ok: true, apiKey: "test-key" });
		});
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message: makeAssistantMessage({ text: "too late" }) });
		const runtime = { streamSimple: vi.fn(() => stream) };
		ctx.modelRegistry = { getApiKeyAndHeaders: vi.fn(() => auth) } as never;
		Object.defineProperty(ctx.modelRegistry, "runtime", { value: runtime });
		const controller = new AbortController();
		const running = executeBtw("q", ctx, controller);
		controller.abort();
		releaseAuth();
		expect(await running).toMatchObject({ kind: "aborted" });
		expect(runtime.streamSimple).not.toHaveBeenCalled();
	});

	it("clears partial text on the single overflow retry and keeps using OAuth-aware streaming", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "test", id: "model", contextWindow: 200000, maxTokens: 8192 } as never;
		const first = createAssistantMessageEventStream();
		const partial = makeAssistantMessage({ text: "discard this" });
		first.push({ type: "text_delta", contentIndex: 0, delta: "discard this", partial });
		first.push({
			type: "error",
			reason: "error",
			error: { ...partial, stopReason: "error", errorMessage: "prompt is too long" },
		});
		const second = createAssistantMessageEventStream();
		const final = makeAssistantMessage({ text: "retry answer" });
		second.push({ type: "text_delta", contentIndex: 0, delta: "retry answer", partial: final });
		second.push({ type: "done", reason: "stop", message: final });
		const streamSimple = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
		Object.defineProperty(ctx.modelRegistry, "runtime", { value: { streamSimple } });
		const onText = vi.fn();
		const controller = new AbortController();
		const result = await executeBtw("q", ctx, controller, onText);
		expect(result).toMatchObject({ kind: "success", answer: "retry answer" });
		expect(onText.mock.calls.map(([text]) => text)).toEqual(["discard this", "", "retry answer"]);
		expect(streamSimple).toHaveBeenCalledTimes(2);
		for (const call of streamSimple.mock.calls) expect(call[2]).toEqual({ signal: controller.signal });
	});

	it("reports a stream that ends without a final message", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "test", id: "model" } as never;
		const stream = createAssistantMessageEventStream();
		stream.end();
		Object.defineProperty(ctx.modelRegistry, "runtime", { value: { streamSimple: () => stream } });
		expect(await executeBtw("q", ctx, new AbortController())).toEqual({
			kind: "error",
			error: "/btw call threw: stream ended without a final message",
		});
	});

	it("preserves separate text blocks while streaming, just as the final answer does", async () => {
		const ctx = createMockCtx();
		ctx.model = { provider: "test", id: "model" } as never;
		const stream = createAssistantMessageEventStream();
		const final = makeAssistantMessage({ text: "first" });
		final.content.push({ type: "text", text: "second" });
		stream.push({ type: "text_start", contentIndex: 0, partial: final });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "first", partial: final });
		stream.push({ type: "text_start", contentIndex: 1, partial: final });
		stream.push({ type: "text_delta", contentIndex: 1, delta: "second", partial: final });
		stream.push({ type: "done", reason: "stop", message: final });
		Object.defineProperty(ctx.modelRegistry, "runtime", { value: { streamSimple: () => stream } });
		const onText = vi.fn();
		const result = await executeBtw("q", ctx, new AbortController(), onText);
		expect(result).toMatchObject({ kind: "success", answer: "first\nsecond" });
		expect(onText.mock.calls.map(([text]) => text)).toEqual(["first", "first\nsecond"]);
	});
});
