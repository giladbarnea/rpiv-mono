/**
 * btw-ui — centered, streaming card and footer wait status for /btw.
 *
 * Layout (grows with content, capped at 70% of terminal height):
 *   rounded border
 *   title      — current question                       sticky top
 *   divider
 *   history    — prior "/btw <q>" lines                 scrollable
 *   answer     — Pi Markdown, or error text             scrollable
 *   trim note  — present only on a successful trimmed request
 *   divider
 *   footer     — scroll / clear / dismiss hints         sticky bottom
 *   rounded border
 *
 * Natural content is laid out before clipping. Streaming follows the bottom
 * until the user scrolls up; scrolling back to the bottom resumes following.
 * The title, frame and footer stay visible while the body scrolls.
 * Keys use matchesKey (ANSI + Kitty): Esc aborts only this side call and
 * dismisses, ↑/↓ scroll, and lowercase x clears this session's /btw history.
 */

import { type ExtensionCommandContext, getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	Markdown,
	matchesKey,
	type OverlayOptions,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type BtwTurn, userMessageText } from "./btw-messages.js";

const BTW_MAX_HEIGHT_RATIO = 0.7;
const BTW_OVERLAY_OPTIONS: OverlayOptions = {
	anchor: "center",
	width: "90%",
	maxHeight: `${BTW_MAX_HEIGHT_RATIO * 100}%`,
};
const CHROME_LINES = 6;
const MIN_CARD_WIDTH = 8;
const CARD_PADDING = 4;
const BTW_LITERAL = "/btw";
const BTW_STATUS_KEY = "btw";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const STATUS_QUESTION_MAX_WIDTH = 60;
const FOOTER_SCROLL = "↑/↓ to scroll";
const FOOTER_CLEAR = "x to clear history";
const FOOTER_DISMISS = "Esc to dismiss";
const FOOTER_SEP = " · ";
const MSG_TRIMMED = "context trimmed to fit budget";

type Mode = "answer" | "error";

/** Collapse pasted questions onto one terminal line, e.g. "a\n b" → "a b". */
const collapseWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

export function startBtwWaiting(ctx: ExtensionCommandContext, question: string): () => void {
	// Capture the UI while ctx is live: session replacement invalidates its getters.
	const ui = ctx.ui;
	let frame = 0;
	const paint = (): void => {
		const label = ui.theme.fg("accent", "btw");
		const shortQuestion = truncateToWidth(collapseWhitespace(question), STATUS_QUESTION_MAX_WIDTH, "…", false);
		ui.setStatus(BTW_STATUS_KEY, `${SPINNER_FRAMES[frame]} ${label} ${ui.theme.fg("muted", shortQuestion)}`);
	};
	paint();
	const timer = setInterval(() => {
		frame = (frame + 1) % SPINNER_FRAMES.length;
		paint();
	}, SPINNER_INTERVAL_MS);
	// No input hook here: the editor remains usable until the first text token.
	// In particular Esc keeps Pi's normal behavior, rather than silently aborting /btw.
	let stopped = false;
	return () => {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
		ui.setStatus(BTW_STATUS_KEY, undefined);
	};
}

export interface ShowBtwOverlayParams {
	ctx: ExtensionCommandContext;
	question: string;
	answer: string;
	history: BtwTurn[];
	controller: AbortController;
	onClearHistory: () => void;
}

export interface ShowBtwOverlayResult {
	overlayPromise: Promise<void>;
	controllerReady: Promise<BtwOverlayController>;
}

export class BtwOverlayController implements Component {
	private mode: Mode = "answer";
	private error = "";
	private scrollOffset = 0;
	private autoScroll = true;
	private maxScroll = 0;
	private trimmed = false;
	private history: BtwTurn[];
	private readonly markdown: Markdown;
	private readonly dismiss = (): void => this.done();

	constructor(
		private readonly question: string,
		answer: string,
		history: BtwTurn[],
		private readonly theme: Theme,
		private readonly tui: TUI,
		private readonly done: (result?: undefined) => void,
		private readonly controller: AbortController,
		private readonly onClearHistory: () => void,
	) {
		this.history = [...history];
		this.markdown = new Markdown(answer, 0, 0, getMarkdownTheme());
		this.controller.signal.addEventListener("abort", this.dismiss, { once: true });
	}

	setAnswer(text: string): void {
		this.mode = "answer";
		this.markdown.setText(text);
		this.tui.requestRender();
	}

	setError(message: string): void {
		this.mode = "error";
		this.error = message;
		this.tui.requestRender();
	}

	// Orthogonal to mode: a trimmed result is also a successful answer.
	// Idempotent; each /btw command builds a fresh controller, so no reset is needed.
	setTrimmed(): void {
		this.trimmed = true;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.controller.abort();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.autoScroll = false;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.scrollOffset = Math.min(this.maxScroll, this.scrollOffset + 1);
			this.autoScroll = this.scrollOffset >= this.maxScroll;
			this.tui.requestRender();
			return;
		}
		if (data === "x") {
			this.history = [];
			this.onClearHistory();
			this.autoScroll = true;
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		if (width < MIN_CARD_WIDTH) return [];
		const innerWidth = width - CARD_PADDING;
		const row = (content: string): string =>
			this.theme.fg("border", "│") +
			" " +
			truncateToWidth(content, innerWidth, "…", true) +
			" " +
			this.theme.fg("border", "│");

		const content = this.contentLines(innerWidth);
		const maxRows = Math.max(1, Math.floor(this.tui.terminal.rows * BTW_MAX_HEIGHT_RATIO));
		// On very short terminals keep content and dismissal usable, not a clipped frame.
		const compact = maxRows <= CHROME_LINES;
		const viewport = Math.max(0, Math.min(content.length, maxRows - (compact ? 1 : CHROME_LINES)));
		this.maxScroll = Math.max(0, content.length - viewport);
		if (this.autoScroll) this.scrollOffset = this.maxScroll;
		this.scrollOffset = Math.min(this.scrollOffset, this.maxScroll);
		const visible = content.slice(this.scrollOffset, this.scrollOffset + viewport);
		if (compact) {
			return [...visible, this.footerLine(this.maxScroll > 0)].map((line) =>
				truncateToWidth(line, width, "…", true),
			);
		}
		const divider = row(this.theme.fg("borderMuted", "─".repeat(innerWidth)));
		return [
			this.theme.fg("border", `╭${"─".repeat(width - 2)}╮`),
			row(this.titleLine(innerWidth)),
			divider,
			...visible.map(row),
			divider,
			row(this.footerLine(this.maxScroll > 0)),
			this.theme.fg("border", `╰${"─".repeat(width - 2)}╯`),
		];
	}

	invalidate(): void {
		this.markdown.invalidate();
	}

	dispose(): void {
		this.controller.signal.removeEventListener("abort", this.dismiss);
		this.controller.abort();
	}

	private contentLines(innerWidth: number): string[] {
		const lines = this.history.map((turn) =>
			this.theme.fg("muted", `${BTW_LITERAL} ${collapseWhitespace(userMessageText(turn.userMessage))}`),
		);
		if (lines.length > 0) lines.push("");
		lines.push(...this.answerLines(innerWidth));
		if (this.trimmed) lines.push(this.theme.fg("warning", MSG_TRIMMED));
		return lines;
	}

	private answerLines(innerWidth: number): string[] {
		if (this.mode === "error") {
			return this.error
				.split("\n")
				.flatMap((line) => wrapTextWithAnsi(this.theme.fg("error", line || " "), innerWidth));
		}
		return this.markdown.render(innerWidth);
	}

	private titleLine(innerWidth: number): string {
		const available = Math.max(0, innerWidth - visibleWidth(BTW_LITERAL) - 1);
		const question = truncateToWidth(collapseWhitespace(this.question), available, "…", false);
		return `${this.theme.fg("accent", BTW_LITERAL)} ${this.theme.bold(question)}`;
	}

	private footerLine(scrollable: boolean): string {
		const parts: string[] = [];
		if (scrollable) parts.push(FOOTER_SCROLL);
		if (this.history.length > 0) parts.push(FOOTER_CLEAR);
		parts.push(FOOTER_DISMISS);
		return this.theme.fg("dim", parts.join(FOOTER_SEP));
	}
}

export function showBtwOverlay(params: ShowBtwOverlayParams): ShowBtwOverlayResult {
	let resolveReady!: (controller: BtwOverlayController) => void;
	const controllerReady = new Promise<BtwOverlayController>((resolve) => {
		resolveReady = resolve;
	});
	const overlayPromise = params.ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const controller = new BtwOverlayController(
				params.question,
				params.answer,
				params.history,
				theme,
				tui,
				done,
				params.controller,
				params.onClearHistory,
			);
			resolveReady(controller);
			return controller;
		},
		{ overlay: true, overlayOptions: BTW_OVERLAY_OPTIONS },
	);
	return { overlayPromise, controllerReady };
}
