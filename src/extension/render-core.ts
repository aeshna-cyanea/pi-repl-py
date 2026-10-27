/** Pure layout, free of pi imports so unit tests drive it directly. */

/**
 * One file's worth of unified diff, produced by a kernel function that wanted the human to see it as a
 * diff (Key 138). `diff` is the unified text; the counts are what the collapsed header shows, so they
 * are computed by the writer and not re-derived from a truncated render.
 */
export interface DiffCardItem {
	path: string;
	added: number;
	removed: number;
	dryRun?: boolean;
	diff: string;
}

export interface DiffCard {
	kind: "diffs";
	items: DiffCardItem[];
	/**
	 * How many items the writer's own bound (`CARD_MAX_ITEMS`) hid from the card. Carried because a
	 * bound that hides silently reads as a complete card — the exact bug the writer had first, where
	 * fifteen patches reported "1" dropped when three were. Rendering it is the other half of that fix.
	 */
	droppedItems?: number;
}

/**
 * Validate a card that arrived as JSON from the bridge. The writer is Python and the reader is here, so
 * the type is a contract, not a guarantee — anything malformed falls back to `undefined`, which renders
 * exactly what this looked like before the card existed. A display nicety must be able to fail silently
 * without taking the cell's output down with it.
 */
export function readDiffCard(value: unknown): DiffCard | undefined {
	if (!value || typeof value !== "object") return undefined;
	const card = value as { kind?: unknown; items?: unknown; droppedItems?: unknown };
	if (card.kind !== "diffs" || !Array.isArray(card.items)) return undefined;
	const items = card.items.flatMap((item): DiffCardItem[] => {
		if (!item || typeof item !== "object") return [];
		const it = item as { path?: unknown; added?: unknown; removed?: unknown; dryRun?: unknown; diff?: unknown };
		if (typeof it.path !== "string" || typeof it.diff !== "string") return [];
		return [{
			path: it.path,
			added: Number.isFinite(it.added) ? Number(it.added) : 0,
			removed: Number.isFinite(it.removed) ? Number(it.removed) : 0,
			...(it.dryRun === true ? { dryRun: true } : {}),
			diff: it.diff,
		}];
	});
	if (items.length === 0) return undefined;
	const dropped = Number.isFinite(card.droppedItems) ? Number(card.droppedItems) : 0;
	return dropped > 0 ? { kind: "diffs", items, droppedItems: dropped } : { kind: "diffs", items };
}

export interface ExecuteDetails {
	status?: "ok" | "error" | "aborted" | string;
	/** Untrusted until `readDiffCard` says otherwise. */
	card?: unknown;
	durationMs?: number;
	errorName?: string;
	stdout?: string;
	stderr?: string;
	result?: string;
	errorStack?: string[];
}

export interface ExecuteRenderState {
	code: string;
	details?: ExecuteDetails;
	contentText?: string;
	isPartial: boolean;
	isError: boolean;
	expanded: boolean;
	executionStarted: boolean;
	hasResult: boolean;
	/** Monotonic dirty counter, bumped by the host on every content/status change. */
	version?: number;
}

import { previewCell } from "./preview/index.js";
import { boundView } from "../engine/index.js";

export type StatusKind = "error" | "aborted" | "running" | "queued" | "done";
export type BgKind = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

export interface RenderDeps {
	fg(color: string, text: string): string;
	getBgAnsi(bg: BgKind): string;
	highlight(code: string): string[];
	keyHint(expanded: boolean): string;
	visibleWidth(text: string): number;
	truncateToWidth(text: string, width: number, ellipsis: string): string;
	wrapTextWithAnsi(text: string, width: number): string[];
	/** Injected for deterministic spinner frames in tests. */
	now?(): number;
}

const OUTPUT_INDENT = "  ";
const SPINNER_FRAMES = [">..", ".>.", "..>", ".>."];

export function formatDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) return undefined;
	if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
	return `${(durationMs / 1000).toFixed(1)}s`;
}

const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;

/** Close an open color so a line wrapped across words can't bleed into padding or the next row. */
export function closeOpenSgr(line: string): string {
	let fgOpen = false;
	let bgOpen = false;
	for (const match of line.matchAll(SGR_PATTERN)) {
		const params = match[1] === "" ? ["0"] : (match[1] ?? "").split(";");
		for (let i = 0; i < params.length; i++) {
			const code = Number(params[i]);
			if (code === 0) {
				fgOpen = false;
				bgOpen = false;
			} else if (code === 38 || code === 48) {
				// --- skip the 38;5;n / 38;2;r;g;b payload so a component isn't read as another SGR code ---
				if (code === 38) fgOpen = true;
				else bgOpen = true;
				const mode = Number(params[i + 1]);
				i += mode === 2 ? 4 : mode === 5 ? 2 : 1;
			} else if (code === 39) {
				fgOpen = false;
			} else if (code === 49) {
				bgOpen = false;
			} else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
				fgOpen = true;
			} else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
				bgOpen = true;
			}
		}
	}
	return fgOpen || bgOpen ? `${line}\x1b[0m` : line;
}

export function statusKind(state: ExecuteRenderState): StatusKind {
	const status = state.details?.status;
	if (state.isError || status === "error") return "error";
	if (status === "aborted") return "aborted";
	if (!state.isPartial && (status !== undefined || state.hasResult)) return "done";
	if (state.isPartial || state.executionStarted) return "running";
	return "queued";
}

export function backgroundFor(kind: StatusKind): BgKind {
	if (kind === "error" || kind === "aborted") return "toolErrorBg";
	if (kind === "done") return "toolSuccessBg";
	return "toolPendingBg";
}

function marker(state: ExecuteRenderState, deps: RenderDeps): string {
	switch (statusKind(state)) {
		case "error":
			return deps.fg("error", "✗");
		case "aborted":
			return deps.fg("warning", "✗");
		case "done":
			return deps.fg("success", "✓");
		case "running": {
			const now = deps.now?.() ?? Date.now();
			return deps.fg("accent", SPINNER_FRAMES[Math.floor(now / 120) % SPINNER_FRAMES.length]);
		}
		default:
			return deps.fg("muted", "◇");
	}
}

/** highlight.js emits no scope for bare Python identifiers — re-color only raw runs outside colored spans. */
function colorBareIdentifiers(line: string, paint: (id: string) => string): string {
	if (!line.includes("\x1b") && !/[a-zA-Z_]/.test(line)) return line;
	const out: string[] = [];
	let pending = "";
	let colored = false;
	const pushRaw = (s: string) => {
		let last = 0;
		for (const m of s.matchAll(/[a-zA-Z_][a-zA-Z0-9_]*/g)) {
			const index = m.index ?? 0;
			out.push(s.slice(last, index), paint(m[0]));
			last = index + m[0].length;
		}
		out.push(s.slice(last));
	};
	let i = 0;
	const isFgColor = (seq: string) => /\x1b\[(?:38|9?[0-7])/.test(seq);
	while (i < line.length) {
		if (line[i] === "\x1b") {
			const end = line.indexOf("m", i) + 1;
			const seq = line.slice(i, end);
			if (isFgColor(seq)) {
				if (pending) {
					pushRaw(pending);
					pending = "";
				}
				out.push(seq);
				colored = true;
			} else if (seq.includes("39") || seq.includes("0m")) {
				if (colored) {
					out.push(seq);
					colored = false;
				} else {
					pending += seq;
				}
			} else {
				pending += seq;
			}
			i = end;
			continue;
		}
		if (colored) out.push(line[i]);
		else pending += line[i];
		i++;
	}
	if (pending) pushRaw(pending);
	return out.join("");
}

function highlightLines(code: string, deps: RenderDeps): string[] {
	if (!code) return [];
	return deps.highlight(code);
}

function outputText(state: ExecuteRenderState): string {
	const details = state.details;
	if (details && (details.stdout || details.stderr || details.result)) {
		return [details.stdout, details.stderr, details.result]
			.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
			.join("\n");
	}
	return state.contentText?.trim() ?? "";
}

function topLine(state: ExecuteRenderState, width: number, deps: RenderDeps): string {
	const code = state.code.trimEnd();
	const preview = previewCell(code);
	const prefix = `${marker(state, deps)} ${deps.fg("muted", "repl")}`;

	// --- suffix priority: expand hint > error > duration > counts, so truncation never hides the expand key ---
	const suffixParts: string[] = [];
	suffixParts.push(deps.keyHint(state.expanded));

	const errorName = !state.isPartial ? state.details?.errorName : undefined;
	if (errorName) {
		// --- the error message usually beats a bare name when it fits ---
		const summary = sanitizeTuiOutput(state.details?.errorStack?.[0] ?? "");
		suffixParts.push(deps.fg("error", summary && deps.visibleWidth(summary) <= 48 ? summary : errorName));
	}

	const duration = formatDuration(state.details?.durationMs);
	if (duration) suffixParts.push(deps.fg("muted", duration));

	// --- a collapsed cell shows the change without expanding it. Counts come from the writer, so they
	// stay exact even when the diff text itself was bounded; the path stays in the expanded card because
	// a suffix that grows eats the code preview, and the preview is what identifies the cell. ---
	if (!state.isPartial && statusKind(state) !== "running") {
		const card = readDiffCard(state.details?.card);
		if (card) {
			const added = card.items.reduce((sum, item) => sum + item.added, 0);
			const removed = card.items.reduce((sum, item) => sum + item.removed, 0);
			suffixParts.push(
				`${deps.fg("dim", "diff")} ${deps.fg("success", `+${added}`)} ${deps.fg("error", `−${removed}`)}`,
			);
		}
	}

	// --- counts settle-only: live-updating them mid-stream jitters the header ---
	if (!state.isPartial && statusKind(state) !== "running") {
		const inputLines = code.split("\n").filter((line) => line.trim().length > 0).length;
		const output = outputText(state);
		const outputLines = output ? output.split("\n").length : 0;
		const counts: string[] = [];
		if (inputLines > 0) counts.push(`↑ ${inputLines}`);
		if (outputLines > 0) counts.push(`↓ ${outputLines}`);
		if (counts.length > 0) suffixParts.push(deps.fg("muted", `${counts.join(" ")} lines`));
	}

	const separator = deps.fg("dim", " · ");
	const separatorWidth = deps.visibleWidth(separator);
	const suffix = suffixParts.join(separator);
	// --- budget: width minus leading space, prefix, suffix, and separators ---
	const fixed = 1 + deps.visibleWidth(prefix) + separatorWidth + deps.visibleWidth(suffix);
	const previewBudget = Math.max(8, width - fixed - separatorWidth);
	// --- a semantic preview is a one-line summary; highlight Python code, accent shell intent ---
	let middle = "";
	if (preview.text) {
		const previewText = deps.highlight(preview.text)[0] ?? deps.fg("accent", preview.text);
		middle = deps.truncateToWidth(previewText, previewBudget, "…");
	} else if (!state.executionStarted) {
		middle = deps.fg("muted", "waiting for code");
	}

	return [prefix, ...(middle ? [middle] : []), suffix].join(separator);
}

function sanitizeTuiOutput(text: string): string {
	// --- strip ANSI SGR/CSI and escape control chars for a readable TUI; tabs expand, CR becomes ␍ ---
	return text
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b/g, "␛")
		.replace(/\r/g, "␍")
		.replace(/\t/g, "    ")
		.replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f-\x9f]/g, "�");
}

/** Wrap a colored span: first row takes the prefix, continuations the indent; truncate to width and close open SGR colors. */
function pushWrappedLines(
	lines: string[],
	prefix: string,
	coloredText: string,
	width: number,
	deps: RenderDeps,
	indentAfter?: number,
): void {
	const available = Math.max(1, width - 1 - deps.visibleWidth(prefix));
	const wrapped = deps.wrapTextWithAnsi(coloredText, available);
	for (const [index, line] of (wrapped.length > 0 ? wrapped : [""]).entries()) {
		const linePrefix = index === 0 ? prefix : " ".repeat(deps.visibleWidth(prefix));
		const continuationIndent = index > 0 && indentAfter ? " ".repeat(indentAfter) : "";
		lines.push(deps.truncateToWidth(` ${linePrefix}${continuationIndent}${closeOpenSgr(line)}`, width, ""));
	}
}

function addWrapped(
	lines: string[],
	prefix: string,
	text: string,
	width: number,
	deps: RenderDeps,
	options: { sanitize?: boolean; indentAfter?: number } = {},
): void {
	const safe = options.sanitize === false ? text : sanitizeTuiOutput(text);
	pushWrappedLines(lines, prefix, safe, width, deps, options.indentAfter);
}

function renderCode(state: ExecuteRenderState, lines: string[], width: number, deps: RenderDeps): boolean {
	const code = state.code.trimEnd();
	if (!code) return false;
	lines.push("");
	let perWidth = codeWrapCache.get(state);
	if (!perWidth) {
		perWidth = new Map();
		codeWrapCache.set(state, perWidth);
	}
	const cached = perWidth.get(width);
	if (cached?.code === code) {
		lines.push(...cached.lines);
		return true;
	}
	const fresh: string[] = [];
	const highlighted = highlightLines(code, deps);
	for (const [index, rawLine] of code.split("\n").entries()) {
		const prefix = index === 0 ? deps.fg("dim", "› ") : deps.fg("dim", "  ");
		const paint = (id: string) => deps.fg("syntaxVariable", id);
		const hlLine = colorBareIdentifiers(highlighted[index] ?? rawLine, paint);
		const indent = /^[ \t]*/.exec(rawLine)?.[0] ?? "";
		addWrapped(fresh, prefix, hlLine, width, deps, {
			sanitize: false,
			indentAfter: deps.visibleWidth(indent),
		});
	}
	boundWidthCache(perWidth);
	perWidth.set(width, { code, lines: fresh });
	lines.push(...fresh);
	return true;
}

/** Output is append-only: the cached wrap re-wraps just the tail — O(chunk) instead of O(output). */
interface BlobWrapEntry {
	text: string;
	color: string;
	lines: string[];
	/** Last raw line when `text` has no trailing newline; it may still grow. */
	partial?: { raw: string; wrapped: string[] };
}

const blobWrapCache = new WeakMap<ExecuteRenderState, Map<number, BlobWrapEntry>>();
/** Row caches keyed by text/width turn per-frame renders into one build per change; bounded per state against resize churn. */
interface CodeEntry {
	code: string;
	lines: string[];
}
const codeWrapCache = new WeakMap<ExecuteRenderState, Map<number, CodeEntry>>();

/** Bound per-width cache entries; insertion order evicts the oldest width first. */
const MAX_CACHED_WIDTHS_PER_STATE = 3;
function boundWidthCache(perWidth: Map<number, unknown>): void {
	while (perWidth.size >= MAX_CACHED_WIDTHS_PER_STATE) {
		const oldest = perWidth.keys().next().value as number | undefined;
		if (oldest === undefined) return;
		perWidth.delete(oldest);
	}
}

const CJK_WIDE_RE =
	/[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;

function widthOf(ch: string): number {
	const code = ch.charCodeAt(0);
	return code < 0x80 ? 1 : CJK_WIDE_RE.test(ch) ? 2 : 1;
}

/** Fast word wrap for sanitized text: pi-tui's ANSI-aware wrap costs ~45ms on a 45K blob. */
function wrapPlainText(text: string, width: number): string[] {
	if (width <= 0 || text.length <= width) return [text];
	// --- fast path: pure ASCII, break by char index ---
	let ascii = true;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) >= 0x80) {
			ascii = false;
			break;
		}
	}
	const rows: string[] = [];
	if (ascii) {
		let i = 0;
		for (;;) {
			const end = i + width;
			if (end >= text.length) {
				rows.push(text.slice(i));
				break;
			}
			const brk = text.lastIndexOf(" ", end);
			if (brk > i) {
				rows.push(text.slice(i, brk));
				i = brk + 1;
			} else {
				rows.push(text.slice(i, end));
				i = end;
			}
		}
		return rows;
	}
	// --- wide characters: accumulate visible width, track a last-space break ---
	let row = "";
	let rowVis = 0;
	let lastSpace = -1;
	let lastSpaceVis = 0;
	const visRaw: number[] = [];
	const repoint = (start: number) => {
		visRaw.length = 0;
		let v = 0;
		for (let k = start; k < row.length; k++) {
			visRaw[v] = k;
			v += widthOf(row[k]);
		}
	};
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const w = widthOf(ch);
		visRaw[rowVis] = row.length;
		row += ch;
		rowVis += w;
		if (ch === " ") {
			lastSpace = row.length;
			lastSpaceVis = rowVis;
		}
		if (rowVis > width) {
			if (lastSpace !== -1) {
				rows.push(row.slice(0, lastSpace - 1));
				row = row.slice(lastSpace);
				rowVis -= lastSpaceVis;
				lastSpace = -1;
				lastSpaceVis = 0;
				repoint(0);
			} else {
				const cut = visRaw[width] ?? row.length;
				rows.push(row.slice(0, cut));
				row = row.slice(cut);
				rowVis -= width;
				repoint(0);
			}
		}
	}
	if (row) rows.push(row);
	return rows;
}

/** Sanitize → fast wrap → colorize rows, so an SGR span never bleeds across rows. */
function wrapRawOutputLine(lines: string[], raw: string, color: string, width: number, deps: RenderDeps): string[] {
	const before = lines.length;
	const safe = sanitizeTuiOutput(raw || " ");
	const available = Math.max(1, width - 1 - deps.visibleWidth(OUTPUT_INDENT));
	const rows = wrapPlainText(safe, available);
	for (const [index, row] of (rows.length > 0 ? rows : [""]).entries()) {
		const linePrefix = index === 0 ? OUTPUT_INDENT : " ".repeat(deps.visibleWidth(OUTPUT_INDENT));
		lines.push(deps.truncateToWidth(` ${linePrefix}${closeOpenSgr(deps.fg(color, row))}`, width, ""));
	}
	return lines.slice(before);
}

function wrapBlob(state: ExecuteRenderState, width: number, text: string, color: string, deps: RenderDeps): string[] {
	let perWidth = blobWrapCache.get(state);
	if (!perWidth) {
		perWidth = new Map();
		blobWrapCache.set(state, perWidth);
	}
	const fresh = (): BlobWrapEntry => {
		const lines: string[] = [];
		let partial: { raw: string; wrapped: string[] } | undefined;
		const parts = text.split("\n");
		for (let i = 0; i < parts.length; i++) {
			const wrapped = wrapRawOutputLine(lines, parts[i], color, width, deps);
			if (i === parts.length - 1 && !text.endsWith("\n")) {
				partial = { raw: parts[i], wrapped };
			}
		}
		const entry: BlobWrapEntry = { text, color, lines, partial };
		boundWidthCache(perWidth);
		perWidth.set(width, entry);
		return entry;
	};
	const entry = perWidth.get(width);
	if (!entry || entry.color !== color) return fresh().lines;
	if (entry.text === text) return entry.lines;
	if (text.startsWith(entry.text)) {
		// --- append: cached prefix rows stay; re-wrap only the growing tail ---
		const delta = text.slice(entry.text.length);
		const combined = entry.partial ? entry.partial.raw + delta : delta;
		if (entry.partial) entry.lines.length -= entry.partial.wrapped.length;
		const parts = combined.split("\n");
		for (let i = 0; i < parts.length; i++) {
			const wrapped = wrapRawOutputLine(entry.lines, parts[i], color, width, deps);
			if (i === parts.length - 1) {
				entry.partial = combined.endsWith("\n") ? undefined : { raw: parts[i], wrapped };
			}
		}
		entry.text = text;
		return entry.lines;
	}
	return fresh().lines;
}

/**
 * Per-line colour for one line of a unified diff. Checked in diff order, not character order: the file
 * headers (`---`/`+++`) have to be tested before the single-char `+`/`-` they would otherwise fall into.
 * A removed line whose own text starts with `--` is indistinguishable from a file header at this layer —
 * the writer sends plain text, not line kinds — so it gets the dim colour. Cosmetic, and cheaper than
 * widening the card protocol to carry a flag nobody needs yet.
 */
function diffColorFor(line: string): string {
	if (line.startsWith("@@")) return "accent";
	if (line.startsWith("---") || line.startsWith("+++")) return "dim";
	if (line.startsWith("+")) return "success";
	if (line.startsWith("-")) return "error";
	return "toolOutput";
}

/**
 * One header per file, then its diff with per-line colour. Deliberately NOT routed through `wrapBlob`:
 * that cache assumes an append-only blob and re-wraps only the growing tail, while a card is replaced
 * whole every cell. Reusing it would be a cache that answers a question nobody asked.
 */
function renderDiffCard(output: string[], card: DiffCard, width: number, deps: RenderDeps): void {
	for (const item of card.items) {
		const label = deps.fg("dim", "diff:");
		const counts = `${deps.fg("success", `+${item.added}`)} ${deps.fg("error", `−${item.removed}`)}`;
		const dry = item.dryRun ? ` ${deps.fg("warning", "(dry run)")}` : "";
		// --- the path is the part that can be arbitrarily long, so the path is what gets shortened:
		// a header that truncates from the end loses the counts, and the counts are the whole point of
		// showing the line at all. Trailing "" ellipsis like every other row, so a clipped row still
		// respects the width the caller asked for. ---
		const fixed = 1 + OUTPUT_INDENT.length + deps.visibleWidth(label) + deps.visibleWidth(counts) + deps.visibleWidth(dry) + 3;
		const path = deps.truncateToWidth(deps.fg("accent", item.path), Math.max(4, width - fixed), "…");
		output.push(deps.truncateToWidth(` ${OUTPUT_INDENT}${label} ${path} ${counts}${dry}`, width, ""));
		const body = item.diff.replace(/\n+$/, "");
		if (!body) {
			output.push(` ${OUTPUT_INDENT}${deps.fg("muted", "(no diff text)")}`);
			continue;
		}
		for (const line of body.split("\n")) {
			wrapRawOutputLine(output, line === "" ? " " : line, diffColorFor(line), width, deps);
		}
	}
	// --- the writer bounded the card; say so, or a partial card reads as the whole change ---
	if (card.droppedItems) {
		output.push(
			deps.truncateToWidth(
				` ${OUTPUT_INDENT}${deps.fg("warning", `… ${card.droppedItems} more change(s) not shown`)}`,
				width,
				"",
			),
		);
	}
}

function renderOutput(
	state: ExecuteRenderState,
	lines: string[],
	width: number,
	hasCode: boolean,
	deps: RenderDeps,
): void {
	const details = state.details;
	const output: string[] = [];

	// --- the card goes first: it is what the cell *did*, and the only rendering with per-line colour.
	// A card that fails validation renders as if it had never existed, which is the pre-card cell. ---
	const card = readDiffCard(details?.card);
	let renderedText = card !== undefined;
	if (card) renderDiffCard(output, card, width, deps);

	// --- stdout/stderr/result are color-coded; sanitize before section color so our ANSI isn't escaped ---
	const sections: Array<{ text: string | undefined; color: string; label: string }> = [
		{ text: details?.stdout, color: "toolOutput", label: "stdout" },
		{ text: details?.stderr, color: "warning", label: "stderr" },
		{ text: details?.result, color: "accent", label: "result" },
	];
	for (const { text, color, label } of sections) {
		if (!text?.trim()) continue;
		renderedText = true;
		output.push(` ${OUTPUT_INDENT}${deps.fg("dim", `${label}:`)}`);
		output.push(...wrapBlob(state, width, text, color, deps));
	}

	if (!renderedText && !details && state.contentText?.trim()) {
		renderedText = true;
		const color = state.isError ? "error" : "toolOutput";
		output.push(...wrapBlob(state, width, state.contentText.trim(), color, deps));
	}

	if (details?.errorStack && details.errorStack.length > 0) {
		// --- a traceback IS output: without this, a pure-traceback error cell also rendered "no output" below it ---
		renderedText = true;
		output.push(` ${OUTPUT_INDENT}${deps.fg("dim", "traceback:")}`);
		for (const line of details.errorStack) {
			const safe = sanitizeTuiOutput(line || " ");
			addWrapped(output, OUTPUT_INDENT, deps.fg("error", safe), width, deps, { sanitize: false });
		}
	}

	if (!renderedText) {
		const message = state.isPartial || statusKind(state) === "running" ? "waiting for output..." : "no output";
		addWrapped(output, OUTPUT_INDENT, deps.fg("muted", message), width, deps, { sanitize: false });
	}

	// --- the panel always ends with one blank row: streams end with a newline, tracebacks and placeholders don't ---
	const lastRow = output[output.length - 1];
	if (lastRow !== undefined && lastRow.replace(SGR_PATTERN, "").trim() !== "") output.push("");

	// --- expanded cells render the whole output: the data cap bounds it ---
	if (output.length > 0 && hasCode) lines.push("");
	lines.push(...output);
}

export function paintBackground(line: string, width: number, kind: StatusKind, deps: RenderDeps): string {
	const bgAnsi = deps.getBgAnsi(backgroundFor(kind));
	const padded = line + " ".repeat(Math.max(0, width - deps.visibleWidth(line)));
	const rearmed = padded.replaceAll("\x1b[0m", `\x1b[0m${bgAnsi}`);
	return `${bgAnsi}${rearmed}\x1b[0m`;
}

export function renderExecuteHeader(state: ExecuteRenderState, width: number, deps: RenderDeps): string[] {
	const safeWidth = Math.max(1, width);
	const line = deps.truncateToWidth(` ${topLine(state, safeWidth, deps)}`, safeWidth, "");
	const kind = statusKind(state);
	return [paintBackground(line, safeWidth, kind, deps)];
}

export function renderExecuteBody(state: ExecuteRenderState, width: number, deps: RenderDeps): string[] {
	if (!state.expanded) return [];
	const safeWidth = Math.max(1, width);
	const lines: string[] = [];
	const hasCode = renderCode(state, lines, safeWidth, deps);
	renderOutput(state, lines, safeWidth, hasCode, deps);
	const kind = statusKind(state);
	return lines.map((line) => paintBackground(line, safeWidth, kind, deps));
}

export function renderExecuteCell(state: ExecuteRenderState, width: number, deps: RenderDeps): string[] {
	return [...renderExecuteHeader(state, width, deps), ...renderExecuteBody(state, width, deps)];
}

/**
 * The live preview of a still-running cell, bounded to the SAME view budget the settled text gets.
 *
 * Why this exists, measured 2026-10-27: the streaming branch of the execute tool appended every chunk and
 * handed the whole accumulator to `onUpdate`, so a cell that prints tens of KB scrolled that much into the
 * human's pane while the model never saw past the caps -- the one output path with no bound at all, because
 * `boundView` only ran at finalize. Measured on the box: one cell put ~46 KB on her screen; the model got a
 * 46,080 B head of it and the pane got the rest.
 *
 * The numbers it states are the chunks seen so far, never claimed as the cell's totals, and the tail says
 * the settled render follows -- unlike the settled path it must NOT claim `PI_REPL_CAPTURE_DIR is unset`,
 * because at that moment the tee has not written the copy yet. The character ceiling is left unbounded on
 * purpose: the preview line budget is what protects the pane, and the caller already caps what it accumulates.
 */
export function formatPreview(text: string, viewLines: number): string {
	return boundView(text, viewLines, undefined, { preview: true }).text;
}
