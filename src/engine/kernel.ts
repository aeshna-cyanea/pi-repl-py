// --- KernelClient over one stdio pipe: bridge.py owns ipykernel and the Jupyter protocol;
// --- this side spawns it, speaks one JSON line at a time, and applies the output caps. ---

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHelperDirs } from "./helpers-locate.js";

/** A wedged bridge must not own the prompt build: this op answers a question the prompt can live without. */
const SURFACE_TIMEOUT_MS = 4_000;

/** One divergence as panlib reports it. `kind` is the contract; the host renders each shape in its own words
 *  rather than pasting panlib's prose into a system prompt. The RULE lives in panlib, not here. */
export interface SurfaceDivergence {
	kind: string; // unbound | kind | signature | class | generation
	name?: string | null;
	count?: number;
	names?: string[];
	why?: string;
	block?: string;
	live?: string;
	repair?: string;
}

export interface SurfaceAnswer {
	divergences?: SurfaceDivergence[];
	error?: string;
}

const SILENCE_KILL_GRACE_MS = 2000;
/** The bridge ships at the package root, next to index.ts; src/engine is two levels deep. */
const BRIDGE_PATH = fileURLToPath(new URL("../../bridge.py", import.meta.url));
/**
 * The one line the kernel runs before the helper preload (Key 221 step 2).
 *
 * It is a *line*, not a mechanism: the package it imports declares the flat verb surface, and the host
 * neither parses nor advertises it. Empty string turns it off, which is the revert lever — no code
 * change, no rebuild, and the helpers alone still give a working session.
 */
export const DEFAULT_BOOTSTRAP = "from panlib.boot import *";

export interface KernelOptions {
	cwd?: string;
	env?: Record<string, string>;
	/** Silence watchdog in ms; 0 = no cap (a silent-but-working cell may run on). */
	timeoutMs?: number;
	/** When present, the bridge self-schedules snapshots in its own quiet gaps. */
	snapshot?: { path: string; max_bytes: number; period_ms: number };
}

/** One cell's complete stream, written by the bridge before any cap ran.
 *  The engine trims what I am *shown* only because this exists: a pointer at the whole thing is what
 *  makes a bounded view honest. One file per cell, shared by stdout and stderr; the per-channel
 *  totals let the view marker state the true size of each channel instead of the size of the head
 *  that survived. Absent when PI_REPL_CAPTURE_DIR is unset — then the engine keeps its old behaviour
 *  and says so, because a pointer at data we do not have is a lie, not a nicety. */
export interface StreamCapture {
	path: string;
	/** lines/bytes the tee holds for that channel; `cut` when the tee's own byte bound stopped it. */
	stdout?: { lines: number; bytes: number; cut?: boolean };
	stderr?: { lines: number; bytes: number; cut?: boolean };
	/** Why no file was written, when the bridge declined (e.g. the kernel was never told its stem). */
	reason?: string;
}

/** What the bridge says at boot about its own tee. Reported, never inferred: a component that is off
 *  without saying so reads exactly like a component that is working. */
export interface CaptureBootState {
	on: boolean;
	dir?: string;
	max_bytes?: number;
	reason?: string;
}

export interface CellResult {
	stdout: string;
	stderr: string;
	result?: string;
	error?: { name: string; message: string; stack: string[] };
	status: "ok" | "error" | "aborted";
	truncated?: { stdout: boolean; stderr: boolean };
	/**
	 * A display card a kernel function asked for (Key 138) — patch() writes one so the TUI can show a
	 * diff as a diff. Shape is the writer's business and is validated at the render edge, not here: the
	 * engine only carries it, because a kernel that can invent a card kind should not need an engine
	 * change to do it.
	 */
	card?: unknown;
	/** Complete stream copy, when the bridge tee wrote one; see `StreamCapture`. */
	capture?: StreamCapture;
}

export interface CellOptions {
	signal?: AbortSignal;
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	/** The engine owns cap policy (DEFAULT_MAX_OUTPUT_CHARS); the kernel is transport and must not default its own. */
	maxOutputChars: number;
}

export interface SnapshotReply {
	/** Names persisted; payloads never cross the pipe — the bridge wrote the file itself. */
	saved?: string[];
	/** Only present for tests that fake the kernel; the real bridge replies with counts only. */
	entries?: { name: string; kind: "value" | "def"; payload: string }[];
	failed: { name: string; reason: string }[];
	complete: boolean;
	/** Payload bytes written; drives the periodic-refresh stand-down. */
	bytes?: number;
}

export interface HelperLoadResult {
	name: string;
	ok: boolean;
	/** First error line, e.g. "NameError: name 'x' is not defined"; undefined when ok. */
	error?: string;
}

/** What the bridge says about the injected bootstrap line: it ran, and whether it raised. */
export interface BootstrapLoadResult {
	ok: boolean;
	/** The line as the host sent it, so a report shows which line a verdict is about. */
	line: string;
	error?: string;
}

interface BridgeMessage {
	type?: string;
	id?: string;
	[key: string]: unknown;
}

interface ActiveCell {
	id: string;
	stdout: string[];
	stderr: string[];
	outLen: number;
	errLen: number;
	maxChars: number;
	result?: string;
	error?: { name: string; message: string; stack: string[] };
	card?: unknown;
	status: CellResult["status"];
	lastActivity: number;
	timedOut: boolean;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	signal?: AbortSignal;
	/** Set from the bridge result event; the cell's whole stream lives at this path. */
	capture?: StreamCapture;
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	resolve(result: CellResult): void;
	reject(error: Error): void;
	settled: boolean;
}

interface PendingRequest {
	resolve(msg: BridgeMessage): void;
	reject(error: Error): void;
	timer?: ReturnType<typeof setTimeout>;
}

/** Kernel cwd falls back to the host cwd when the requested dir is gone (a deleted project is a real resume case). */
function resolveCwd(requested?: string): string {
	if (requested && existsSync(requested)) return requested;
	return process.cwd();
}

/** Read the helpers dir (same skip rules as the extension's prompt loader); sources travel in the boot line. */
function readHelperSources(dirs: string[]): { name: string; source: string }[] {
	// --- merged dirs come pre-ordered (project first, global last); first-seen name wins ---
	const seen = new Set<string>();
	const out: { name: string; source: string }[] = [];
	for (const d of dirs) {
		if (!existsSync(d)) continue;
		for (const file of readdirSync(d).sort()) {
			if (!file.endsWith(".py")) continue;
			const name = file.slice(0, -3);
			if (!/^[A-Za-z_]\w*$/.test(name) || name.startsWith("_")) continue;
			if (seen.has(name)) continue;
			seen.add(name);
			try {
				out.push({ name, source: readFileSync(join(d, file), "utf8") });
			} catch {}
		}
	}
	return out;
}

export class KernelClient {
	private child?: ChildProcess;
	private readonly timeoutMs: number;
	private ready = false;
	/** Serializes all kernel ops: one execute at a time, snapshots between cells. */
	private queue: Promise<unknown> = Promise.resolve();
	private pending = new Map<string, PendingRequest>();
	private activeCell?: ActiveCell;
	private inputBuffer = "";
	private readyWaiters: { resolve(msg: BridgeMessage): void; reject(error: Error): void }[] = [];
	private helperBootReport: HelperLoadResult[] = [];
	private bootstrapReport?: BootstrapLoadResult;
	private captureBootReport?: CaptureBootState;
	private nextId = 0;
	private _onUnexpectedExit?: () => void;
	private watchdog?: ReturnType<typeof setInterval>;
	private silenceKillTimer?: ReturnType<typeof setTimeout>;

	private constructor(opts: KernelOptions) {
		this.timeoutMs = opts.timeoutMs ?? 0;
	}

	static async start(pythonPath: string, opts: KernelOptions = {}): Promise<KernelClient> {
		const child = spawn(pythonPath, [BRIDGE_PATH], {
			cwd: resolveCwd(opts.cwd),
			env: { ...process.env, ...(opts.env ?? {}) },
			stdio: ["pipe", "pipe", "pipe"],
			// its own process group: kill(-pid) reaches the kernel the bridge spawns too
			detached: true,
		});
		// keep stderr for post-mortems (ipykernel warnings, bridge tracebacks)
		let stderrTail = "";
		child.stderr?.on("data", (b: Buffer) => {
			stderrTail = (stderrTail + b.toString()).slice(-4000);
		});

		const kc = new KernelClient(opts);
		kc.child = child;
		child.stdout?.on("data", (chunk) => kc.onData(chunk));
		child.on("exit", () => {
			// --- bridge exit IS kernel death: settle the running cell and drop the zombie ---
			kc.settleActive(new Error("kernel process exited"));
			kc.ready = false;
			kc.child = undefined;
			kc.rejectBootWaiters(new Error("bridge exited before it was ready"));
			kc._onUnexpectedExit?.();
		});

		// helpers resolve host-side (one canonical list, same skip rules as the prompt); sources preload in the bridge
		const helpers = (
			opts.env?.PI_HELPERS_DIR
				? readHelperSources([opts.env.PI_HELPERS_DIR])
				: readHelperSources(resolveHelperDirs(opts.cwd, opts.env?.PI_HELPERS_GLOBAL_DIR))
		).map((h) => ({ name: h.name, source: h.source }));
		// **Per-engine env first, then the process env** — the opposite precedence to the numeric knobs in
		// index.ts, and deliberately: this one decides what code runs at boot, so the caller that set it
		// (the embedding extension, the test suite) has to be able to settle it without an ambient variable
		// re-arming it. A knob whose off switch can be overridden by the environment is not an off switch.
		const bootstrap = opts.env?.PI_REPL_BOOTSTRAP ?? process.env.PI_REPL_BOOTSTRAP ?? DEFAULT_BOOTSTRAP;
		kc.send({ op: "boot", helpers, bootstrap, snapshot: opts.snapshot });

		try {
			await kc.waitReady();
		} catch (error) {
			kc.kill();
			throw error instanceof Error
				? new Error(`${error.message}${stderrTail ? `\nbridge stderr:\n${stderrTail}` : ""}`)
				: error;
		}
		kc.ready = true;
		return kc;
	}

	private onData(chunk: Uint8Array): void {
		this.inputBuffer += Buffer.from(chunk).toString("utf8");
		let idx = this.inputBuffer.indexOf("\n");
		while (idx >= 0) {
			const line = this.inputBuffer.slice(0, idx).trim();
			this.inputBuffer = this.inputBuffer.slice(idx + 1);
			if (line) this.handleLine(line);
			idx = this.inputBuffer.indexOf("\n");
		}
	}

	/** Route-gate: a line that is not valid JSON is not the bridge. */
	private handleLine(line: string): void {
		let msg: BridgeMessage;
		try {
			msg = JSON.parse(line) as BridgeMessage;
		} catch {
			console.error("[pi-repl] unparseable bridge line:", line.slice(0, 200));
			return;
		}
		switch (msg.type) {
			case "ready": {
				const helpers = Array.isArray(msg.helpers) ? (msg.helpers as HelperLoadResult[]) : [];
				this.helperBootReport = helpers;
				const b = msg.bootstrap as BootstrapLoadResult | null | undefined;
				this.bootstrapReport = b && typeof b.ok === "boolean" ? b : undefined;
				const cap = msg.capture as CaptureBootState | null | undefined;
				this.captureBootReport = cap && typeof cap.on === "boolean" ? cap : undefined;
				// A failed bootstrap joins the helper report rather than riding its own channel, because the
				// extension already has a path for "some boot-time code did not load": the toast and the
				// <repl_helpers_failed> line, which is exactly the shape I act on. During coexistence a
				// bootstrap and a helper are the same kind of thing -- boot-time code landing in __main__.
				if (this.bootstrapReport && !this.bootstrapReport.ok) {
					this.helperBootReport = [
						{ name: "bootstrap", ok: false, error: this.bootstrapReport.error ?? "failed to run" },
						...this.helperBootReport,
					];
				}
				this.readyWaiters.shift()?.resolve(msg);
				break;
			}
			case "stream": {
				const active = this.activeCell;
				if (active && msg.id === active.id) {
					active.lastActivity = Date.now();
					this.accumulate(active, msg.name === "stderr" ? "stderr" : "stdout", String(msg.text ?? ""));
				}
				break;
			}
			case "result": {
				const active = this.activeCell;
				if (active && msg.id === active.id) this.settleFromResult(active, msg);
				break;
			}
			case "reply": {
				const id = msg.id;
				if (id !== undefined) {
					const pending = this.pending.get(id);
					if (pending) {
						this.pending.delete(id);
						if (pending.timer) clearTimeout(pending.timer);
						pending.resolve(msg);
					}
				}
				break;
			}
			case "error": {
				const error = new Error(String(msg.message ?? "bridge error"));
				const id = msg.id;
				if (id !== undefined && this.pending.has(id)) {
					const pending = this.pending.get(id)!;
					this.pending.delete(id);
					if (pending.timer) clearTimeout(pending.timer);
					pending.reject(error);
				} else if (this.readyWaiters.length > 0) {
					this.readyWaiters.shift()!.reject(error); // boot failure
				} else {
					console.error("[pi-repl] bridge error:", error.message);
				}
				break;
			}
			default:
				console.error("[pi-repl] unknown bridge event:", JSON.stringify(msg).slice(0, 200));
		}
	}

	private send(msg: object): void {
		this.child?.stdin?.write(JSON.stringify(msg) + "\n");
	}

	/** Resolves on the bridge's ready event; rejects on a boot error or a bridge exit.
	 *  A wedged (alive but silent) bridge is bounded by the lifecycle's boot race. */
	private waitReady(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.readyWaiters.push({ resolve: () => resolve(), reject });
		});
	}

	private rejectBootWaiters(error: Error): void {
		const waiters = this.readyWaiters.splice(0);
		for (const w of waiters) w.reject(error);
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.queue.then(fn, fn);
		this.queue = result.catch(() => {});
		return result;
	}

	/** A request/reply op: snapshot, restore, listNames, surface, shutdown. Serialized with cells. */
	private request(msg: Record<string, unknown>, timeoutMs?: number): Promise<BridgeMessage> {
		return this.enqueue(() => {
			const id = `r${this.nextId++}`;
			return new Promise<BridgeMessage>((resolve, reject) => {
				const timer = timeoutMs
					? setTimeout(() => {
							this.pending.delete(id);
							reject(new Error(`bridge did not answer ${String(msg.op)} in time`));
						}, timeoutMs)
					: undefined;
				timer?.unref?.();
				this.pending.set(id, { resolve, reject, timer });
				this.send({ ...msg, id });
			});
		});
	}

	executeCell(code: string, opts: CellOptions): Promise<CellResult> {
		return this.enqueue(() => this.executeCellNow(code, opts));
	}

	private executeCellNow(code: string, opts: CellOptions): Promise<CellResult> {
		const maxChars = opts.maxOutputChars;
		// one op id per request; the bridge echoes it on every stream and the result event
		const id = `e${this.nextId++}`;
		const active: ActiveCell = {
			id,
			stdout: [],
			stderr: [],
			outLen: 0,
			errLen: 0,
			maxChars,
			lastActivity: Date.now(),
			timedOut: false,
			stdoutTruncated: false,
			stderrTruncated: false,
			signal: opts.signal,
			onStream: opts.onStream,
			status: "ok",
			settled: false,
			resolve: () => {},
			reject: () => {},
		};
		this.activeCell = active;
		const onAbort = () => this.interrupt();
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		this.send({ op: "exec", id, code });
		this.startWatchdog(active);

		return new Promise<CellResult>((resolve, reject) => {
			active.resolve = resolve;
			active.reject = reject;
			if (opts.signal?.aborted) this.interrupt();
		}).finally(() => {
			if (this.activeCell === active) this.activeCell = undefined;
			this.stopWatchdog();
			opts.signal?.removeEventListener("abort", onAbort);
		});
	}

	private settleActive(error: Error): void {
		const active = this.activeCell;
		if (!active || active.settled) return;
		active.settled = true;
		active.reject(error);
	}

	private settleFromResult(active: ActiveCell, msg: BridgeMessage): void {
		// the bridge settles only once the shell reply AND the iopub idle arrived
		if (active.settled) return;
		active.settled = true;
		const content = msg as {
			status?: string;
			result?: string;
			error?: { name?: string; message?: string; stack?: string[] };
			card?: unknown;
			capture?: StreamCapture;
		};
		if (content.result !== undefined) active.result = content.result;
		if (content.card !== undefined) active.card = content.card;
		// validated only as far as it is used as text: the path is rendered into my view marker, so a
		// non-string from a mismatched bridge must not become a line of my context. Everything else the
		// engine reads are numbers it only formats.
		if (typeof content.capture?.path === "string") active.capture = content.capture;
		if (content.error) {
			active.error = {
				name: content.error.name ?? "Error",
				message: content.error.message ?? "",
				stack: content.error.stack ?? [],
			};
		}
		let status: CellResult["status"] = content.status === "aborted" ? "aborted" : active.error ? "error" : "ok";
		if (active.signal?.aborted) {
			// the caller withdrew; report aborted even if the cell raised
			status = "aborted";
		} else if (active.timedOut) {
			// silence watchdog tripped: the cell was still running, not done
			status = "error";
			active.error = {
				name: "Timeout",
				message: "cell did not finish within the silence window and may still be running",
				stack: ["[cell timed out]"],
			};
		}
		active.status = status;
		active.resolve({
			stdout: active.stdout.join(""),
			stderr: active.stderr.join(""),
			result: active.result,
			error: active.error,
			card: active.card,
			status,
			truncated: { stdout: active.stdoutTruncated, stderr: active.stderrTruncated },
			capture: active.capture,
		});
	}

	private accumulate(active: ActiveCell, name: "stdout" | "stderr", text: string): void {
		const arr = name === "stdout" ? active.stdout : active.stderr;
		const len = name === "stdout" ? active.outLen : active.errLen;
		const room = active.maxChars - len;
		const keep = Math.min(text.length, Math.max(0, room));
		if (keep > 0) {
			arr.push(text.slice(0, keep));
			if (name === "stdout") active.outLen += keep;
			else active.errLen += keep;
		}
		// one oversized stream frame (10 MB print) overflows the cap within this call
		if (text.length > keep) {
			if (name === "stdout") active.stdoutTruncated = true;
			else active.stderrTruncated = true;
		}
		// beyond the cap we drop text but keep draining
		active.onStream?.(text.slice(0, keep), name);
	}

	private startWatchdog(active: ActiveCell): void {
		this.stopWatchdog();
		if (!this.timeoutMs) return;
		this.watchdog = setInterval(
			() => {
				const quiet = Date.now() - active.lastActivity;
				if (quiet >= this.timeoutMs && !active.settled) {
					active.timedOut = true;
					this.interrupt();
					// a cell that swallows the interrupt never replies; escalate to a kill so the queue frees
					this.silenceKillTimer ??= setTimeout(() => {
						if (!active.settled) this.kill();
					}, SILENCE_KILL_GRACE_MS);
					this.silenceKillTimer.unref?.();
				}
			},
			Math.min(250, this.timeoutMs),
		);
		this.watchdog.unref?.();
	}

	private stopWatchdog(): void {
		if (this.watchdog) {
			clearInterval(this.watchdog);
			this.watchdog = undefined;
		}
		if (this.silenceKillTimer) {
			clearTimeout(this.silenceKillTimer);
			this.silenceKillTimer = undefined;
		}
	}

	/** Genuine KeyboardInterrupt via the bridge's control channel; the kernel survives. */
	interrupt(): void {
		this.send({ op: "interrupt" });
	}

	snapshot(path: string, maxBytes: number): Promise<SnapshotReply> {
		return this.request({ op: "snapshot", path, max_bytes: maxBytes }).then((msg) => {
			const m = msg as {
				saved?: string[];
				entries?: { name: string; kind: "value" | "def"; payload: string }[];
				failed?: { name: string; reason: string }[];
				complete?: boolean;
				bytes?: number;
				error?: string;
			};
			if (m.error !== undefined || m.complete === undefined) {
				throw new Error(String(m.error ?? "snapshot failed"));
			}
			return { saved: m.saved, entries: m.entries, failed: m.failed ?? [], complete: m.complete, bytes: m.bytes };
		});
	}

	restore(path: string, defer = false): Promise<{ restored: string[]; failed: { name: string; reason: string }[] }> {
		if (defer) {
			// background revive: bypass the op queue — a queued restore would hold every user
			// cell behind its completion. The bridge runs it at its first quiet gap instead.
			const id = `r${this.nextId++}`;
			return new Promise<BridgeMessage>((resolve, reject) => {
				this.pending.set(id, { resolve, reject });
				this.send({ op: "restore", path, defer: true, id });
			}).then((msg) => {
				const m = msg as { restored?: string[]; failed?: { name: string; reason: string }[]; error?: string };
				if (m.error !== undefined) throw new Error(m.error);
				return { restored: m.restored ?? [], failed: m.failed ?? [] };
			});
		}
		return this.request({ op: "restore", path }).then((msg) => {
			const m = msg as { restored?: string[]; failed?: { name: string; reason: string }[]; error?: string };
			if (m.error !== undefined) throw new Error(m.error);
			return { restored: m.restored ?? [], failed: m.failed ?? [] };
		});
	}

	listNames(): Promise<string[]> {
		return this.request({ op: "listNames" }).then((msg) => {
			const names = (msg as { names?: unknown }).names;
			return Array.isArray(names) ? (names as string[]) : [];
		});
	}

	/** What the live kernel's flat bindings actually are, against the block the host is about to advertise.
	 *  The RULE lives in panlib (`binding_divergence`); this only carries the answer. Bounded, because a
	 *  wedged bridge must not own a prompt build. */
	surface(): Promise<SurfaceAnswer> {
		return this.request({ op: "surface" }, SURFACE_TIMEOUT_MS).then((msg) => {
			const m = msg as { divergences?: unknown; error?: unknown };
			return {
				divergences: Array.isArray(m.divergences) ? (m.divergences as SurfaceDivergence[]) : undefined,
				error: typeof m.error === "string" ? m.error : undefined,
			};
		});
	}

	/** Graceful stop: shutdown op, then SIGKILL the process group as backstop. */
	async shutdown(): Promise<void> {
		if (this.ready && this.child) {
			await this.request({ op: "shutdown" }, 2000).catch(() => {});
		}
		this.kill();
	}

	kill(): void {
		this.stopWatchdog();
		this.settleActive(new Error("kernel killed"));
		const pid = this.child?.pid;
		if (pid !== undefined) {
			// group kill: the bridge's kernel is in the same process group (detached spawn)
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
		}
		this.child = undefined;
	}

	/** Engine hook: an unexpected bridge exit (not a deliberate kill) should drop the instance. */
	setOnUnexpectedExit(fn: () => void): void {
		this._onUnexpectedExit = fn;
	}

	get helperReport(): readonly HelperLoadResult[] {
		return this.helperBootReport;
	}

	/** The bridge's own verdict on the injected line; undefined when no bootstrap was sent. */
	get bootstrap(): BootstrapLoadResult | undefined {
		return this.bootstrapReport;
	}

	/** The bridge's verdict on its own cell-stream tee, taken from the ready event; undefined before ready. */
	get captureBoot(): CaptureBootState | undefined {
		return this.captureBootReport;
	}

	get isRunning(): boolean {
		return this.ready && this.child !== undefined && this.child.exitCode === null;
	}
}
