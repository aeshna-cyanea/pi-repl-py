// --- pi-repl: one execute tool over Python; everything else runs as functions inside it ---

import { copyFileSync, existsSync, linkSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { EngineManager, pruneOrphanedSnapshotDirs, pruneSnapshotDirs } from "./src/engine/index.js";
import {
	type HelperEntry,
	formatHelperLine,
	formatHelpersBlock,
	helperEntriesForCwd,
} from "./src/extension/helpers.js";
import { buildPromptGuidelines, executePromptSnippet, executeToolDescription } from "./src/extension/prompt.js";
import {
	type ReplToggle,
	droppedToolNames,
	prunedLoadout,
	replArgumentCompletions,
	replToast,
	replUsageMessage,
	restoredTools,
	parseReplToggle,
} from "./src/extension/repl-command.js";
import { loadReplConfig, startEngaged } from "./src/extension/repl-config.js";
import {
	diffHelpers,
	formatReload,
	formatStatus,
	planRestart,
	reloadCell,
	restartBlockedNotice,
	restartMarker,
	restartToast,
	validateReplParams,
	type Drift,
	type ReplAction,
} from "./src/extension/repl-tool.js";
import { ExecuteCellComponent, type ExecuteDetails, type ExecuteRenderState } from "./src/extension/render.js";
import {
	EngineLifecycle,
	formatForkToast,
	formatHelperFailuresLine,
	formatHelperToast,
	formatResetToast,
} from "./src/extension/session-engine.js";
import { withSkillsBlock } from "./src/extension/skill-hook.js";
import { conversationName, inheritForkSnapshot, resolveStateDir } from "./src/extension/state-layout.js";

const executeSchema = Type.Object({
	code: Type.String({
		description: "Python source for this cell; stdout, stderr, and the last-expression result are returned.",
	}),
});

/**
 * One tool, three verbs — not three tools. Each entry costs an always-loaded line in the tool list.
 * The pricing was measured, not assumed (autumn, 2026-10-15): adding a tool costs one prompt-cache
 * miss, and a deep miss re-prefills ~6k tokens in ~2.1 s at `--prompt-cache 32`, not the 168k tokens
 * in 49.2 s it cost at the old cap of 6. So the honest brake is "does this verb belong", never
 * "can I afford the bytes".
 */
const replToolSchema = Type.Object({
	action: Type.String({
		description: '"status" (read-only report), "reload" (re-exec helper sources), or "restart" (new kernel)',
	}),
	fresh: Type.Optional(
		Type.Boolean({
			description:
				"restart only: boot with an EMPTY namespace instead of reviving the snapshot just flushed. The flushed snapshot is kept as <snapshot>.pre-restart, so this is reversible.",
		}),
	),
	reason: Type.Optional(
		Type.String({
			description: "restart/reload: one line saying why. Echoed into the human's toast and the model's reset marker.",
		}),
	),
});

const replToolDescription =
	"Operate the Python evaluator itself, from outside it. `status`: read-only facts the kernel cannot see — " +
	"engine alive, snapshot age, helper files on disk vs what the system prompt advertises, bytes measured on " +
	"the outbound request. `reload`: re-exec the helper sources in the live kernel and report drift against the " +
	"advertised text. `restart`: flush the namespace to a snapshot and boot a new kernel; `fresh: true` boots it " +
	"EMPTY, and the flushed snapshot is kept as the undo.";

const replToolPromptSnippet = "Operate the Python evaluator itself: status, reload helpers, restart the kernel";

const replToolGuidelines = [
	"When the namespace looks wrong — a stale variable, a helper that no longer behaves — `repl status` first. `repl restart` with fresh:true is the only way to get a clean evaluator, and it destroys every live handle in the old one.",
];

/**
 * Structured result for the repl tool. No renderer yet, deliberately: the text report is the product,
 * and a card for a status dump would be a second thing to keep honest. This exists because pi's
 * AgentToolResult requires `details`, and because a future renderer can read facts rather than
 * re-parse prose.
 */
type ReplToolDetails = {
	action: ReplAction;
	drift?: Drift;
	flushed?: number | null;
	revived?: number | null;
	fresh?: boolean;
	bakPath?: string | null;
};

function syncRenderState(
	state: Partial<ExecuteRenderState>,
	context: {
		args?: { code?: string };
		isPartial: boolean;
		isError: boolean;
		expanded: boolean;
		executionStarted: boolean;
	},
): ExecuteRenderState {
	state.code = context.args?.code ?? state.code ?? "";
	state.isPartial = context.isPartial;
	state.isError = context.isError;
	state.expanded = context.expanded;
	state.executionStarted = context.executionStarted;
	state.hasResult = state.hasResult ?? false;
	return state as ExecuteRenderState;
}

/** Stack lines kept when surfacing a cell error to the model. */
const ERROR_STACK_LINES = 10;

/** Header plus stack — without repeating the header when the stack already starts with it. */
function composeErrorLines(error: { name: string; message: string; stack: string[] }): string[] {
	const header = `${error.name}: ${error.message}`;
	const stack = error.stack.slice(0, ERROR_STACK_LINES);
	return stack[0]?.trim() === header ? stack : [header, ...stack];
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("repl", {
		type: "boolean",
		description: "Single execute tool backed by a persistent Python evaluator; replaces the default tool surface",
	});
	// --- the flag lands post-factory, so it is read per event instead of cached here. Caching it at
	// factory time made `pi --repl` a no-op: measured 2026-10-14, with --repl the active set stayed
	// the stock loadout and execute was never even activated, so only `/repl on` mid-session worked.
	// PI_REPL_FORCE=1/0 is the operator escape in both directions; pi-repl.json's defaultOn starts
	// every session engaged; /repl on|off is the per-session override and beats all three. ---
	const config = loadReplConfig(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
	let replOverride: boolean | undefined;
	const active = () =>
		replOverride ??
		startEngaged({ flagOn: pi.getFlag("repl") === true, force: process.env.PI_REPL_FORCE, defaultOn: config.defaultOn });

	let location = { cwd: process.cwd(), sessionFile: undefined as string | undefined };
	/** Active tools captured when /repl on takes over; /repl off puts them back. */
	let stockTools: string[] | undefined;
	// Pi rebuilds thrown errors as bare text; stash details to re-attach in tool_result.
	const pendingErrorResults = new Map<string, { details: ExecuteDetails }>();
	/** What the system prompt currently advertises about helpers, so drift is answerable at all. */
	let advertised: { entries: HelperEntry[]; block: string | undefined; at: number } | undefined;
	/** Bytes measured on the outbound payload — the only honest way to price an always-loaded surface. */
	let wire = {
		requests: 0,
		systemChars: null as number | null,
		toolsChars: null as number | null,
		payloadChars: null as number | null,
		at: null as number | null,
	};
	/** Cells in flight. A restart while one runs would snapshot a namespace mid-write. */
	let cellsInFlight = 0;
	/** This session's snapshot path, recorded at create() so status can stat it. */
	let lastSnapshotPath: string | undefined;

	const lifecycle = new EngineLifecycle<EngineManager>({
		// --- bound the boot: a wedged first boot would hang every cell (acquire() dedupes onto it) ---
		bootTimeoutMs: Number(process.env.PI_REPL_BOOT_TIMEOUT_MS ?? 90_000) || 90_000,
		create(skipRestore = false) {
			const { cwd, sessionFile } = location;
			// --- state lives under ~/.pi/agent/pi-repl/state/<slug>__<conv>; conversations never share a snapshot; ephemeral sessions get none ---
			const stateRoot = join(homedir(), ".pi", "agent", "pi-repl", "state");
			let snapshot: { path: string } | undefined;
			let forkInherited = false;
			let currentDir: string | undefined;
			if (sessionFile) {
				const { dir, snapshotPath } = resolveStateDir(stateRoot, sessionFile);
				currentDir = basename(dir);
				snapshot = { path: snapshotPath };
				// recorded for `repl status`: the snapshot's age and size are host-side facts the kernel cannot see
				lastSnapshotPath = snapshotPath;
				// --- a /fork'd conversation inherits the parent's last namespace (copied once into the fork's own key) ---
				try {
					forkInherited = inheritForkSnapshot(stateRoot, sessionFile, snapshotPath);
				} catch (error) {
					// a racing rename or unreadable session file: the fork starts empty, but loudly
					console.error("[pi-repl] fork snapshot inheritance failed:", error);
				}
				// --- keep the state root from growing one dir per session forever; the live dir is exempt ---
				try {
					pruneSnapshotDirs(stateRoot, 25, currentDir);
				} catch (error) {
					console.error("[pi-repl] snapshot dir pruning failed:", error);
				}
				// --- sweep state dirs whose conversation file exists in no project root: deleting a conversation deletes its snapshots (both dir formats) ---
				try {
					pruneOrphanedSnapshotDirs(stateRoot, sessionFile ? dirname(dirname(sessionFile)) : undefined, currentDir);
				} catch (error) {
					// a readdir race with a concurrent sweep: the sweep retries next session, but loudly
					console.error("[pi-repl] orphan snapshot sweep failed:", error);
				}
			}
			return new EngineManager({
				cwd,
				// --- snapshots are per-conversation; skipRestore marks the wedged-boot retry ---
				snapshot,
				skipRestore,
				forkInherited,
			});
		},
		async dispose(engine) {
			await engine.dispose();
		},
		// --- a wedged guest can't answer dispose; kill and rely on the last snapshot ---
		async discard(engine) {
			await engine.kill();
		},
	});

	// --- no custom prompt: pi's default prompt stands; active tools collapse to execute, so REPL knowledge lives on the tool ---

	pi.on("session_start", async (_event, ctx) => {
		// --- both branches know the session: /repl on in a stock session needs the session file for its state dir ---
		location = { cwd: ctx.cwd, sessionFile: ctx.sessionManager.getSessionFile() ?? undefined };
		if (!active()) {
			// --- capture the stock loadout before dropping execute: /repl off needs it, and this is
			// the one point every stock session passes through (guarded: an empty capture must not
			// mask the built-ins fallback) ---
			const current = pi.getActiveTools().filter((name) => name !== "execute");
			if (current.length > 0) stockTools = current;
			pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "execute"));
			return;
		}
		// --- repl start: remember what the stock loadout was, for /repl off (guard the repeat:
		// a loadout already collapsed to execute-only must not overwrite the capture) ---
		const before = pi.getActiveTools();
		const current = before.filter((name) => name !== "execute");
		if (current.length > 0) stockTools = current;
		// --- collapse Pi's built-ins only; another extension's tool survives unless the operator
		// drops it on purpose, and whatever did go is named out loud rather than left to inference ---
		const next = prunedLoadout(before, config.drop);
		pi.setActiveTools(next);
		ctx.ui.notify(replToast("on", droppedToolNames(before, next), next), "info");
		// --- warm the engine in the background; acquire() dedupes, so the first execute awaits this same boot ---
		const sessionKey = location.sessionFile ? conversationName(location.sessionFile) : undefined;
		void lifecycle.acquire("startup", sessionKey).catch(() => {
			// --- swallow the warm boot's rejection: boot/revive are handled on the execute path ---
		});
	});

	// --- the mode switch: tools are transcript-owned since pi 0.86, so toggling mid-session appends a delta instead of rewriting the prompt head ---
	pi.registerCommand("repl", {
		description: "Toggle the persistent Python REPL: /repl on or /repl off",
		getArgumentCompletions: replArgumentCompletions,
		handler: async (args, ctx) => {
			const toggle: ReplToggle | undefined = parseReplToggle(args);
			if (!toggle) {
				ctx.ui.notify(replUsageMessage(active()), "warning");
				return;
			}
			const on = toggle === "on";
			if (on === active()) {
				// --- idempotent: a repeat /repl on must not overwrite the captured stock loadout with execute-only ---
				ctx.ui.notify(replToast(toggle, [], pi.getActiveTools()), "info");
				return;
			}
			replOverride = on;
			const before = pi.getActiveTools();
			let toast: string;
			if (toggle === "on") {
				// --- remember the stock loadout before the built-ins collapse (same guard as
				// session_start: an execute-only loadout must not capture as []) ---
				const current = before.filter((name) => name !== "execute");
				if (current.length > 0) stockTools = current;
				const next = prunedLoadout(before, config.drop);
				pi.setActiveTools(next);
				toast = replToast("on", droppedToolNames(before, next), next);
				// warm the engine now so the first cell doesn't pay the boot; acquire() dedupes
				const sessionKey = location.sessionFile ? conversationName(location.sessionFile) : undefined;
				// --- swallow the warm boot's rejection: boot/revive are handled on the execute path ---
				void lifecycle.acquire("startup", sessionKey).catch(() => {});
			} else {
				// restore what was active before repl took over (captured at /repl on), so other
				// extensions' active tools come back too; fall back to the built-ins
				const restored = restoredTools(stockTools);
				pi.setActiveTools(restored);
				toast = replToast("off", restored.filter((name) => !before.includes(name)));
				// keep the engine alive: switching back is instant and the namespace is intact
			}
			ctx.ui.notify(toast, "info");
		},
	});

	pi.on("session_shutdown", async () => {
		await lifecycle.shutdown();
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName !== "execute") return undefined;
		const stashed = pendingErrorResults.get(event.toolCallId);
		pendingErrorResults.delete(event.toolCallId);
		if (!stashed || !event.isError) return undefined;
		// --- restore the collapsed details an errored cell lost ---
		return { content: event.content, details: stashed.details, isError: true };
	});

	// --- pi gates skills on the read tool (absent in repl); the helper roster is rebuilt per session from the session cwd, not the launch cwd, so resumes advertise what the kernel loaded ---
	pi.on("before_agent_start", (event, ctx) => {
		if (!active()) return;
		const skillsPrompt = withSkillsBlock(event.systemPrompt, event.systemPromptOptions?.skills ?? []);
		let systemPrompt = skillsPrompt ?? event.systemPrompt;
		const cwd = ctx?.cwd ?? process.cwd();
		// stash what we are about to advertise, so `repl status` can answer the one question that matters
		// about a helper edit: is the model looking at text that matches the file on disk right now?
		const entries = helperEntriesForCwd(cwd, process.env.PI_HELPERS_GLOBAL_DIR, process.env.PI_HELPERS_DIR);
		const helpersBlock = formatHelpersBlock(entries);
		advertised = { entries, block: helpersBlock, at: Date.now() };
		if (helpersBlock) systemPrompt = `${systemPrompt}\n\n${helpersBlock}`;
		return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
	});

	// --- the byte meter. My own rule says price an always-loaded surface by measuring it on the wire,
	// never by summing description chars, and this is the only place that can: the payload here is what
	// actually goes out. Two JSON.stringify per request against a multi-second inference call is noise. ---
	pi.on("before_provider_request", (event) => {
		const body = event.payload as
			| { messages?: Array<{ role?: unknown; content?: unknown }>; tools?: unknown }
			| undefined;
		let systemChars: number | null = null;
		if (Array.isArray(body?.messages)) {
			let n = 0;
			for (const message of body.messages) {
				if (message?.role === "system" && typeof message.content === "string") n += message.content.length;
			}
			if (n > 0) systemChars = n;
		}
		let toolsChars: number | null = null;
		let payloadChars: number | null = null;
		try {
			if (body?.tools !== undefined) toolsChars = JSON.stringify(body.tools).length;
			payloadChars = JSON.stringify(event.payload).length;
		} catch {
			// an unserializable payload: keep the readings we have rather than losing all of them
		}
		wire = { requests: wire.requests + 1, systemChars, toolsChars, payloadChars, at: Date.now() };
	});

	pi.registerTool<typeof executeSchema, ExecuteDetails, Partial<ExecuteRenderState>>({
		name: "execute",
		label: "execute",
		description: executeToolDescription,
		promptSnippet: executePromptSnippet,
		promptGuidelines: buildPromptGuidelines(),
		parameters: executeSchema,
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = syncRenderState(context.state, { ...context, args });
			state.version = (state.version ?? 0) + 1;
			// --- compact header lives in the call slot ---
			return new ExecuteCellComponent(state, theme, "header");
		},
		renderResult(result, options, _theme, context) {
			const state = syncRenderState(context.state, context);
			state.version = (state.version ?? 0) + 1;
			state.hasResult = true;
			state.isPartial = options.isPartial;
			state.expanded = options.expanded;
			state.details = (result.details as ExecuteDetails | undefined) ?? state.details;
			state.contentText = result.content
				?.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			// --- body (code + output) lives in the result slot; Ctrl+O expands it ---
			return new ExecuteCellComponent(state, _theme, "body");
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!active()) {
				throw new Error(
					"pi-repl is dormant in this session. Start pi with --repl, or run /repl on, to use execute.",
				);
			}
			if (ctx?.cwd) location = { cwd: ctx.cwd, sessionFile: ctx.sessionManager?.getSessionFile?.() ?? undefined };
			// --- establish the body slot at call time so Ctrl+O can expand a live, still-streaming cell ---
			onUpdate?.({ content: [], details: {} });
			const sessionKey = location.sessionFile ? conversationName(location.sessionFile) : undefined;
			const { engine: m } = await lifecycle.acquire("cell", sessionKey);
			// a restart while a cell runs would snapshot a namespace mid-write; this counter is the guard
			cellsInFlight++;
			try {
				// --- accumulate partial updates so the row height doesn't oscillate ---
				let streamed = "";
				const r = await m.execute(params.code, {
					signal,
					onStream: (chunk) => {
						streamed += chunk;
						onUpdate?.({ content: [{ type: "text", text: streamed }], details: {} });
					},
				});
				// --- reset notice leads so the model reads the rebuild; the human gets a terse toast instead ---
				const reset = lifecycle.takeResetNotice();
				if (reset?.notice)
					ctx?.ui?.notify?.(
						m.inheritedFromFork
							? formatForkToast(reset.restore)
							: formatResetToast(reset.origin, reset.restore, reset.wedged),
						"info",
					);
				// --- helper verdicts once per boot: toast for the human, marker for the model only when a helper failed (all-good boots stay silent) ---
				const helperReport = m.takeHelperReport();
				if (helperReport && helperReport.length > 0) ctx?.ui?.notify?.(formatHelperToast(helperReport), "info");
				const sections = [reset?.notice, formatHelperFailuresLine(helperReport), r.stdout, r.stderr, r.result];
				const errorLines = r.error ? composeErrorLines(r.error) : undefined;
				if (r.status === "error" && errorLines) sections.push(errorLines.join("\n"));
				if (r.status === "aborted") sections.push("[cell aborted]");
				const text = sections.filter((section) => section !== undefined && section !== "").join("\n");

				const details: ExecuteDetails = {
					status: r.status,
					durationMs: r.durationMs,
					errorName: r.error?.name,
					card: r.card,
					stdout: r.stdout || undefined,
					stderr: r.stderr || undefined,
					result: r.result,
					errorStack: errorLines,
				};
				const result = { content: [{ type: "text" as const, text: text || "(no output)" }], details };
				if (r.status === "error") {
					pendingErrorResults.set(toolCallId, { details });
					throw new Error(text || "(no output)");
				}
				// --- an aborted cell was interrupted, not wedged: the kernel keeps running, nothing to discard ---
				return result;
			} catch (error) {
				// --- a kernel that died (or was killed as the abort backstop) is down; drop it so the next cell rebuilds ---
				if (m.isRunning === false) {
					await lifecycle.discard();
				}
				throw error;
			} finally {
				cellsInFlight = Math.max(0, cellsInFlight - 1);
			}
		},
	});

	// --- the meta-verbs: the things the kernel cannot do to itself. A cell can re-exec its own helper
	// sources, but it cannot obtain a fresh evaluator, cannot see what the host advertised about it, and
	// cannot see what went over the wire. Policy is pure and lives in repl-tool.ts; this is the binding. ---
	pi.registerTool<typeof replToolSchema, ReplToolDetails>({
		name: "repl",
		label: "repl",
		description: replToolDescription,
		promptSnippet: replToolPromptSnippet,
		promptGuidelines: replToolGuidelines,
		parameters: replToolSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const decision = validateReplParams(params);
			if (!decision.ok) throw new Error(decision.error);
			const p = decision.params;
			if (!active() && p.action !== "status")
				throw new Error("pi-repl is dormant in this session. Start pi with --repl, or run /repl on.");
			const sessionKey = location.sessionFile ? conversationName(location.sessionFile) : undefined;
			const diskHelpers = () =>
				helperEntriesForCwd(location.cwd, process.env.PI_HELPERS_GLOBAL_DIR, process.env.PI_HELPERS_DIR);

			if (p.action === "status") {
				// --- read-only: never boot a kernel just to report on it ---
				const m = lifecycle.current;
				const running = m?.isRunning ?? false;
				let names: number | null = null;
				if (running && m) {
					const listed = await m.listNamespaceNames();
					names = listed ? listed.length : null;
				}
				let snapshot: { path: string; exists: boolean; ageMs: number | null; bytes: number | null } | null = null;
				if (lastSnapshotPath) {
					try {
						const st = statSync(lastSnapshotPath);
						snapshot = { path: lastSnapshotPath, exists: true, ageMs: Date.now() - st.mtimeMs, bytes: st.size };
					} catch {
						snapshot = { path: lastSnapshotPath, exists: false, ageMs: null, bytes: null };
					}
				}
				const disk = diskHelpers();
				const adv = advertised?.entries ?? [];
				const drift = diffHelpers(adv, disk);
				const text = formatStatus({
					replMode: active(),
					engine: {
						running,
						forkInherited: m?.inheritedFromFork ?? false,
						restoreSkipped: m?.restoreWasSkipped() ?? false,
						hasSnapshotHistory: m?.hasSnapshotHistory() ?? false,
						names,
					},
					snapshot,
					helpers: {
						files: disk,
						advertised: adv.map((entry) => ({ name: entry.name, chars: formatHelperLine(entry).length })),
						blockChars: advertised?.block?.length ?? 0,
						advertisedAt: advertised?.at ?? null,
					},
					wire,
					drift,
					activeTools: pi.getActiveTools(),
				});
				return { content: [{ type: "text" as const, text }], details: { action: "status", drift } };
			}

			if (p.action === "reload") {
				const { engine: m } = await lifecycle.acquire("cell", sessionKey);
				const disk = diskHelpers();
				const sources = disk.map((entry) => {
					try {
						return { name: entry.name, source: readFileSync(entry.path, "utf8") };
					} catch {
						return { name: entry.name, source: "" };
					}
				});
				const r = await m.execute(reloadCell(sources));
				let via = "unknown";
				let result: { restored?: string[]; failed?: string[] } | null = null;
				let error: string | null = r.error ? `${r.error.name}: ${r.error.message}` : null;
				const lines = (r.stdout ?? "").split("\n").filter((line) => line.trim() !== "");
				const last = lines.pop();
				if (last) {
					try {
						const parsed = JSON.parse(last) as {
							via?: string;
							result?: { restored?: string[]; failed?: string[] };
							error?: string;
						};
						via = parsed.via ?? via;
						result = parsed.result ?? null;
						error = error ?? parsed.error ?? null;
					} catch {
						error = error ?? `unparsable reload report: ${last}`;
					}
				}
				const prev = advertised?.entries ?? [];
				advertised = { entries: disk, block: formatHelpersBlock(disk), at: Date.now() };
				const drift = diffHelpers(prev, disk);
				const report = formatReload(via, result, error, drift, advertised.block?.length ?? 0);
				// the kernel's own lines are the useful half: a helper's reload verb prints what it rebuilt
				const kernelSaid =
					lines.length > 0 ? `\n  kernel said:\n${lines.map((line) => `    ${line}`).join("\n")}` : "";
				return {
					content: [{ type: "text" as const, text: report + kernelSaid }],
					details: { action: "reload", drift },
				};
			}

			// --- restart: flush, tear down, boot. The guard is the safety property, not a nicety. ---
			if (cellsInFlight > 0) throw new Error(restartBlockedNotice());
			const plan = planRestart(p);
			let bakPath: string | null = null;
			if (plan.fresh && lastSnapshotPath && existsSync(lastSnapshotPath)) {
				const candidate = `${lastSnapshotPath}.pre-restart`;
				try {
					rmSync(candidate, { force: true });
					linkSync(lastSnapshotPath, candidate); // a hardlink: O(1), and a snapshot can be 100 MB
					bakPath = candidate;
				} catch {
					try {
						copyFileSync(lastSnapshotPath, candidate);
						bakPath = candidate;
					} catch {
						bakPath = null;
					}
				}
			}
			const { flushed } = await lifecycle.restart(plan, sessionKey);
			const booted = lifecycle.current;
			const revived = booted ? await booted.restoreResult() : null;
			// the marker below IS the notice; leaving the lifecycle's copy pending would announce the same
			// restart twice, and a second <repl_engine_reset> reads like a second rebuild
			lifecycle.takeResetNotice();
			const flushReport = flushed ? { saved: flushed.saved.length, failed: flushed.failed.length } : null;
			const reviveReport = revived ? { restored: revived.restored.length, failed: revived.failed.length } : null;
			ctx?.ui?.notify?.(restartToast(plan, flushReport, reviveReport, p.reason), "info");
			return {
				content: [
					{ type: "text" as const, text: restartMarker(plan, flushReport, reviveReport, bakPath, p.reason) },
				],
				details: {
					action: "restart",
					fresh: plan.fresh,
					flushed: flushReport?.saved ?? null,
					revived: reviveReport?.restored ?? null,
					bakPath,
				},
			};
		},
	});
}
