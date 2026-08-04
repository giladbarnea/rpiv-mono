import type { Api, Model } from "@earendil-works/pi-ai";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./btw-ui.js", () => ({
	showBtwOverlay: vi.fn(),
	startBtwWaiting: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
	return {
		...actual,
		getSupportedThinkingLevels: vi.fn(() => ["off", "minimal", "low", "medium", "high"]),
	};
});

// streamSimple lives on /compat since pi 0.80 (see test/setup.ts).
vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
	return {
		...actual,
		streamSimple: vi.fn(),
	};
});

vi.mock("./pi-compat.js", () => ({
	loadStreamSimple: vi.fn(),
	loadIsContextOverflow: vi.fn(async () => undefined),
}));

import { streamSimple } from "@earendil-works/pi-ai/compat";
import { BTW_COMMAND_NAME, BTW_STATE_KEY, registerBtwCommand } from "./btw.js";
import { showBtwOverlay, startBtwWaiting } from "./btw-ui.js";
import { loadStreamSimple } from "./pi-compat.js";

const model = { provider: "a", id: "m" } as unknown as Model<Api>;

type OverlayCtl = {
	setAnswer: ReturnType<typeof vi.fn>;
	setError: ReturnType<typeof vi.fn>;
	setTrimmed: ReturnType<typeof vi.fn>;
};

function stubOverlay(): OverlayCtl {
	const ctl: OverlayCtl = { setAnswer: vi.fn(), setError: vi.fn(), setTrimmed: vi.fn() };
	vi.mocked(showBtwOverlay).mockReturnValueOnce({
		overlayPromise: Promise.resolve(),
		controller: ctl,
	} as never);
	return ctl;
}

function doneResponse(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		stopReason: "done",
	};
}

function streamResponse(text: string) {
	const response = doneResponse(text);
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "text_delta", delta: text };
			yield { type: "done", message: response };
		},
	};
}

function streamTerminal(response: Record<string, unknown>, delta?: string) {
	return {
		async *[Symbol.asyncIterator]() {
			if (delta) yield { type: "text_delta", delta };
			if (response.stopReason === "error") {
				yield { type: "error", error: response };
				return;
			}
			yield { type: "done", message: response };
		},
	};
}

beforeEach(() => {
	vi.mocked(showBtwOverlay).mockReset();
	vi.mocked(startBtwWaiting).mockReset();
	vi.mocked(streamSimple).mockReset();
	vi.mocked(loadStreamSimple).mockReset();
	vi.mocked(loadStreamSimple).mockResolvedValue(streamSimple as never);
	vi.mocked(startBtwWaiting).mockReturnValue(vi.fn());
});

afterEach(() => {
	delete (globalThis as Record<symbol, unknown>)[BTW_STATE_KEY];
});

function register() {
	const { pi, captured } = createMockPi();
	registerBtwCommand(pi);
	return captured.commands.get(BTW_COMMAND_NAME)!;
}

describe("/btw — early-return branches", () => {
	it("!hasUI notifies error and skips overlay", async () => {
		const cmd = register();
		const ctx = createMockCtx({ hasUI: false, model });
		await cmd.handler("anything", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
		expect(showBtwOverlay).not.toHaveBeenCalled();
	});

	it("empty question emits usage warning", async () => {
		const cmd = register();
		const ctx = createMockCtx({ hasUI: true, model });
		await cmd.handler("   ", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage"), "warning");
		expect(showBtwOverlay).not.toHaveBeenCalled();
	});

	it("missing model notifies error", async () => {
		const cmd = register();
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("hello?", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("active model"), "error");
		expect(showBtwOverlay).not.toHaveBeenCalled();
	});
});

describe("/btw — happy path", () => {
	it("waits in the footer and opens the overlay on the first token", async () => {
		const ctl = stubOverlay();
		const stopWaiting = vi.fn();
		vi.mocked(startBtwWaiting).mockReturnValueOnce(stopWaiting);
		vi.mocked(streamSimple).mockReturnValueOnce(streamResponse("42") as never);
		const cmd = register();
		const ctx = createMockCtx({ hasUI: true, model });
		await cmd.handler("what is 6 times 7?", ctx as never);
		expect(startBtwWaiting).toHaveBeenCalledWith(ctx, "what is 6 times 7?", expect.any(AbortController));
		expect(showBtwOverlay).toHaveBeenCalledTimes(1);
		const params = vi.mocked(showBtwOverlay).mock.calls[0][0];
		expect(params.question).toBe("what is 6 times 7?");
		expect(params.answer).toBe("42");
		expect(params.history).toEqual([]);
		expect(ctl.setAnswer).toHaveBeenCalledWith("42");
		expect(ctl.setError).not.toHaveBeenCalled();
		expect(ctl.setTrimmed).not.toHaveBeenCalled();
		expect(stopWaiting).toHaveBeenCalled();
	});
});

describe("/btw — aborted", () => {
	it("does not open the overlay when aborted before the first token", async () => {
		vi.mocked(streamSimple).mockReturnValueOnce(
			streamTerminal({
				role: "assistant",
				content: [],
				timestamp: Date.now(),
				stopReason: "aborted",
			}) as never,
		);
		const cmd = register();
		const ctx = createMockCtx({ hasUI: true, model });
		await cmd.handler("q", ctx as never);
		expect(showBtwOverlay).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});
});

describe("/btw — executor failure", () => {
	it("notifies an error that arrives before the first token", async () => {
		vi.mocked(streamSimple).mockReturnValueOnce(
			streamTerminal({
				role: "assistant",
				content: [],
				timestamp: Date.now(),
				stopReason: "error",
				errorMessage: "upstream 502",
			}) as never,
		);
		const cmd = register();
		const ctx = createMockCtx({ hasUI: true, model });
		await cmd.handler("q", ctx as never);
		expect(showBtwOverlay).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("upstream 502"), "error");
	});

	it("renders an error that arrives after the overlay opens", async () => {
		const ctl = stubOverlay();
		vi.mocked(streamSimple).mockReturnValueOnce(
			streamTerminal(
				{
					role: "assistant",
					content: [],
					timestamp: Date.now(),
					stopReason: "error",
					errorMessage: "upstream 502",
				},
				"partial",
			) as never,
		);
		const cmd = register();
		const ctx = createMockCtx({ hasUI: true, model });
		await cmd.handler("q", ctx as never);
		expect(ctl.setError).toHaveBeenCalledWith(expect.stringContaining("upstream 502"));
	});
});

describe("/btw — cross-session hint is rendered after turns accumulate", () => {
	it("second invocation's systemPrompt contains the recent-questions section", async () => {
		stubOverlay();
		vi.mocked(streamSimple).mockReturnValueOnce(streamResponse("ans1") as never);
		const cmd = register();
		const ctx = createMockCtx({ hasUI: true, model });
		await cmd.handler("first question", ctx as never);

		stubOverlay();
		vi.mocked(streamSimple).mockReturnValueOnce(streamResponse("ans2") as never);
		await cmd.handler("second question", ctx as never);

		const secondSystemPrompt = vi.mocked(streamSimple).mock.calls[1][1].systemPrompt ?? "";
		expect(secondSystemPrompt).toContain("Recent /btw questions across sessions");
		expect(secondSystemPrompt).toContain("first question");
	});
});
