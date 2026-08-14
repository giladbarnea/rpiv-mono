/** Centered, streaming card and footer wait status for /btw. */

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

const BTW_OVERLAY_OPTIONS: OverlayOptions = {
	anchor: "center",
	width: "90%",
	maxHeight: "70%",
};

const BTW_MAX_HEIGHT_RATIO = 0.7;
const CHROME_LINES = 6;
const MIN_VIEWPORT = 1;
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

const collapseWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

export function startBtwWaiting(
	ctx: ExtensionCommandContext,
	question: string,
	controller: AbortController,
): () => void {
	const ui = ctx.ui;
	const label = ui.theme.fg("accent", "btw");
	const shortQuestion = truncateToWidth(
		ui.theme.fg("muted", collapseWhitespace(question)),
		STATUS_QUESTION_MAX_WIDTH,
		ui.theme.fg("muted", "…"),
		false,
	);
	let frame = 0;
	const paint = (): void => {
		ui.setStatus(BTW_STATUS_KEY, `${SPINNER_FRAMES[frame]} ${label} ${shortQuestion}`);
	};
	paint();
	const timer = setInterval(() => {
		frame = (frame + 1) % SPINNER_FRAMES.length;
		paint();
	}, SPINNER_INTERVAL_MS);
	const unsubscribe = ui.onTerminalInput((data) => {
		if (!matchesKey(data, Key.escape)) return undefined;
		controller.abort();
		return { consume: true };
	});
	let stopped = false;
	return () => {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
		unsubscribe();
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
	controller: BtwOverlayController;
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

	setTrimmed(): void {
		this.trimmed = true;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.controller.abort();
			this.done();
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
		const viewport = this.viewportHeight(content.length);
		this.maxScroll = Math.max(0, content.length - viewport);
		if (this.autoScroll) this.scrollOffset = this.maxScroll;
		const start = Math.min(this.scrollOffset, this.maxScroll);
		const visible = content.slice(start, start + viewport);
		const divider = row(this.theme.fg("borderMuted", "─".repeat(innerWidth)));
		const lines = [this.theme.fg("border", `╭${"─".repeat(width - 2)}╮`), row(this.titleLine(innerWidth)), divider];
		for (let index = 0; index < viewport; index++) lines.push(row(visible[index] ?? ""));
		lines.push(divider);
		lines.push(row(this.footerLine(this.maxScroll > 0)));
		lines.push(this.theme.fg("border", `╰${"─".repeat(width - 2)}╯`));
		return lines;
	}

	invalidate(): void {
		this.markdown.invalidate();
	}

	private viewportHeight(contentCount: number): number {
		const terminalRows = (this.tui.terminal as { rows?: number }).rows ?? 24;
		const maxRows = Math.floor(terminalRows * BTW_MAX_HEIGHT_RATIO);
		const available = Math.max(MIN_VIEWPORT, maxRows - CHROME_LINES);
		return Math.max(MIN_VIEWPORT, Math.min(contentCount, available));
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
	let controller!: BtwOverlayController;
	const overlayPromise = params.ctx.ui.custom<void>(
		(tui, theme, _kb, done) => {
			controller = new BtwOverlayController(
				params.question,
				params.answer,
				params.history,
				theme,
				tui,
				done,
				params.controller,
				params.onClearHistory,
			);
			return controller;
		},
		{ overlay: true, overlayOptions: BTW_OVERLAY_OPTIONS },
	);
	return { overlayPromise, controller };
}
