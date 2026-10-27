/**
 * pi-repl's own settings, read once at extension load: `<agentDir>/pi-repl.json`.
 *
 * Same convention this box already uses for every other extension (headroom.json,
 * pan-clock.json, llama-slots.json, pi-caffeinate.json): the knob lives next to Pi's
 * settings.json, not inside it, because Pi validates its own schema and an extension
 * inventing keys in a file it does not own is how settings drift.
 *
 * A file that exists but cannot be read or parsed is reported and defaults apply. It is never
 * silent: a silently-ignored config is a knob that stops working without saying so, which is the
 * exact failure this file exists to avoid.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

export const REPL_CONFIG_FILE = "pi-repl.json";

/** One rule for a path a human writes by hand: a leading `~` means this user's home. It belongs at the
 *  parse edge and nowhere else, because this value is handed to the bridge as `PI_REPL_CAPTURE_DIR` and the
 *  bridge `mkdir`s it verbatim -- an unexpanded `~/x` becomes a directory literally named `~`, which reads
 *  exactly like a tee that works. Measured 2026-10-27 on the python half of the same boundary, where
 *  `panout._dir()` applies the same rule for the same reason. Only a leading `~` counts: a tilde in the
 *  middle of a path is somebody's filename.
 */
export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith(`~${sep}`)) return join(homedir(), path.slice(2));
	return path;
}

export interface ReplConfig {
	/** Start every session in repl mode. `/repl off` and PI_REPL_FORCE=0 still win per session. */
	defaultOn: boolean;
	/**
	 * Tools repl mode drops *in addition to* Pi's built-ins (see BUILTIN_TOOL_NAMES in
	 * repl-command.ts). Only worth naming when the kernel has a genuinely better route to the
	 * same job — on bagheera that is `sessions` (preloaded Python helpers over the session JSONL)
	 * and `remote` (subprocess.run with an argv list). A name that is not registered is a no-op.
	 */
	drop: string[];
	/**
	 * Where a cell's COMPLETE stdout+stderr is written: `<captureDir>/<session stem>/cell-<n>.txt`.
	 * Empty (the default) means the tee is off: the engine caps output and says there is no copy. It is
	 * opt-in because writing every cell's stream is a decision about this box's disk -- on bagheera the
	 * hot tier is tmpfs, i.e. RAM, and a retention policy already lives next to it in panlib.
	 */
	captureDir: string;
	/**
	 * How many lines of a cell's stream I am shown before the marker points at the complete copy.
	 * ONE knob for two layers: the engine trims at this, and the same number is handed to the kernel as
	 * PAN_VIEW_LINES so panlib's own view verbs (peek/show/cap/run) default to it. Measured 2026-10-27:
	 * 120 clips 3.4% of results, 60 clips 10.6%.
	 */
	viewLines: number;
	/**
	 * Bytes one cell's tee file may hold, in megabytes. It bounds a runaway loop, not a session: past this
	 * the bridge writes what it held, says so INSIDE the file, and moves on. Handed to the bridge as
	 * PI_REPL_CAPTURE_MAX_BYTES. The tier as a whole is NOT bounded here — retention of this directory is
	 * panlib's job (HOT_CAP / ARCHIVE_CAP, now read from this same file), and two janitors for one tier is
	 * how a capture ends up evicted by the wrong one.
	 */
	cellMaxMb: number;
}

export const DEFAULT_REPL_CONFIG: ReplConfig = {
	defaultOn: false,
	drop: [],
	captureDir: "",
	viewLines: 120,
	cellMaxMb: 32,
};

/** Tolerant of junk, never throws, and says what it discarded. */
export function parseReplConfig(raw: unknown, warn: (message: string) => void = console.warn): ReplConfig {
	if (typeof raw !== "object" || raw === null) {
		warn(`[pi-repl] config is not an object, using defaults`);
		return { ...DEFAULT_REPL_CONFIG };
	}
	const record = raw as Record<string, unknown>;
	const next: ReplConfig = { ...DEFAULT_REPL_CONFIG };
	if (record.defaultOn !== undefined) {
		if (typeof record.defaultOn === "boolean") next.defaultOn = record.defaultOn;
		else warn(`[pi-repl] config defaultOn must be true or false, got ${typeof record.defaultOn}; ignoring`);
	}
	if (record.drop !== undefined) {
		if (Array.isArray(record.drop)) {
			const kept = record.drop.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
			if (kept.length !== record.drop.length) warn(`[pi-repl] config drop: ignored ${record.drop.length - kept.length} non-string entries`);
			next.drop = kept;
		} else warn(`[pi-repl] config drop must be a list of tool names, got ${typeof record.drop}; ignoring`);
	}
	if (record.captureDir !== undefined) {
		if (typeof record.captureDir === "string") next.captureDir = expandHome(record.captureDir);
		else warn(`[pi-repl] config captureDir must be a path or "", got ${typeof record.captureDir}; ignoring`);
	}
	if (record.cellMaxMb !== undefined) {
		const n = Number(record.cellMaxMb);
		if (Number.isInteger(n) && n > 0) next.cellMaxMb = n;
		else warn(`[pi-repl] config cellMaxMb must be a positive whole number of megabytes, got ${String(record.cellMaxMb)}; ignoring`);
	}
	if (record.viewLines !== undefined) {
		const n = Number(record.viewLines);
		if (Number.isInteger(n) && n > 0) next.viewLines = n;
		else warn(`[pi-repl] config viewLines must be a positive integer, got ${String(record.viewLines)}; ignoring`);
	}
	return next;
}

export function loadReplConfig(agentDir: string, warn: (message: string) => void = console.warn): ReplConfig {
	const path = join(agentDir, REPL_CONFIG_FILE);
	if (!existsSync(path)) return { ...DEFAULT_REPL_CONFIG };
	try {
		return parseReplConfig(JSON.parse(readFileSync(path, "utf8")), warn);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		warn(`[pi-repl] cannot read ${path}: ${detail}; using defaults`);
		return { ...DEFAULT_REPL_CONFIG };
	}
}

/**
 * Whether repl mode starts engaged. Explicit beats configured, and the escape hatch works in both
 * directions: PI_REPL_FORCE=1 forces it on, =0 forces it off, so a box with defaultOn true can
 * still start a stock session without editing files.
 */
export function startEngaged(input: { flagOn: boolean; force?: string; defaultOn: boolean }): boolean {
	if (input.force === "1") return true;
	if (input.force === "0") return false;
	return input.flagOn || input.defaultOn;
}
