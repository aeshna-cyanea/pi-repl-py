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
import { join } from "node:path";

export const REPL_CONFIG_FILE = "pi-repl.json";

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
}

export const DEFAULT_REPL_CONFIG: ReplConfig = { defaultOn: false, drop: [] };

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
