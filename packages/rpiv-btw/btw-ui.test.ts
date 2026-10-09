import { stripVTControlCharacters } from "node:util";
import {
	type ExtensionCommandContext,
	type ExtensionUIContext,
	initTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { createMockCtx, makeAssistantMessage, makeTheme, makeUserMessage } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BtwTurn } from "./btw.js";
import { BtwOverlayController, showBtwOverlay, startBtwWaiting } from "./btw-ui.js";

const theme = makeTheme() as Theme;
const turn = (question: string): BtwTurn => ({
	userMessage: makeUserMessage(question),
	assistantMessage: makeAssistantMessage({ text: "previous answer" }),
});

function makeController(options: { question?: string; answer?: string; history?: BtwTurn[]; rows?: number } = {}) {
	const terminal = { rows: options.rows ?? 24 };
	const tui = { requestRender: vi.fn(), terminal } as unknown as TUI;
	const done = vi.fn();
	const controller = new AbortController();
	const onClearHistory = vi.fn();
	const card = new BtwOverlayController(
		options.question ?? "what?",
		options.answer ?? "answer",
		options.history ?? [],
		theme,
		tui,
		done,
		controller,
		onClearHistory,
	);
	const render = (width = 80): string[] => card.render(width).map(stripVTControlCharacters);
	return { card, render, tui, terminal, done, controller, onClearHistory };
}

beforeEach(() => initTheme("dark"));
afterEach(() => vi.useRealTimers());

describe("BtwOverlayController", () => {
	it("renders Markdown headings, emphasis, code and lists inside a frame", () => {
		const { render } = makeController({
			rows: 80,
			answer: "# Heading\n\n**bold** and `code`\n\n- item\n\n```ts\nconst answer = 42;\n```",
		});
		const lines = render();
		const text = lines.join("\n");
		expect(lines[0]).toMatch(/^╭.*╮$/);
		expect(lines.at(-1)).toMatch(/^╰.*╯$/);
		expect(text).toContain("bold and code");
		expect(text).toContain("const answer = 42;");
		expect(text).not.toContain("**bold**");
		expect(text).not.toContain("# Heading");
		expect(text).toContain("Esc to dismiss");
	});

	it("grows with a short answer without advertising unnecessary scrolling", () => {
		const { card, render } = makeController();
		expect(render()).toHaveLength(7);
		expect(render().join("\n")).not.toContain("to scroll");
		card.setAnswer("one\n\ntwo");
		expect(render().length).toBeGreaterThan(7);
	});

	it.each([8, 12, 40, 80])("keeps every row within %i visible columns, including Unicode and long code", (width) => {
		const { card } = makeController({
			question: "界🙂 é".repeat(50),
			history: [turn("multi\nline 界".repeat(50))],
			answer: `**界🙂**\n\n\`\`\`\n${"x".repeat(200)}\n\`\`\``,
		});
		for (const line of card.render(width)) expect(visibleWidth(line)).toBe(width);
	});

	it("follows streaming text, keeps scrolled-up content still, and resumes following at the bottom", () => {
		const { card, render } = makeController();
		const body = Array.from({ length: 30 }, (_, index) => `row-${String(index + 1).padStart(2, "0")}`).join("\n");
		card.setAnswer(body);
		expect(render().join("\n")).toContain("row-30");
		for (let index = 0; index < 100; index++) card.handleInput("\u001b[A");
		const top = render();
		expect(top.join("\n")).toContain("row-01");
		expect(top.join("\n")).not.toContain("row-30");
		expect(top[1]).toContain("/btw what?");
		expect(top.at(-2)).toContain("Esc to dismiss");
		card.setAnswer(`${body}\nrow-31`);
		expect(render()).toEqual(top);
		for (let index = 0; index < 100; index++) card.handleInput("\u001b[B");
		card.setAnswer(`${body}\nrow-31\nrow-32`);
		expect(render().join("\n")).toContain("row-32");
	});

	it("reflows on resize without losing the title, footer or newest text", () => {
		const { card, render, terminal } = makeController({ answer: "word ".repeat(100), rows: 40 });
		expect(render(80).length).toBeLessThanOrEqual(28);
		terminal.rows = 16;
		const narrow = render(40);
		expect(narrow.length).toBeLessThanOrEqual(11);
		expect(narrow[1]).toContain("/btw what?");
		expect(narrow.at(-2)).toContain("Esc to dismiss");
		card.invalidate();
		expect(render(40)).toEqual(narrow);
	});

	it("keeps a dismiss hint visible even when the terminal is too short for the full frame", () => {
		const { render } = makeController({ answer: "word ".repeat(100), rows: 8 });
		const lines = render();
		expect(lines.length).toBeLessThanOrEqual(Math.floor(8 * 0.7));
		expect(lines.join("\n")).toContain("Esc to dismiss");
	});

	it("renders errors and adds the trim notice only once", () => {
		const { card, render, tui } = makeController();
		const before = render().length;
		card.setTrimmed();
		card.setTrimmed();
		expect(render()).toHaveLength(before + 1);
		expect(render().join("\n")).toContain("context trimmed to fit budget");
		card.setError("remote failed");
		expect(render().join("\n")).toContain("remote failed");
		expect(tui.requestRender).toHaveBeenCalled();
	});

	it("clears history only on lowercase x and collapses pasted question whitespace", () => {
		const { card, render, onClearHistory } = makeController({ history: [turn(" multi\nline   question ")] });
		expect(render().join("\n")).toContain("/btw multi line question");
		card.handleInput("X");
		expect(onClearHistory).not.toHaveBeenCalled();
		card.handleInput("x");
		expect(onClearHistory).toHaveBeenCalledOnce();
		expect(render().join("\n")).not.toContain("multi line question");
		expect(render().join("\n")).not.toContain("clear history");
	});

	it.each(["escape", "shutdown", "dispose"])("cancels the side call on %s", (reason) => {
		const { card, controller, done } = makeController();
		if (reason === "escape") card.handleInput("\u001b");
		if (reason === "shutdown") controller.abort();
		if (reason === "dispose") card.dispose();
		expect(controller.signal.aborted).toBe(true);
		if (reason !== "dispose") expect(done).toHaveBeenCalledOnce();
	});
});

describe("waiting status", () => {
	it("animates only the shared footer and stops idempotently", () => {
		vi.useFakeTimers();
		const ctx = createMockCtx({ ui: { theme } }) as ExtensionCommandContext;
		const stop = startBtwWaiting(ctx, "a\nquestion");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("btw", "⠋ btw a question");
		vi.advanceTimersByTime(80);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("btw", "⠙ btw a question");
		expect(ctx.ui.setWidget).not.toHaveBeenCalled();
		expect(ctx.ui.onTerminalInput).not.toHaveBeenCalled();
		stop();
		stop();
		vi.advanceTimersByTime(500);
		expect(ctx.ui.setStatus).toHaveBeenCalledTimes(3);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("btw", undefined);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("showBtwOverlay", () => {
	it("mounts the real controller as a centered 90%-wide card", async () => {
		const custom = vi.fn((factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
			factory(
				{ requestRender: vi.fn(), terminal: { rows: 24 } } as unknown as TUI,
				theme,
				undefined as never,
				vi.fn(),
			);
			return Promise.resolve();
		});
		const shown = showBtwOverlay({
			ctx: createMockCtx({ ui: { custom: custom as ExtensionUIContext["custom"] } }) as ExtensionCommandContext,
			question: "question",
			answer: "answer",
			history: [],
			controller: new AbortController(),
			onClearHistory: vi.fn(),
		});
		expect(await shown.controllerReady).toBeInstanceOf(BtwOverlayController);
		expect(custom).toHaveBeenCalledWith(expect.any(Function), {
			overlay: true,
			overlayOptions: { anchor: "center", width: "90%", maxHeight: "70%" },
		});
	});
});
