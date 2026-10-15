/**
 * Pure repl-tool logic: what the three verbs mean, and what they report. index.ts binds pi's API
 * around it — same split as repl-command.ts, so the policy is testable without a kernel.
 *
 * Why these three verbs and not more: they are the things the kernel cannot do to itself. A cell
 * can re-exec its own helper sources (helpers_reload), but it cannot obtain a fresh evaluator, and
 * it cannot see what the host advertised about it or what actually went over the wire.
 */

export type ReplAction = "status" | "reload" | "restart";

/** Structural: the host reads helper files, this module only ever receives plain facts about them. */
import type { HelperEntry } from "./helpers.js";

export interface ReplToolParams {
	action: ReplAction;
	/**
	 * restart only: boot with an EMPTY namespace instead of reviving the snapshot just flushed.
	 * The flushed snapshot is kept (hardlinked) as the undo, so `fresh` is reversible — which is the
	 * only reason it is safe to make `fresh` the verb that fixes a poisoned namespace.
	 */
	fresh?: boolean;
	/** One line saying why. Echoed into the human's toast and the model's reset marker. */
	reason?: string;
}

export type ReplToolDecision = { ok: true; params: ReplToolParams } | { ok: false; error: string };

const ACTIONS: readonly ReplAction[] = ["status", "reload", "restart"];

/**
 * Validate the raw params. Pi's schema already types them, so everything this catches is a
 * *semantic* misuse — and each refusal names the repair, because a refusal that only names the
 * symptom costs the reader a re-derivation (measured on my own guards, 2026-10-14).
 */
export function validateReplParams(raw: unknown): ReplToolDecision {
	if (typeof raw !== "object" || raw === null) return { ok: false, error: "repl takes an object: { action, ... }" };
	const o = raw as Record<string, unknown>;
	const action = o.action;
	if (typeof action !== "string")
		return { ok: false, error: `repl needs an action: ${ACTIONS.join(" | ")}` };
	if (!ACTIONS.includes(action as ReplAction))
		return {
			ok: false,
			error: `unknown repl action "${action}" — expected ${ACTIONS.join(" | ")}`,
		};
	const params: ReplToolParams = { action: action as ReplAction };
	if (o.fresh !== undefined) {
		if (typeof o.fresh !== "boolean") return { ok: false, error: "repl fresh must be a boolean" };
		if (action !== "restart")
			return { ok: false, error: `repl fresh only means anything with action "restart" (got "${action}")` };
		params.fresh = o.fresh;
	}
	if (o.reason !== undefined) {
		if (typeof o.reason !== "string") return { ok: false, error: "repl reason must be a string" };
		const trimmed = o.reason.trim();
		if (trimmed.length > 200) return { ok: false, error: `repl reason is ${trimmed.length} chars; keep it under 200` };
		params.reason = trimmed;
	}
	return { ok: true, params };
}

// --- what the host knows about the evaluator and the helper surface -------------------------------

export interface AdvertisedEntry {
	name: string;
	chars: number;
}

export interface Drift {
	added: string[];
	removed: string[];
	changed: string[];
	same: number;
}

export function isEmptyDrift(d: Drift): boolean {
	return d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0;
}

/**
 * Drift between what the system prompt currently advertises and what is on disk right now. This is
 * the gap that bites: the advertised block is rebuilt at before_agent_start, so a helper edited
 * mid-run is loaded-but-unadvertised (or worse, advertised-but-broken) until the next agent run.
 */
export function diffHelpers(
	advertised: readonly { name: string; description: string }[],
	onDisk: readonly { name: string; description: string }[],
): Drift {
	const adv = new Map(advertised.map((e) => [e.name, e.description]));
	const disk = new Map(onDisk.map((e) => [e.name, e.description]));
	const added: string[] = [];
	const removed: string[] = [];
	const changed: string[] = [];
	let same = 0;
	for (const [name, description] of disk) {
		if (!adv.has(name)) added.push(name);
		else if (adv.get(name) !== description) changed.push(name);
		else same++;
	}
	for (const name of adv.keys()) if (!disk.has(name)) removed.push(name);
	return { added, removed, changed, same };
}

export interface StatusFacts {
	replMode: boolean;
	engine: {
		running: boolean;
		forkInherited: boolean;
		restoreSkipped: boolean;
		hasSnapshotHistory: boolean;
		/** Public names currently in the namespace; null when the kernel is unreachable. */
		names: number | null;
	};
	snapshot: { path: string; exists: boolean; ageMs: number | null; bytes: number | null } | null;
	helpers: {
		files: readonly HelperEntry[];
		advertised: readonly AdvertisedEntry[];
		blockChars: number;
		advertisedAt: number | null;
	};
	wire: {
		requests: number;
		systemChars: number | null;
		toolsChars: number | null;
		payloadChars: number | null;
		at: number | null;
	} | null;
	drift: Drift;
	activeTools: readonly string[];
}

function age(ms: number | null): string {
	if (ms === null) return "unknown";
	if (ms < 1000) return "just now";
	const s = Math.round(ms / 1000);
	if (s < 120) return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 120) return `${m}m ago`;
	return `${Math.round(m / 60)}h ago`;
}

function list(names: readonly string[]): string {
	return names.length === 0 ? "none" : names.join(", ");
}

/**
 * The status report. Every number here is read from one side of the boundary or the other, and the
 * report says which: engine/snapshot are host-side, the wire line is the outbound payload, the
 * helper block is what the host injected into the system prompt. Approximations are labelled as
 * approximations — an unlabelled estimate is how a stale figure becomes a fact.
 */
export function formatStatus(f: StatusFacts): string {
	const lines: string[] = [];
	lines.push(`repl status — repl mode ${f.replMode ? "on" : "off (dormant)"}`);
	const e = f.engine;
	lines.push(
		`  evaluator: ${e.running ? "alive" : "not running"}` +
			(e.names === null ? "" : `, ${e.names} public name(s) in the namespace`) +
			(e.forkInherited ? ", namespace inherited from a /fork'd parent" : "") +
			(e.restoreSkipped ? ", snapshot revive SKIPPED (a prior revive wedged)" : ""),
	);
	if (f.snapshot) {
		const s = f.snapshot;
		lines.push(
			`  snapshot: ${s.exists ? `${s.bytes ?? "?"} B, written ${age(s.ageMs)}` : "none written yet"}`,
		);
		lines.push(`    ${s.path}`);
		if (!s.exists && e.hasSnapshotHistory) lines.push("    (the state dir exists; this conversation has a saved past)");
	} else {
		lines.push("  snapshot: snapshots are off for this session (no session file / ephemeral)");
	}
	const h = f.helpers;
	const undescribed = h.files.filter((x) => x.description === "").map((x) => x.name);
	lines.push(
		`  helpers on disk: ${h.files.length} file(s), ${h.files.reduce((n, x) => n + x.bytes, 0)} B` +
			(undescribed.length ? `, no helper_description: ${list(undescribed)}` : ""),
	);
	lines.push(
		`  advertised to the model: ${h.advertised.length} entr(ies), ${h.blockChars} B of system prompt` +
			(h.advertisedAt === null ? " (not yet built this session)" : `, built ${age(Date.now() - h.advertisedAt)}`),
	);
	if (!isEmptyDrift(f.drift)) {
		lines.push("  DRIFT between advertised and disk:");
		if (f.drift.added.length) lines.push(`    new on disk, not advertised yet: ${list(f.drift.added)}`);
		if (f.drift.removed.length) lines.push(`    advertised but gone from disk: ${list(f.drift.removed)}`);
		if (f.drift.changed.length) lines.push(`    description changed: ${list(f.drift.changed)}`);
		lines.push("    the advertised block is rebuilt at before_agent_start: repl reload re-exec's the sources now.");
	} else {
		lines.push(`  advertised matches disk (${f.drift.same} helper(s) identical)`);
	}
	if (f.wire && f.wire.requests > 0) {
		const w = f.wire;
		lines.push(
			`  measured on the wire (${w.requests} request(s), ${age(w.at === null ? null : Date.now() - w.at)}):` +
				` system ${w.systemChars ?? "?"} B, tools ${w.toolsChars ?? "?"} B, payload ${w.payloadChars ?? "?"} B`,
		);
	} else {
		lines.push("  measured on the wire: nothing yet this session (before_provider_request has not fired)");
	}
	lines.push(`  active tools: ${f.activeTools.join(" ") || "(none)"}`);
	lines.push("  kernel-side tallies are cells, not host facts: helpers_guard_report(), trim_audit()");
	return lines.join("\n");
}

// --- restart: the plan, and what the model is told ---------------------------------------------

export interface RestartPlan {
	/** Snapshot the live namespace before tearing the kernel down. */
	flush: boolean;
	/** Revive that snapshot in the new kernel. */
	restore: boolean;
	fresh: boolean;
}

/**
 * `fresh` is the default-on-destructive half, and it is only safe because the flush happens first
 * and is kept. A restart that revives the snapshot cannot fix a poisoned namespace — which is the
 * whole reason this verb exists (stale REPL state shipped a red test suite twice, 2026-10-15).
 */
export function planRestart(params: ReplToolParams): RestartPlan {
	const fresh = params.fresh === true;
	return { flush: true, restore: !fresh, fresh };
}

export interface FlushReport {
	saved: number;
	failed: number;
}

/** The marker the model reads. Same tag as the lifecycle's own reset notice on purpose: the prompt already teaches that tag. */
export function restartMarker(
	plan: RestartPlan,
	flushed: FlushReport | null,
	revived: { restored: number; failed: number } | null,
	bakPath: string | null,
	reason?: string,
): string {
	const lines = ["<repl_engine_reset>"];
	lines.push(
		plan.fresh
			? "The evaluator was restarted DELIBERATELY with an EMPTY namespace (repl restart fresh:true)."
			: "The evaluator was restarted DELIBERATELY (repl restart) and its namespace was revived from the snapshot flushed at restart.",
	);
	if (reason) lines.push(`Reason given: ${reason}`);
	if (flushed)
		lines.push(
			`Flushed ${flushed.saved} name(s) to the snapshot` +
				(flushed.failed > 0 ? `; ${flushed.failed} could not be serialized` : ""),
		);
	if (bakPath)
		lines.push(
			`That snapshot is kept as a hardlink at ${bakPath} — the undo, until the new kernel overwrites the live one.`,
		);
	if (plan.fresh) {
		lines.push(
			"Every variable, function, import, open file handle and child process from the old kernel is GONE.",
			"Rebuild what you need before using it. To bring the flushed names back: repl restart (without fresh).",
		);
	} else if (revived) {
		lines.push(
			`Revived ${revived.restored} name(s)` + (revived.failed > 0 ? `, lost ${revived.failed}` : "") + ".",
			"Live handles, open resources and source-less functions cannot be snapshotted, so re-open anything you were holding.",
		);
	}
	lines.push("Re-verify a variable before reusing it, especially inside shell interpolation.");
	lines.push("</repl_engine_reset>");
	return lines.join("\n");
}

/** The human's one line. Same counts as the marker, so the two can never disagree. */
export function restartToast(plan: RestartPlan, flushed: FlushReport | null, revived: { restored: number } | null, reason?: string): string {
	const head = plan.fresh ? "repl restart — fresh kernel, namespace empty" : "repl restart — kernel rebuilt, namespace revived";
	const counts = flushed ? `${flushed.saved} flushed` : "nothing flushed";
	const back = revived ? `, ${revived.restored} back` : "";
	return `${head}; ${counts}${back}${reason ? ` — ${reason}` : ""}`;
}

/** A restart asked for while a cell is mid-flight. Refusing is the whole safety property. */
export function restartBlockedNotice(): string {
	return (
		"repl restart refused: a cell is running right now. Tearing the kernel down mid-cell would " +
		"snapshot a namespace in the middle of a write and lose the cell's own result. Wait for the " +
		"cell (or interrupt it), then restart."
	);
}

/** Compose the reload cell. Prefers the kernel's own reload verb when one is loaded, because a
 *  helper that owns state (a guard table, an audit tally) knows how to re-exec itself; the source
 *  list is the fallback, and it is the SAME sources the host just read, so the two cannot diverge. */
export function reloadCell(sources: readonly { name: string; source: string }[]): string {
	const payload = JSON.stringify(sources.map((s) => [s.name, s.source]));
	return [
		"import json as _repl_reload_json",
		`_repl_reload_srcs = _repl_reload_json.loads(${JSON.stringify(payload)})`,
		"_repl_reload = {}",
		"_repl_reload_fn = globals().get('helpers_reload')",
		"if callable(_repl_reload_fn):",
		"\t_repl_reload['via'] = 'helpers_reload()'",
		"\ttry:",
		"\t\t_repl_reload['result'] = _repl_reload_fn()",
		"\texcept Exception as _repl_reload_err:",
		"\t\t_repl_reload['error'] = f'{type(_repl_reload_err).__name__}: {_repl_reload_err}'",
		"else:",
		"\t_repl_reload['via'] = 'host sources'",
		"\t_ok, _bad = [], []",
		"\tfor _name, _src in _repl_reload_srcs:",
		"\t\ttry:",
		"\t\t\texec(compile(_src, _name, 'exec'), globals())",
		"\t\t\t_ok.append(_name)",
		"\t\texcept Exception as _repl_reload_err:",
		"\t\t\t_bad.append(f'{_name}: {type(_repl_reload_err).__name__}: {_repl_reload_err}')",
		"\t_repl_reload['result'] = {'restored': _ok, 'failed': _bad}",
		"print(_repl_reload_json.dumps(_repl_reload, default=str))",
	].join("\n");
}

/** What reload reports: the kernel's own verdict, plus the drift the host can see and the kernel cannot. */
export function formatReload(
	via: string,
	result: { restored?: readonly string[]; failed?: readonly string[] } | null,
	error: string | null,
	drift: Drift,
	blockChars: number,
): string {
	const lines: string[] = [];
	if (error) lines.push(`repl reload: the reload cell raised ${error}`);
	else lines.push(`repl reload via ${via}: ${result?.restored?.length ?? 0} re-exec'd${result?.failed?.length ? `, FAILED: ${list(result.failed)}` : ""}`);
	lines.push(`  advertised block rebuilt: ${blockChars} B of system prompt, effective on your next message`);
	if (isEmptyDrift(drift)) lines.push(`  advertised text unchanged (${drift.same} helper(s) identical)`);
	else {
		lines.push("  advertised text CHANGED (rebuilt at before_agent_start, so the model sees it next run):");
		if (drift.added.length) lines.push(`    + ${list(drift.added)}`);
		if (drift.removed.length) lines.push(`    - ${list(drift.removed)}`);
		if (drift.changed.length) lines.push(`    ~ ${list(drift.changed)}`);
	}
	return lines.join("\n");
}
