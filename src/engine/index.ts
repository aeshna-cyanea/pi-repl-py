// --- EngineManager: venv resolution, spawn, queue, snapshots, abort grace, teardown; the wire lives in kernel.ts ---

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type CaptureBootState, type HelperLoadResult, KernelClient, type StreamCapture, type SurfaceAnswer } from "./kernel.js";

export type { HelperLoadResult } from "./kernel.js";

function installVenvPython(): string {
	return join(homedir(), ".pi", "agent", "pi-repl", "venv", "bin", "python3");
}

/** Exported because the helper-description query needs the SAME interpreter the kernel gets: two rules for
 *  "which python" is one rule that drifts. */
export function resolvePythonPath(_cwd: string | undefined): string {
	// --- only the install venv: a repo `.venv` may lack ipykernel and would shadow the good one ---
	const installVenv = installVenvPython();
	if (existsSync(installVenv)) return installVenv;
	return process.env.PYTHON ?? "python3";
}

export const DEFAULT_MAX_OUTPUT_CHARS = 46080;
/** Per-line cap: one giant line must not own the channel budget while long JSON/reprs/errors still pass whole. */
export const MAX_OUTPUT_LINE_CHARS = 4096;
/** A cell's `result` is the echo of a value nobody asked to see: if I wanted it, I would have bound it.
 *  stdout keeps the channel budget because a command's output usually IS the point; a result does not.
 *  And unlike cap(), a result needs no full-copy-to-disk: the persistent kernel is the archive, so
 *  assigning the value keeps it. Measured 2026-10-15: an unbounded result echo spent 11,399 chars on a
 *  cell whose last expression was a 300-line string, and IPython's trailing semicolon does NOT suppress
 *  it on this bridge — `'x';` and `'x'` echo identically, so `;` is not a mitigation here. */
export const DEFAULT_MAX_RESULT_LINES = 40;
export const DEFAULT_MAX_RESULT_CHARS = 4000;
/** The view bound: how many lines of a cell's stream I am shown before the marker points at the
 *  complete copy. Measured 2026-10-27 across 25,413 tool results in 83 session trees: p90 = 62 lines,
 *  p95 = 92, p99 = 245, max 1,789 -- so 120 clips 3.4% of results and leaves 96.6% whole. It is ONE
 *  knob for the whole stack: `viewLines` in pi-repl.json arrives here as PAN_VIEW_LINES, and the
 *  same value is handed to the kernel so panlib's own view verbs (peek/show/cap/run) default to it.
 *  "How much a cell shows me" is then configured in exactly one place. */
export const DEFAULT_OUTPUT_VIEW_LINES = 120;
/** The ONE name for that knob, on both sides of the process boundary. The extension hands this env var
 *  to the kernel and the engine reads it back; panlib reads the same string as `panout.VIEW_ENV`. It was
 *  two strings for a day (`PI_REPL_VIEW_LINES` here, `PAN_VIEW_LINES` there) and neither side noticed --
 *  each read its own name and saw a plausible default, which is what a wrong page size looks like. A name
 *  that crosses a boundary belongs in a constant, and my repo has a test that reads this file to keep the
 *  two equal.
 */
export const VIEW_LINES_ENV = "PAN_VIEW_LINES";
/** Where a resolved view bound came from, so a disagreement can name its own source. */
export type ViewLinesSource = "opts" | "agent-env" | "kernel-env" | "default";
export interface ViewLinesReading {
	lines: number;
	source: ViewLinesSource;
	/** What the kernel's own view verbs will default to — the extension sets this env from pi-repl.json. */
	kernelLines: number;
}
/**
	The ONE resolution of the view bound, shared by the engine and by the tool description, because the two
	used to resolve it separately and a description that states a number the engine never used is exactly the
	kind of lie this repo keeps testing for.

	Precedence is deliberate, and it is the shape that can split: an env var in the **agent** process beats the
	value the extension handed the kernel from pi-repl.json. So if an operator exports PAN_VIEW_LINES while
	pi-repl.json also sets `viewLines`, the harness trims at one number and panlib's peek/show/cap/run default
	to the other. That is legal — an operator may want a tighter transcript than the helpers' default — but it
	must never be silent, which is why `kernelLines` travels with the reading and `executeToolDescription`
	says so when the two differ. Junk (0, "lots", NaN) is ignored rather than obeyed, as in the config parser.
*/
export function resolveViewLines(
	perCall: number | undefined,
	agentEnv: Record<string, string | undefined>,
	kernelEnv?: Record<string, string | undefined>,
): ViewLinesReading {
	const kernelRaw = Number(kernelEnv?.[VIEW_LINES_ENV]);
	const kernelOk = Number.isFinite(kernelRaw) && kernelRaw > 0;
	const kernelLines = kernelOk ? kernelRaw : DEFAULT_OUTPUT_VIEW_LINES;
	if (perCall !== undefined && Number.isFinite(perCall) && perCall > 0) return { lines: perCall, source: "opts", kernelLines };
	const agentRaw = Number(agentEnv?.[VIEW_LINES_ENV]);
	if (Number.isFinite(agentRaw) && agentRaw > 0) return { lines: agentRaw, source: "agent-env", kernelLines };
	return { lines: kernelLines, source: kernelOk ? "kernel-env" : "default", kernelLines };
}
/**
 *  The char half of the view bound. The line bound is not enough: measured over the 400 newest capture and
 *  tee files, the longest line inside each is p50 190 chars, p90 590, p99 16,070, max 150,904 — 7 files over
 *  4,000 and 4 over 20,000. A single 150,904-char line is ONE line, so a 120-line bound passes it whole and
 *  one stroke costs about 38k tokens. One bound, then: keep whole lines until the budget is spent and cut
 *  exactly ONE line, the boundary line that crosses it. 24,000 chars is about 6k tokens.
 */
export const DEFAULT_VIEW_CHARS = 24_000;
/** The ONE name for that knob on both sides of the process boundary; panlib reads the same string as
 *  `panout.VIEW_CHARS_ENV`. Two names is how a wrong bound becomes invisible. */
export const VIEW_CHARS_ENV = "PAN_VIEW_CHARS";
export type ViewCharsSource = "opts" | "agent-env" | "kernel-env" | "default";
export interface ViewCharsReading {
	chars: number;
	source: ViewCharsSource;
	/** What the kernel's own view verbs will default to — the extension sets this env from pi-repl.json. */
	kernelChars: number;
}
/** The one resolution of the char bound, mirroring `resolveViewLines` exactly: a per-call value wins, then
 *  the agent env, then the env the extension handed the kernel, then the default. Junk (0, "lots", -5) is
 *  ignored rather than obeyed. `kernelChars` travels with the reading so a harness/kernel disagreement can
 *  name its own source instead of being inferred. */
export function resolveViewChars(
	perCall: number | undefined,
	agentEnv: Record<string, string | undefined>,
	kernelEnv?: Record<string, string | undefined>,
): ViewCharsReading {
	const kernelRaw = Number(kernelEnv?.[VIEW_CHARS_ENV]);
	const kernelOk = Number.isFinite(kernelRaw) && kernelRaw > 0;
	const kernelChars = kernelOk ? kernelRaw : DEFAULT_VIEW_CHARS;
	if (perCall !== undefined && Number.isFinite(perCall) && perCall > 0) return { chars: perCall, source: "opts", kernelChars };
	const agentRaw = Number(agentEnv?.[VIEW_CHARS_ENV]);
	if (Number.isFinite(agentRaw) && agentRaw > 0) return { chars: agentRaw, source: "agent-env", kernelChars };
	return { chars: kernelChars, source: kernelOk ? "kernel-env" : "default", kernelChars };
}

/** True when `lines` cannot fit `budget` chars counting one newline per line. Mirrors panout.over_budget. */
export function overBudget(lines: string[], budget: number): boolean {
	let used = 0;
	for (const l of lines) {
		used += l.length + 1;
		if (used > budget) return true;
	}
	return false;
}

/**
 *  Keep whole lines while the budget holds, then cut exactly ONE line — the boundary line that crosses it —
 *  and stop. A per-line cap would chop every long line in the window at once, and autumn rejected that
 *  shape: "it wouldn't make sense to return multiple truncated lines." `cut` is the number of characters of
 *  the boundary line that survived, or null when nothing was cut. `fromFront=false` walks from the back and
 *  keeps the boundary line's SUFFIX, for a tail-style view: the loss always sits furthest from what was asked.
 *  Mirrors panlib's `_budget` (pan/lib/panlib/output/panout.py); the two must agree or the halves disagree by
 *  construction, so the expectations are pinned on both sides:
 *  budgetLines(["aaaa","bbbb","cccc"], 11) -> ["aaaa","bbbb","c"] cut 1 · (_, 15) all three whole cut null ·
 *  (_, 4) ["aaaa"] cut 4 · (_, 11, false) ["a","bbbb","cccc"] cut 1.
 */
/** What the char clause added to the marker costs, reserved before the cut so the ceiling the marker claims
 *  is the ceiling that actually holds. See the re-fit in `boundView`. */
export const BOUND_CLAUSE_RESERVE = 160;

export function budgetLines(lines: string[], budget: number, fromFront = true): { lines: string[]; cut: number | null } {
	if (!(budget >= 1)) throw new Error(`budgetLines: budget must be at least 1, got ${budget}`);
	const out: string[] = [];
	let used = 0;
	if (!fromFront) {
		for (let i = lines.length - 1; i >= 0; i--) {
			const l = lines[i];
			if (used + l.length + 1 <= budget) {
				out.unshift(l);
				used += l.length + 1;
				continue;
			}
			const room = Math.max(0, budget - used);
			out.unshift(l.slice(l.length - room));
			return { lines: out, cut: room };
		}
		return { lines: out, cut: null };
	}
	for (const l of lines) {
		if (used + l.length + 1 <= budget) {
			out.push(l);
			used += l.length + 1;
			continue;
		}
		const room = Math.max(0, budget - used);
		out.push(l.slice(0, room));
		return { lines: out, cut: room };
	}
	return { lines: out, cut: null };
}

const ABORT_GRACE_MS = 20_000;
/** Shared deadline: bounds a wedged boot (lifecycle) and a wedged background restore alike. */
export const DEFAULT_BOOT_TIMEOUT_MS = 90_000;
/** Snapshot size cap, also per-entry; oversized bindings are reported as skipped names. */
const DEFAULT_SNAPSHOT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_SNAPSHOT_PERIOD_MS = 120_000;

interface EngineExecuteError {
	name: string;
	message: string;
	stack: string[];
}

export interface ExecuteResult {
	stdout: string;
	stderr: string;
	result?: string;
	status: "ok" | "error" | "aborted";
	error?: EngineExecuteError;
	durationMs: number;
	/** Carried through from the bridge untouched — see `CellResult.card`. */
	card?: unknown;
	/** Pointer at the cell's complete stream, when the bridge tee wrote one. */
	capture?: StreamCapture;
}

export interface ExecuteOptions {
	/** Aborting cancels the cell via kernel interrupt; the namespace is preserved. */
	signal?: AbortSignal;
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	/** Lines of stream I am shown before the pointer to the complete copy. Default DEFAULT_OUTPUT_VIEW_LINES. */
	viewLines?: number;
	/** Chars of that view the budget may spend, one boundary line cut at most. Default DEFAULT_VIEW_CHARS. */
	viewChars?: number;
	maxOutputChars?: number;
}

export interface SnapshotResult {
	path: string;
	saved: string[];
	/** Names that could not be serialized, with reasons. */
	failed: { name: string; reason: string }[];
}

export interface RestoreResult {
	path: string;
	restored: string[];
	failed: { name: string; reason: string }[];
}

export interface EngineOptions {
	cwd?: string;
	env?: Record<string, string>;
	snapshot?: {
		path: string;
		/** Total base64 payload cap; also the per-entry cap. Oversized entries are skipped with a reason. Default 128 MiB. */
		maxBytes?: number;
		/** Force a refresh when the last persisted snapshot is older than this, even if no name changed. 0 disables. Default 2 min. */
		periodMs?: number;
	};
	/** Do not revive the snapshot on this engine (used after a wedged restore was detected once). */
	skipRestore?: boolean;
	/** True when this engine's snapshot was inherited from a /fork'd parent session. */
	forkInherited?: boolean;
}

// --- process-wide cleanup: a child does not die with its parent, so SIGKILL live kernels on exit ---

const liveEngines = new Set<EngineManager>();
let cleanupHandlersInstalled = false;

function installProcessCleanupOnce(): void {
	if (cleanupHandlersInstalled) return;
	cleanupHandlersInstalled = true;
	process.on("exit", () => {
		for (const engine of liveEngines) engine.killSync();
	});
}

function truncateWithMarker(text: string, maxChars: number, wasTruncated: boolean): string {
	if (!wasTruncated && text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[... output truncated at ${maxChars} chars ...]`;
}

export function capLinesForContext(text: string): { text: string; trimmed: boolean } {
	const lines = text.split("\n");
	let trimmed = false;
	const mapped = lines.map((line) => {
		if (line.length <= MAX_OUTPUT_LINE_CHARS) return line;
		trimmed = true;
		return line.slice(0, MAX_OUTPUT_LINE_CHARS);
	});
	return { text: mapped.join("\n"), trimmed };
}

export interface BoundResult { text: string; trimmed: boolean; lines: number; shownLines: number; chars: number }

/** Bound a cell result to its own budget. The totals in the marker are the TRUE totals of the input,
 *  so a bounded echo can never understate what it withheld. */
export function boundResult(text: string, maxLines: number = DEFAULT_MAX_RESULT_LINES, maxChars: number = DEFAULT_MAX_RESULT_CHARS): BoundResult {
	const lines = text.split("\n");
	const chars = text.length;
	if (lines.length <= maxLines && chars <= maxChars) {
		return { text, trimmed: false, lines: lines.length, shownLines: lines.length, chars };
	}
	let kept = lines.slice(0, maxLines).join("\n");
	const shownLines = Math.min(lines.length, maxLines);
	const byChars = kept.length > maxChars;
	if (byChars) kept = kept.slice(0, maxChars);
	const marker = `[... result bounded: showed ${shownLines} of ${lines.length} lines, ${chars} chars total` +
		(byChars ? `, cut at ${maxChars} chars` : "") +
		". the kernel keeps no unbound value: assign it (x = ...) to get it whole ...]";
	return { text: `${kept}\n${marker}`, trimmed: true, lines: lines.length, shownLines, chars };
}

export interface BoundView extends BoundResult { path?: string; cutByChars: boolean }

/** Bound a stream channel to the view budget, and name the complete copy when the tee has one.
 *  The totals in the marker are the TRUE totals of the cell's stream -- the bridge reports them from
 *  the bytes it held before any cap ran -- so a bounded view never understates what it withheld, the
 *  same rule boundResult follows for a result echo. `path` is a pointer at the whole thing, not a
 *  summary of the head: peek(path, start=N+1) continues where this view stopped (peek's own default
 *  page size comes from PAN_VIEW_LINES, the same knob my view verbs read).
 *
 *  THREE ceilings live here and they are not the same number: the VIEW budget (`maxChars`, default
 *  DEFAULT_VIEW_CHARS 24,000) is what I am shown; the kernel's CHANNEL ceiling (DEFAULT_MAX_OUTPUT_CHARS
 *  46,080, `accumulate()` in kernel.ts) is what reaches this function at all; and on the no-tee route
 *  `truncateWithMarker` plus `capLinesForContext` (MAX_OUTPUT_LINE_CHARS 4,096, per line) is all that exists
 *  because no complete copy was written. The asymmetry with the per-line cap is stated, not discovered: the
 *  no-tee route chops every over-long line because there is nothing else to keep, and it says so.
 *
 *  `totals.droppedBytes` is the kernel's own channel cap biting BEFORE this function is reached:
 *  `accumulate()` in kernel.ts holds at most `maxOutputChars` per channel and drops the rest, and that
 *  ceiling is numerically equal to this function's own `maxChars` (46,080). A head that arrives pre-cut
 *  to exactly the budget therefore reads as "nothing to trim" unless the TRUE totals decide the test,
 *  and what lands in the transcript ends mid-word with no notice anywhere in it. Measured on this box
 *  2026-10-27: one cell, 79,667 B teed, 46,080 B handed to the model, cut mid-word, zero disclosure --
 *  and full of my own `show()` markers, which made the blob look bounded. So both the decision to bound
 *  and the numbers in the marker come from `totals`, never from the surviving head. */
export function boundView(
	text: string,
	maxLines: number = DEFAULT_OUTPUT_VIEW_LINES,
	path?: string,
	/** Everything is optional on purpose: each field answers a different question, and a caller that only
	 *  knows one of them (the preview knows `preview`, finalize knows the tee's counts) must be able to say
	 *  just that. `lines`/`bytes` fall back to the text in hand when absent. */
	totals?: { lines?: number; bytes?: number; cut?: boolean; droppedBytes?: number; preview?: boolean },
	/** The VIEW budget in chars — not the channel ceiling, not the per-line cap. See the three ceilings above. */
	maxChars: number = DEFAULT_VIEW_CHARS,
): BoundView {
	const lines = text.split("\n");
	const shown = totals?.lines ?? lines.length;
	const chars = totals?.bytes ?? text.length;
	const dropped = totals?.droppedBytes ?? 0;
	// The bound is decided on the TRUE line count, and a head the channel already cut always gets a
	// marker however short it looks: a mid-word end with no notice is the failure this channel exists
	// to kill, and it is invisible to a test that only ever sees whole streams arrive.
	if (shown <= maxLines && text.length <= maxChars && dropped === 0) {
		return { text, trimmed: false, lines: shown, shownLines: lines.length, chars, path, cutByChars: false };
	}
	const shownLines0 = Math.min(shown, Math.max(0, maxLines));
	let shownLines = shownLines0;
	let kept = shownLines < lines.length ? lines.slice(0, shownLines).join("\n") : text;
	// One wording for the marker, because a cut changes the numbers and a second copy of the sentence is how
	// the two drift apart. `bound` is the char clause; it is absent when the line bound alone decided.
	const mkTail = (shownShown: number, bound?: string): string => {
		const extra = bound ? `; view bound ${bound}` : "";
		return path
			? `[... ${shown} lines, ${chars} chars — showed ${shownShown}${extra}. full text: ${path}]\n    next: peek('${path}', start=${shownShown + 1})`
			: totals?.preview
				? `[... ${shown} lines, ${chars} chars — showed ${shownShown}${extra}. a bounded preview; the settled cell lands in full ...]`
				: `[... ${shown} lines, ${chars} chars — showed ${shownShown}${extra}. PI_REPL_CAPTURE_DIR is unset: this cell has no complete copy ...]`;
	};
	let tail = mkTail(shownLines);
	// named as its own sentence rather than folded into the totals: whose ceiling bit changes where the
	// complete copy lives, and "the numbers above are not the cell's" is a different claim from "bytes
	// were dropped on the way here".
	if (dropped > 0) {
		tail += path
			? `\n    note: the kernel's output channel dropped ${dropped.toLocaleString("en-US")} bytes before this view; the complete copy is in the file above`
			: `\n    note: the kernel's output channel dropped ${dropped.toLocaleString("en-US")} bytes before this view, and no complete copy was written`;
	}
	// the tee's own byte bound: those totals are what the tee HELD, not what the cell printed, and a
	// marker that reports the smaller number without saying so is the lie this whole channel exists to avoid.
	if (totals?.cut) tail += "\n    note: the copy hit its own byte bound — this cell is longer than the numbers above";
	// The char budget keeps whole lines and cuts at most ONE boundary line, and the peek hint resumes AT the
	// line that was cut, never past it. The raw slice this replaces used to trim one 150,904-char line down to
	// the ceiling while the marker still claimed "showed 1" — a mid-line cut is the one form of withholding
	// no lexical gate can see.
	let cutByChars = false;
	const budget = maxChars - tail.length - 1;
	if (kept.length > budget) {
		// Reserve room for the clause the marker gains, then RE-FIT the one boundary line so the ceiling the
		// marker claims is the ceiling that holds: adding text to the marker after cutting is how the bound
		// overshoots by 50-odd chars, and only a test that asserts the total ever notices.
		const b = budgetLines(kept.split("\n"), Math.max(1, budget - BOUND_CLAUSE_RESERVE));
		shownLines = Math.min(shownLines, Math.max(0, b.lines.length - 1));
		tail = mkTail(shownLines, `${maxChars.toLocaleString("en-US")} of ${chars.toLocaleString("en-US")} chars, 1 line cut at ${(b.cut ?? 0).toLocaleString("en-US")}`);
		const over = kept.length + 1 + tail.length - maxChars;
		if (over > 0 && b.lines.length) {
			const last = b.lines[b.lines.length - 1];
			b.lines[b.lines.length - 1] = last.slice(0, Math.max(0, last.length - over));
			b.cut = Math.max(0, (b.cut ?? 0) - over);
		}
		kept = b.lines.join("\n");
		cutByChars = b.cut !== null;
	}
	return { text: `${kept}\n${tail}`, trimmed: true, lines: shown, shownLines, chars, path, cutByChars };
}

const DEFAULT_KEEP_SNAPSHOTS = 25;

/** Keep the newest `keep` snapshot dirs; the live dir is exempt and manifest-less dirs are ignored. */
export function pruneSnapshotDirs(stateRoot: string, keep: number = DEFAULT_KEEP_SNAPSHOTS, currentDir?: string): void {
	const entries: { dir: string; mtimeMs: number }[] = [];
	try {
		for (const name of readdirSync(stateRoot, { withFileTypes: true })) {
			if (!name.isDirectory() || name.name === currentDir) continue;
			try {
				const manifest = join(stateRoot, name.name, "namespace.snapshot");
				if (!existsSync(manifest)) continue;
				entries.push({ dir: join(stateRoot, name.name), mtimeMs: statSync(manifest).mtimeMs });
			} catch {}
		}
	} catch {
		return;
	}
	entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
	for (const { dir } of entries.slice(keep)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
}

// --- orphan sweep: a state dir whose conversation file exists in no project root dies with it; only manifest dirs are touched, live + ephemeral exempt ---
export function pruneOrphanedSnapshotDirs(
	stateRoot: string,
	sessionsRoot: string | undefined,
	currentDir?: string,
): number {
	if (!sessionsRoot || !existsSync(sessionsRoot)) return 0;
	const liveNames = new Set<string>();
	try {
		for (const proj of readdirSync(sessionsRoot, { withFileTypes: true })) {
			if (!proj.isDirectory()) continue;
			for (const f of readdirSync(join(sessionsRoot, proj.name))) {
				if (!f.endsWith(".jsonl")) continue;
				const name = f.slice(0, -".jsonl".length);
				// --- both dir formats (legacy bare-name and slug-keyed) are live while their conversation lives ---
				liveNames.add(name);
				liveNames.add(`${proj.name}__${name}`);
			}
		}
	} catch {
		return 0;
	}
	let removed = 0;
	try {
		for (const entry of readdirSync(stateRoot, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name === currentDir || entry.name === "ephemeral") continue;
			if (liveNames.has(entry.name)) continue;
			if (!existsSync(join(stateRoot, entry.name, "namespace.snapshot"))) continue;
			rmSync(join(stateRoot, entry.name), { recursive: true, force: true });
			removed++;
		}
	} catch {
		// readdir can race a concurrent sweep; give up quietly rather than partial-delete
	}
	return removed;
}

export class EngineManager {
	private readonly options: EngineOptions;
	private kernel?: KernelClient;
	private state: "idle" | "starting" | "running" | "shutdown" = "idle";
	private startPromise?: Promise<void>;
	private executionQueue: Promise<unknown> = Promise.resolve();
	private pythonPath?: string;
	private restoredKernel?: KernelClient;
	/** A wedged revive marks the engine: later kernels boot without restoring. */
	private restoreSkipped: boolean;
	private restoreResolve?: (result: RestoreResult | null) => void;
	private restorePromise?: Promise<RestoreResult | null>;
	private restoreSettledResult?: RestoreResult | null;
	private helperReport: readonly HelperLoadResult[] | null = null;
	/** Whether the current boot's report has been handed out (once per boot). */
	private helperReportTaken = true;
	private readonly forkInherited: boolean;

	constructor(options: EngineOptions = {}) {
		this.options = options;
		this.forkInherited = options.forkInherited ?? false;
		this.restoreSkipped = options.skipRestore ?? false;
		// no snapshot capability: recovery is trivially "nothing to revive"
		if (!options.snapshot) this.settleRestore(null);
	}

	get isRunning(): boolean {
		return this.state === "running" && (this.kernel?.isRunning ?? false);
	}

	/** True when this engine is a fork that inherited its parent's namespace (drives the fork toast). */
	get inheritedFromFork(): boolean {
		return this.forkInherited;
	}

	/** Current boot's helper verdicts, handed out once per boot (first cell of a session/rebuild); null when nothing to announce. */
	takeHelperReport(): readonly HelperLoadResult[] | null {
		if (this.helperReportTaken) return null;
		this.helperReportTaken = true;
		return this.helperReport;
	}

	// --- state can flip to shutdown at any time; read it via a method so TS can't narrow the union away ---
	private isShutdown(): boolean {
		return this.state === "shutdown";
	}

	async start(): Promise<void> {
		if (this.state === "shutdown") throw new Error("Engine has been shut down");
		if (!this.startPromise) {
			const startup = this.doStart().catch((error) => {
				this.startPromise = undefined;
				throw error;
			});
			// --- keep a startup failure nobody awaits from surfacing as unhandled ---
			startup.catch(() => {});
			this.startPromise = startup;
		}
		return this.startPromise;
	}

	private async doStart(): Promise<void> {
		this.state = "starting";
		installProcessCleanupOnce();
		liveEngines.add(this);
		this.pythonPath = resolvePythonPath(this.options.cwd);
		const timeoutMs = Number(process.env.PI_REPL_TIMEOUT_MS ?? this.options.env?.PI_REPL_TIMEOUT_MS ?? 0) || 0;
		try {
			const snap = this.options.snapshot;
			this.kernel = await KernelClient.start(this.pythonPath, {
				cwd: this.options.cwd,
				env: this.options.env,
				timeoutMs,
				snapshot: snap
					? {
							path: snap.path,
							max_bytes: snap.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES,
							period_ms: snap.periodMs ?? DEFAULT_SNAPSHOT_PERIOD_MS,
						}
					: undefined,
			});
			// --- a fresh boot's helper verdicts are announced once, on the first cell after it ---
			this.helperReport = this.kernel.helperReport;
			this.helperReportTaken = false;
			// --- drop a dead kernel so the next execute rebuilds; never resume a zombie ---
			const current = this.kernel;
			current.setOnUnexpectedExit(() => {
				if (this.kernel !== current) return;
				this.kernel = undefined;
				this.startPromise = undefined;
				this.helperReport = null;
			});
		} catch (error) {
			if (this.state === "starting") this.state = "idle";
			liveEngines.delete(this);
			throw error;
		}
		// --- win the shutdown race: don't resurrect a killed engine as running ---
		if (this.isShutdown()) {
			this.kernel?.kill();
			this.kernel = undefined;
			throw new Error("Engine has been shut down");
		}
		this.state = "running";
		// --- recovery runs in the bridge's first quiet gap — never ahead of a user cell ---
		this.restoreInBackground();
	}

	/** Abrupt teardown: SIGKILL the kernel; safe from process.on("exit"). */
	killSync(): void {
		this.state = "shutdown";
		liveEngines.delete(this);
		this.kernel?.kill();
		this.kernel = undefined;
	}

	async kill(): Promise<void> {
		this.killSync();
	}

	async dispose(): Promise<void> {
		if (this.state === "running") {
			await this.snapshotState().catch(() => null);
		}
		await this.kernel?.shutdown();
		this.killSync();
	}

	async execute(code: string, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
		// --- claim the queue slot synchronously so order == submission order ---
		const previous = this.executionQueue;
		let release: () => void = () => {};
		this.executionQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;

		try {
			if (opts.signal?.aborted) {
				return { stdout: "", stderr: "", status: "aborted", durationMs: 0 };
			}
			if (this.isShutdown()) {
				throw new Error("Engine has been shut down");
			}
			await this.start();
			// --- the kernel may have died after boot resolved but before its exit event; drop the zombie and rebuild ---
			if (this.kernel && !this.kernel.isRunning) {
				this.kernel = undefined;
				this.startPromise = undefined;
				await this.start();
				// --- a mid-session rebuild revives the snapshot BEFORE the triggering cell (startup recovery is background); a wedged revive kills the kernel and the retry skips the restore ---
				await this.restoreWithReap().catch(() => null);
				// --- read health via the getter: TS narrowed this.kernel away, but start() may have replaced it ---
				if (!this.isRunning) {
					this.kernel = undefined;
					this.startPromise = undefined;
					await this.start();
				}
			}
			if (this.isShutdown()) {
				throw new Error("Engine has been shut down");
			}

			const started = Date.now();
			const maxChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
			// One knob for the whole stack, resolved by the SAME function the tool description uses — see
			// `resolveViewLines`. A bound stated in the prompt and a bound used here are one fact, not two.
			const viewLines = resolveViewLines(opts.viewLines, process.env, this.options.env).lines;
			const viewChars = resolveViewChars(opts.viewChars, process.env, this.options.env).chars;
			let aborted = false;
			let graceTimer: ReturnType<typeof setTimeout> | undefined;
			const onAbort = () => {
				aborted = true;
				this.kernel?.interrupt();
				// --- interrupt is a real KeyboardInterrupt, but a C-wedged cell ignores it; then kill+rebuild ---
				graceTimer = setTimeout(() => {
					if (this.state === "running" && this.kernel) {
						this.state = "shutdown";
						this.kernel.kill();
						this.kernel = undefined;
					}
				}, ABORT_GRACE_MS);
				graceTimer.unref?.();
			};
			opts.signal?.addEventListener("abort", onAbort, { once: true });

			try {
				const r = await this.kernel!.executeCell(code, {
					signal: opts.signal,
					onStream: opts.onStream,
					maxOutputChars: maxChars,
				});
				const status: ExecuteResult["status"] = opts.signal?.aborted ? "aborted" : r.status;
				// Two bounds, one rule: nothing is sliced silently. With a capture, the VIEW bound trims what
				// I am shown and names the complete file -- safe exactly because the bridge holds the whole
				// cell before any cap exists. Without one, the channel cap is all there is and no path is
				// claimed, because a pointer at data we do not have is a lie, not a nicety.
				const capture = r.capture;
				const finalize = (text: string, channelTruncated: boolean, name: "stdout" | "stderr"): string => {
					if (capture) {
						// The tee holds the cell's WHOLE stream; `text` is what the kernel's channel ceiling let
						// through. When those two disagree, that difference is bytes the model never saw, and it is
						// named for the view to render -- boundView refuses to call a pre-cut head "untrimmed".
						const ch = capture[name];
						const viewTotals = ch && channelTruncated ? { ...ch, droppedBytes: Math.max(0, ch.bytes - text.length) } : ch;
						return boundView(text, viewLines, capture.path, viewTotals, viewChars).text;
					}
					let out = truncateWithMarker(text, maxChars, channelTruncated);
					const line = capLinesForContext(out);
					if (line.trimmed) out = `${line.text}\n[... some lines exceeded ${MAX_OUTPUT_LINE_CHARS} chars ...]`;
					else out = line.text;
					return out;
				};
				return {
					stdout: finalize(r.stdout, r.truncated?.stdout ?? false, "stdout"),
					stderr: finalize(r.stderr, r.truncated?.stderr ?? false, "stderr"),
					capture,
					// the result rides its own budget, not the channel budget: see DEFAULT_MAX_RESULT_LINES
					result: r.result !== undefined ? boundResult(String(r.result)).text : undefined,
					error: r.error,
					// NOT finalized: stdout/stderr ride the channel cap and result rides the tighter one above,
					// because all three can be 45 KB of stream. A card is written by a helper that chose to write it, and truncating
					// a diff mid-hunk renders a change that does not exist — so the render edge bounds what is
					// shown, and this layer does not silently rewrite the artifact.
					card: r.card,
					status,
					durationMs: Date.now() - started,
				};
			} catch (error) {
				if (aborted) {
					return { stdout: "", stderr: "", status: "aborted", durationMs: Date.now() - started };
				}
				throw error;
			} finally {
				opts.signal?.removeEventListener("abort", onAbort);
				if (graceTimer) clearTimeout(graceTimer);
			}
		} finally {
			release();
		}
	}

	async snapshotState(): Promise<SnapshotResult | null> {
		const config = this.options.snapshot;
		if (!config || this.state !== "running" || !this.kernel) return null;
		try {
			const reply = await this.kernel.snapshot(config.path, config.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES);
			// --- an incomplete snapshot must not overwrite the last good file ---
			if (reply.complete === false) return null;
			// --- the bridge wrote the file atomically; names and counts only cross the pipe ---
			const saved = reply.saved ?? reply.entries?.map((e) => e.name) ?? [];
			return { path: config.path, saved, failed: reply.failed };
		} catch {
			return null;
		}
	}

	/** Restore outcome (never rejects); the background quiet-gap job — this promise is the lifecycle's only announce hook. */
	restoreResult(): Promise<RestoreResult | null> {
		if (this.restoreSettledResult !== undefined) return Promise.resolve(this.restoreSettledResult);
		if (!this.restorePromise) {
			this.restorePromise = new Promise<RestoreResult | null>((resolve) => {
				this.restoreResolve = resolve;
			});
		}
		return this.restorePromise;
	}

	/** True when the restore was deliberately skipped (prior wedge); lets the lifecycle say exactly why. */
	restoreWasSkipped(): boolean {
		return this.restoreSkipped;
	}

	private settleRestore(result: RestoreResult | null): void {
		if (this.restoreSettledResult !== undefined) return;
		this.restoreSettledResult = result;
		this.restoreResolve?.(result);
		this.restoreResolve = undefined;
	}

	/** Background revive: the bridge runs it at its first quiet gap (never ahead of a user cell);
	 *  mid-session rebuilds force it synchronously instead. */
	private restoreInBackground(): void {
		const config = this.options.snapshot;
		const kernel = this.kernel;
		if (!config || !kernel || this.restoreSkipped) {
			this.settleRestore(null);
			return;
		}
		if (kernel === this.restoredKernel) return; // this kernel already revived
		if (!existsSync(config.path)) {
			this.settleRestore(null);
			return;
		}
		this.restoredKernel = kernel;
		// a poisoned pickle would wedge the bridge's single loop forever — the boot deadline
		// kills and marks the revive skipped instead
		const deadlineMs =
			Number(process.env.PI_REPL_BOOT_TIMEOUT_MS ?? this.options.env?.PI_REPL_BOOT_TIMEOUT_MS ?? 0) ||
			DEFAULT_BOOT_TIMEOUT_MS;
		const reaper = setTimeout(() => {
			this.restoreSkipped = true;
			this.settleRestore(null);
			this.kernel?.kill();
		}, deadlineMs);
		reaper.unref?.();
		kernel
			.restore(config.path, true)
			.then((reply) => {
				clearTimeout(reaper);
				const result: RestoreResult = { path: config.path, restored: reply.restored, failed: reply.failed };
				this.settleRestore(result);
			})
			.catch(() => {
				clearTimeout(reaper);
				this.settleRestore(null);
			});
	}

	/** Restore-cell deadline: a poisoned pickle would wedge the bridge's single loop forever — kill, skip, and rebuild honestly. */
	private async restoreWithReap(): Promise<RestoreResult | null> {
		const config = this.options.snapshot;
		if (!config || !this.kernel || this.restoreSkipped) {
			this.settleRestore(null);
			return null;
		}
		if (this.kernel === this.restoredKernel) return this.restoreResult();
		const deadlineMs =
			Number(process.env.PI_REPL_BOOT_TIMEOUT_MS ?? this.options.env?.PI_REPL_BOOT_TIMEOUT_MS ?? 0) ||
			DEFAULT_BOOT_TIMEOUT_MS;
		const reaper = setTimeout(() => {
			this.restoreSkipped = true;
			this.settleRestore(null);
			this.kernel?.kill();
		}, deadlineMs);
		reaper.unref?.();
		try {
			return await this.restoreState(false).catch(() => null);
		} finally {
			clearTimeout(reaper);
		}
	}

	/** Restore, idempotent per kernel: a second call shares the in-flight outcome. */
	async restoreState(skip = false): Promise<RestoreResult | null> {
		// --- start unconditionally: direct callers may not have started, and a wedged boot is only visible mid-attempt ---
		await this.start();
		if (skip) {
			this.settleRestore(null);
			return null;
		}
		const config = this.options.snapshot;
		const kernel = this.kernel;
		if (!config || !kernel || this.restoreSkipped) {
			this.settleRestore(null);
			return null;
		}
		if (kernel === this.restoredKernel) {
			return this.restoreResult();
		}
		// claim the kernel now so a background revive cannot start a second restore cell
		this.restoredKernel = kernel;
		if (!existsSync(config.path)) {
			this.settleRestore(null);
			return null;
		}
		try {
			// v1/v2/v3 dispatch, un-pickling, and the save-time failure merge all live in the bridge
			const reply = await kernel.restore(config.path);
			const result: RestoreResult = { path: config.path, restored: reply.restored, failed: reply.failed };
			this.settleRestore(result);
			return result;
		} catch {
			this.settleRestore(null);
			return null;
		}
	}

	hasSnapshotHistory(): boolean {
		const config = this.options.snapshot;
		return config ? existsSync(dirname(config.path)) : false;
	}

	/** What the bridge reported at boot about its cell-stream tee; undefined when no kernel has readied. */
	captureBoot(): CaptureBootState | undefined {
		return this.kernel?.captureBoot;
	}

	/** The divergence probe, and the two guards it needs: no kernel means no answer (a cold kernel is the
	 *  boot preload, which is disk truth by construction), and a revive that has not landed would report
	 *  revived names as unbound -- so the wait is bounded and a miss means no note, never a false alarm. */
	async surfaceDivergences(): Promise<SurfaceAnswer | null> {
		if (this.state !== "running" || !this.kernel) return null;
		const settled = await Promise.race([
			this.restoreResult().then(() => true),
			new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => resolve(false), 3_000);
				timer.unref?.();
			}),
		]);
		if (!settled) return null;
		try {
			return await this.kernel.surface();
		} catch {
			return null;
		}
	}

	async listNamespaceNames(): Promise<string[] | null> {
		if (this.state !== "running" || !this.kernel) return null;
		try {
			return await this.kernel.listNames();
		} catch {
			return null;
		}
	}
}
