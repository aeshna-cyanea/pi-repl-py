/** helper_description surfaces verbatim — there is no signature parsing. */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveHelperDirs } from "../engine/helpers-locate.js";
import { resolvePythonPath } from "../engine/index.js";

const DEFAULT_HELPERS_DIR = join(homedir(), ".pi", "agent", "pi-repl", "helpers");

export interface HelperEntry {
	name: string;
	description: string; // full helper_description body, "" if absent
	path: string;
	bytes: number;
	mtimeMs: number;
}

function parseDescription(source: string): string {
	const m = source.match(/helper_description\s*=\s*("""|''')([\s\S]*?)\1/);
	return m ? m[2].trim() : "";
}

// --- a helper may render its own description instead of being scraped ---------------------------------
/** A helper that carries this marker answers `<python> <file> --surface` with one JSON object whose
 *  `block` is the text to advertise. The marker is the whole contract. It exists because a scraped
 *  literal is a COPY of a decision and can drift from the code it describes, while a query cannot: the
 *  answer comes from the same read that does the binding. Key 221 step 4, 2026-10-20. */
export const SURFACE_QUERY_MARKER = "# SURFACE-QUERY";
export const SURFACE_QUERY_ARG = "--surface";
/** A render that imports my whole package tree measured 0.31 s on bagheera; a wedged one must not own a run. */
const SURFACE_QUERY_TIMEOUT_MS = 15_000;
const SURFACE_QUERY_MAX_BUFFER = 4 * 1024 * 1024;
/** Stable text, deliberately NOT a timestamp: a query that fails every run would otherwise change the
 *  system prompt's bytes every run, and the always-loaded block is a prompt-cache boundary. */
const STALE_NOTE = "STALE";

export interface HelperOptions {
	pythonPath?: string;
	/** injectable so a unit test never needs an interpreter; the real one is `querySurface` */
	query?: (path: string, pythonPath: string) => string;
	/** last good block per path; a failed query degrades to a VISIBLE cache, never to a silent source */
	cache?: Map<string, string>;
}

/** Module-level so the cache outlives one call: the prompt build and the drift report are separate calls. */
const surfaceCache = new Map<string, string>();

/** Validate the answer. Split out so the contract is testable without an interpreter. */
export function parseSurfaceAnswer(text: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`answer was not JSON (${text.length} B read)`);
	}
	const block = (parsed as { block?: unknown })?.block;
	if (typeof block !== "string" || block.length === 0) {
		throw new Error('answer had no non-empty string under "block"');
	}
	return block;
}

function querySurface(path: string, pythonPath: string): string {
	const out = execFileSync(pythonPath, [path, SURFACE_QUERY_ARG], {
		encoding: "utf8",
		timeout: SURFACE_QUERY_TIMEOUT_MS,
		maxBuffer: SURFACE_QUERY_MAX_BUFFER,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return parseSurfaceAnswer(out);
}

/**
 * The description for one helper file: queried when the file opts in, scraped when it does not. A failed
 * *query* never quietly becomes the literal -- the entry names which text it is and why, because the
 * failure mode this whole change exists to kill is a prompt that looks fine and describes something else.
 */
function describeHelper(path: string, source: string, opts: HelperOptions): string {
	if (!source.includes(SURFACE_QUERY_MARKER)) return parseDescription(source);
	const cache = opts.cache ?? surfaceCache;
	const run = opts.query ?? querySurface;
	try {
		const block = run(path, opts.pythonPath ?? resolvePythonPath(undefined));
		cache.set(path, block);
		return block;
	} catch (error) {
		const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
		const cached = cache.get(path);
		const base = cached ?? parseDescription(source);
		const from = cached ? "cached render" : "scraped literal";
		return `${base}\n(${STALE_NOTE}: ${from}; the live query failed: ${reason})`;
	}
}

/** First-seen name wins, so a project helper shadows a global one. */
function loadHelperEntries(dirs: string[], opts: HelperOptions = {}): HelperEntry[] {
	const seen = new Set<string>();
	const entries: HelperEntry[] = [];
	for (const d of dirs) {
		if (!existsSync(d)) continue;
		for (const file of readdirSync(d).sort()) {
			if (!file.endsWith(".py")) continue;
			const name = file.slice(0, -3);
			if (!/^[A-Za-z_]\w*$/.test(name)) continue;
			// --- underscore-prefixed files are neither loaded nor advertised ---
			if (name.startsWith("_")) continue;
			if (seen.has(name)) continue;
			seen.add(name);
			const path = join(d, file);
			try {
				const source = readFileSync(path, "utf8");
				const stat = statSync(path);
				entries.push({
					name,
					description: describeHelper(path, source, opts),
					path,
					bytes: stat.size,
					mtimeMs: stat.mtimeMs,
				});
			} catch {}
		}
	}
	return entries;
}

/** One helper as the model sees it: verbatim description, or a pointer when the file lacks a triple-quoted helper_description. */
export function formatHelperLine(entry: HelperEntry): string {
	return entry.description
		? entry.description.replace(/\n/g, "\n  ")
		: `${entry.name} (no helper_description — define one as a triple-quoted string in the file; inspect with print(${entry.name}.__doc__))`;
}

export function buildHelpersMap(dir?: string, opts?: HelperOptions): string[] {
	return loadHelperEntries([dir ?? DEFAULT_HELPERS_DIR], opts).map(formatHelperLine);
}

/** Project .pi/helpers first, global fallback, project shadows; honors the kernel's env overrides so the two sides can't diverge. */
export function buildHelpersMapForCwd(cwd: string, globalDir?: string, helpersDir?: string, opts?: HelperOptions): string[] {
	const dirs = helpersDir ? [helpersDir] : resolveHelperDirs(cwd, globalDir);
	return loadHelperEntries(dirs, opts).map(formatHelperLine);
}

/**
 * The entries themselves, unformatted. The repl tool needs this shape because it is the only way to
 * answer "does what the model was told match what is on disk right now?" — the formatted block cannot
 * be diffed, and a helper edited mid-run is loaded-but-unadvertised until the next agent run.
 */
export function helperEntriesForCwd(
	cwd: string,
	globalDir?: string,
	helpersDir?: string,
	opts?: HelperOptions,
): HelperEntry[] {
	const dirs = helpersDir ? [helpersDir] : resolveHelperDirs(cwd, globalDir);
	return loadHelperEntries(dirs, opts);
}

/**
 * The system-prompt block, built from entries. One home for the wording: the repl tool rebuilds this
 * same string to report drift, and a second copy of the wording would drift on its own.
 */
export function formatHelpersBlock(entries: readonly HelperEntry[]): string | undefined {
	if (entries.length === 0) return undefined;
	const lines = [
		"Preloaded helpers, use them as any loaded function or variable:",
		...entries.map((entry) => `  - ${formatHelperLine(entry).replace(/\n/g, "\n    ")}`),
		"",
		"If output begins with <repl_helpers_failed>, those helpers failed to load at boot — do not call the listed names.",
	];
	return lines.join("\n");
}

/** System-prompt block for this session's helpers; undefined when there are none. */
export function buildHelpersPromptSection(cwd: string, opts?: HelperOptions): string | undefined {
	return formatHelpersBlock(
		helperEntriesForCwd(cwd, process.env.PI_HELPERS_GLOBAL_DIR, process.env.PI_HELPERS_DIR, opts),
	);
}
