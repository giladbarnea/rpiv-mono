import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { makeTui } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BtwTurn } from "./btw.js";
import { BtwOverlayController, showBtwOverlay, startBtwWaiting } from "./btw-ui.js";

const identityTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
} as unknown as Theme;

function makeTurn(question: string, answer = "answer"): BtwTurn {
	return {
		userMessage: { role: "user", content: question, timestamp: 0 },
		assistantMessage: {
			role: "assistant",
			content: [{ type: "text", text: answer }],
			api: "anthropic" as never,
			provider: "anthropic" as never,
			model: "m",
			usage: {} as never,
			stopReason: "done" as never,
			timestamp: 0,
		},
	};
}

function makeController(
	options: { question?: string; answer?: string; history?: BtwTurn[]; tui?: TUI; rows?: number } = {},
) {
	const tui = options.tui ?? (makeTui() as unknown as TUI);
	(tui as unknown as { terminal: { rows: number } }).terminal = { rows: options.rows ?? 24 };
	const done = vi.fn();
	const abortController = new AbortController();
	const onClearHistory = vi.fn();
	const controller = new BtwOverlayController(
		options.question ?? "what?",
		options.answer ?? "answer",
		options.history ?? [],
		identityTheme,
		tui,
		done,
		abortController,
		onClearHistory,
	);
	return { controller, tui, done, abortController, onClearHistory };
}

beforeAll(() => {
	initTheme();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("startBtwWaiting", () => {
	it("shows a footer spinner and lets Escape cancel before the overlay opens", () => {
		vi.useFakeTimers();
		const setStatus = vi.fn();
		const unsubscribe = vi.fn();
		let inputListener: ((data: string) => unknown) | undefined;
		const ctx = {
			ui: {
				theme: identityTheme,
				setStatus,
				onTerminalInput: vi.fn((listener: (data: string) => unknown) => {
					inputListener = listener;
					return unsubscribe;
				}),
			},
		} as never;
		const abortController = new AbortController();

		const stop = startBtwWaiting(ctx, "what is this?", abortController);

		expect(setStatus).toHaveBeenLastCalledWith("btw", "⠋ btw what is this?");
		vi.advanceTimersByTime(80);
		expect(setStatus).toHaveBeenLastCalledWith("btw", "⠙ btw what is this?");
		expect(inputListener?.("\u001b")).toEqual({ consume: true });
		expect(abortController.signal.aborted).toBe(true);

		stop();
		stop();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		expect(setStatus).toHaveBeenLastCalledWith("btw", undefined);
	});

	it("continues and stops after the command context becomes stale", () => {
		vi.useFakeTimers();
		const setStatus = vi.fn();
		const unsubscribe = vi.fn();
		const ui = {
			theme: identityTheme,
			setStatus,
			onTerminalInput: vi.fn(() => unsubscribe),
		};
		let stale = false;
		const ctx = {
			get ui() {
				if (stale) throw new Error("stale command context");
				return ui;
			},
		} as never;
		const stop = startBtwWaiting(ctx, "what is this?", new AbortController());

		stale = true;
		expect(() => vi.advanceTimersByTime(80)).not.toThrow();
		expect(() => stop()).not.toThrow();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		expect(setStatus).toHaveBeenLastCalledWith("btw", undefined);
	});

	it("caps the question at 60 columns and ignores other keys", () => {
		let inputListener: ((data: string) => unknown) | undefined;
		const setStatus = vi.fn();
		const ctx = {
			ui: {
				theme: identityTheme,
				setStatus,
				onTerminalInput: vi.fn((listener: (data: string) => unknown) => {
					inputListener = listener;
					return vi.fn();
				}),
			},
		} as never;
		const abortController = new AbortController();

		const stop = startBtwWaiting(ctx, "a".repeat(100), abortController);
		const status = String(setStatus.mock.calls[0][1]);

		expect(status).toContain("…");
		expect(visibleWidth(status)).toBeLessThanOrEqual(66);
		expect(inputListener?.("z")).toBeUndefined();
		expect(abortController.signal.aborted).toBe(false);
		stop();
	});
});

describe("BtwOverlayController", () => {
	it("renders Markdown inside a bordered card", () => {
		const { controller } = makeController({ question: "what?", answer: "**forty-two**" });

		const output = controller.render(80);

		expect(output[0]).toContain("╭");
		expect(output.at(-1)).toContain("╰");
		expect(output.join("\n")).toContain("/btw what?");
		expect(output.join("\n")).toContain("forty-two");
		expect(output.join("\n")).not.toContain("**");
		expect(output.every((line) => visibleWidth(line) === 80)).toBe(true);
	});

	it("uses content height for a short answer", () => {
		const { controller } = makeController({ rows: 100 });
		expect(controller.render(80)).toHaveLength(7);
	});

	it("caps the card at 70 percent of the terminal height", () => {
		const history = Array.from({ length: 40 }, (_, index) => makeTurn(`history-${index}`));
		const { controller } = makeController({ history, rows: 40 });
		expect(controller.render(80)).toHaveLength(28);
		expect(controller.render(80).join("\n")).toContain("↑/↓ to scroll");
	});

	it("updates the rendered Markdown as text streams", () => {
		const { controller, tui } = makeController({ answer: "first" });
		controller.setAnswer("first and **second**");
		const output = controller.render(80).join("\n");
		expect(output).toContain("first and second");
		expect(output).not.toContain("**");
		expect(tui.requestRender).toHaveBeenCalled();
	});

	it("keeps the newest streamed content visible until the user scrolls", () => {
		const history = Array.from({ length: 30 }, (_, index) => makeTurn(`marker-${String(index).padStart(2, "0")}`));
		const { controller } = makeController({ history, answer: "initial", rows: 20 });
		const initial = controller.render(80).join("\n");
		expect(initial).toContain("initial");

		controller.handleInput("\u001b[A");
		const scrolled = controller.render(80).join("\n");
		controller.setAnswer("new-tail");
		expect(controller.render(80).join("\n")).toBe(scrolled);

		controller.handleInput("\u001b[B");
		controller.setAnswer("new-tail");
		expect(controller.render(80).join("\n")).toContain("new-tail");
	});

	it("renders an error inside the existing card", () => {
		const { controller, tui } = makeController();
		controller.setError("upstream failed");
		expect(controller.render(80).join("\n")).toContain("upstream failed");
		expect(tui.requestRender).toHaveBeenCalled();
	});

	it("adds the context-trim notice without replacing the answer", () => {
		const { controller, tui } = makeController({ answer: "answer-body", rows: 100 });
		const before = controller.render(80).length;
		controller.setTrimmed();
		const output = controller.render(80);
		expect(output).toHaveLength(before + 1);
		expect(output.join("\n")).toContain("answer-body");
		expect(output.join("\n")).toContain("context trimmed to fit budget");
		expect(tui.requestRender).toHaveBeenCalled();
	});

	it("shows prior questions and clears them with x", () => {
		const { controller, onClearHistory } = makeController({ history: [makeTurn("  multi\nline   question  ")] });
		expect(controller.render(80).join("\n")).toContain("/btw multi line question");
		expect(controller.render(80).join("\n")).toContain("x to clear history");

		controller.handleInput("x");

		expect(onClearHistory).toHaveBeenCalledTimes(1);
		expect(controller.render(80).join("\n")).not.toContain("multi line question");
		expect(controller.render(80).join("\n")).not.toContain("x to clear history");
	});

	it("aborts and closes on Escape", () => {
		const { controller, abortController, done } = makeController();
		controller.handleInput("\u001b");
		expect(abortController.signal.aborted).toBe(true);
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("ignores unrelated keys", () => {
		const { controller, abortController, done, onClearHistory } = makeController();
		controller.handleInput("z");
		expect(abortController.signal.aborted).toBe(false);
		expect(done).not.toHaveBeenCalled();
		expect(onClearHistory).not.toHaveBeenCalled();
	});

	it("truncates a long title within the card", () => {
		const { controller } = makeController({ question: "a".repeat(200) });
		const output = controller.render(40);
		expect(output[1]).toContain("…");
		expect(visibleWidth(output[1])).toBe(40);
	});

	it("renders nothing when the terminal is too narrow for the card", () => {
		const { controller } = makeController();
		expect(controller.render(7)).toEqual([]);
	});

	it("invalidates the Markdown render cache", () => {
		const { controller } = makeController();
		expect(() => controller.invalidate()).not.toThrow();
	});
});

describe("showBtwOverlay", () => {
	it("opens a centered 90 percent card capped at 70 percent height", () => {
		let factoryController: BtwOverlayController | undefined;
		let options: unknown;
		const custom = vi.fn((factory: unknown, receivedOptions: unknown) => {
			const build = factory as (
				tui: TUI,
				theme: Theme,
				keybindings: undefined,
				done: (value?: undefined) => void,
			) => BtwOverlayController;
			factoryController = build(
				{ requestRender: vi.fn(), terminal: { rows: 24 } } as unknown as TUI,
				identityTheme,
				undefined,
				() => {},
			);
			options = receivedOptions;
			return Promise.resolve();
		});
		const ctx = { ui: { custom } } as never;

		const shown = showBtwOverlay({
			ctx,
			question: "q",
			answer: "answer",
			history: [],
			controller: new AbortController(),
			onClearHistory: vi.fn(),
		});

		expect(shown.controller).toBe(factoryController);
		expect(options).toMatchObject({
			overlay: true,
			overlayOptions: { anchor: "center", width: "90%", maxHeight: "70%" },
		});
	});
});
