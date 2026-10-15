/** helper_description surfaces verbatim — there is no signature parsing. */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveHelperDirs } from "../engine/helpers-locate.js";

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

/** First-seen name wins, so a project helper shadows a global one. */
function loadHelperEntries(dirs: string[]): HelperEntry[] {
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
					description: parseDescription(source),
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

export function buildHelpersMap(dir?: string): string[] {
	return loadHelperEntries([dir ?? DEFAULT_HELPERS_DIR]).map(formatHelperLine);
}

/** Project .pi/helpers first, global fallback, project shadows; honors the kernel's env overrides so the two sides can't diverge. */
export function buildHelpersMapForCwd(cwd: string, globalDir?: string, helpersDir?: string): string[] {
	const dirs = helpersDir ? [helpersDir] : resolveHelperDirs(cwd, globalDir);
	return loadHelperEntries(dirs).map(formatHelperLine);
}

/**
 * The entries themselves, unformatted. The repl tool needs this shape because it is the only way to
 * answer "does what the model was told match what is on disk right now?" — the formatted block cannot
 * be diffed, and a helper edited mid-run is loaded-but-unadvertised until the next agent run.
 */
export function helperEntriesForCwd(cwd: string, globalDir?: string, helpersDir?: string): HelperEntry[] {
	const dirs = helpersDir ? [helpersDir] : resolveHelperDirs(cwd, globalDir);
	return loadHelperEntries(dirs);
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
export function buildHelpersPromptSection(cwd: string): string | undefined {
	return formatHelpersBlock(helperEntriesForCwd(cwd, process.env.PI_HELPERS_GLOBAL_DIR, process.env.PI_HELPERS_DIR));
}
