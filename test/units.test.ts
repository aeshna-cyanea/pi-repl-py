/**
 * Unit coverage for the pieces the contract suite cannot reach directly.
 *
 * engine.contract.test.ts exercises behaviour end to end, which leaves gaps:
 * protocol framing and cell layout are only observed through their effects.
 * Those are tested here in isolation, where their edge cases are reachable.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveHelperDirs } from "../src/engine/helpers-locate.js";
import type { RestoreResult } from "../src/engine/index.js";
import {
	boundResult,
	boundView,
	capLinesForContext,
	DEFAULT_MAX_OUTPUT_CHARS,
	DEFAULT_MAX_RESULT_CHARS,
	DEFAULT_MAX_RESULT_LINES,
	DEFAULT_OUTPUT_VIEW_LINES,
	EngineManager,
	MAX_OUTPUT_LINE_CHARS,
	pruneOrphanedSnapshotDirs,
	pruneSnapshotDirs,
	VIEW_LINES_ENV,
} from "../src/engine/index.js";
import { type CellResult, DEFAULT_BOOTSTRAP, KernelClient } from "../src/engine/kernel.js";
import {
	buildHelpersMap,
	buildHelpersMapForCwd,
	buildHelpersPromptSection,
	formatHelpersBlock,
	helperEntriesForCwd,
	parseSurfaceAnswer,
	SURFACE_QUERY_ARG,
	SURFACE_QUERY_MARKER,
	formatDivergenceNote,
} from "../src/extension/helpers.js";
import { buildPromptGuidelines, executeToolDescription } from "../src/extension/prompt.js";
import {
	backgroundFor,
	closeOpenSgr,
	type ExecuteRenderState,
	formatDuration,
	paintBackground,
	type RenderDeps,
	readDiffCard,
	renderExecuteBody,
	renderExecuteCell,
	renderExecuteHeader,
	statusKind,
} from "../src/extension/render-core.js";
import {
	EngineLifecycle,
	type EngineLifecycleDeps,
	formatForkToast,
	formatHelperFailuresLine,
	formatHelperToast,
	formatResetToast,
	type RevivableEngine,
} from "../src/extension/session-engine.js";
import { BUILTIN_TOOL_NAMES, droppedToolNames, parseReplToggle, prunedLoadout, replArgumentCompletions, replToast, replUsageMessage, restoredTools } from "../src/extension/repl-command.js";
import { DEFAULT_REPL_CONFIG, loadReplConfig, parseReplConfig, startEngaged } from "../src/extension/repl-config.js";
import {
	type Drift,
	diffHelpers,
	formatReload,
	formatStatus,
	isEmptyDrift,
	planRestart,
	reloadCell,
	restartBlockedNotice,
	restartMarker,
	restartToast,
	type StatusFacts,
	validateReplParams,
} from "../src/extension/repl-tool.js";
import { withSkillsBlock } from "../src/extension/skill-hook.js";
import {
	forkParentSnapshot,
	inheritForkSnapshot,
	resolveStateDir,
	sessionStateDirName,
} from "../src/extension/state-layout.js";

describe("helpers loader: description is the truth", () => {
	test("helper_description renders verbatim, including the call shape", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-repl-helpers-"));
		// First def is a private helper; only the description may define the surface.
		writeFileSync(
			join(dir, "web_search.py"),
			[
				'helper_description = """web_search(query, intent="fact") — Unified web search.',
				'Instead of: hand-rolling urllib/requests against one provider and hoping the key is set."""',
				"",
				"def _get_env(key):",
				"    return ''",
				"",
				'def web_search(query, intent="fact"):',
				"    ...",
			].join("\n"),
		);
		const bullets = buildHelpersMap(dir);
		const bullet = bullets.find((b) => b.includes("web_search"));
		expect(bullet).toBeDefined();
		expect(bullet).toContain('web_search(query, intent="fact") — Unified web search.');
		expect(bullet).toContain("Instead of: hand-rolling urllib/requests");
		// The private helper must never leak into the advertised surface.
		expect(bullet).not.toContain("_get_env");
	});

	test("a file without a description falls back to a plain-Python pointer", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-repl-helpers-"));
		writeFileSync(join(dir, "bare.py"), "def bare(x):\n    return x\n");
		const bullet = buildHelpersMap(dir).find((b) => b.includes("bare"));
		expect(bullet).toContain("bare.__doc__");
	});

	test("the helpers dir is the single source — its content is the surface", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-repl-helpers-"));
		writeFileSync(
			join(dir, "combine.py"),
			'helper_description = """combine(a, b) — takes the pair."""\ndef combine(a, b):\n    return a + b\n',
		);
		const bullets = buildHelpersMap(dir);
		// pi renders each guideline as "- <line>"; buildHelpersMap returns the bare line.
		expect(bullets.filter((b) => b.startsWith("combine("))).toHaveLength(1);
		expect(bullets.find((b) => b.startsWith("combine("))).toContain("takes the pair");
	});

	test("project helpers shadow same-named global helpers at the cwd", () => {
		const proj = mkdtempSync(join(tmpdir(), "pi-repl-proj-"));
		const global = mkdtempSync(join(tmpdir(), "pi-repl-global-"));
		mkdirSync(join(proj, ".pi", "helpers"), { recursive: true });
		writeFileSync(
			join(proj, ".pi", "helpers", "web.py"),
			'helper_description = """web(query) the PROJECT version."""\ndef web(q): return "project"\n',
		);
		writeFileSync(
			join(global, "web.py"),
			'helper_description = """web(query) the GLOBAL version."""\ndef web(q): return "global"\n',
		);
		const bullets = buildHelpersMapForCwd(proj, global);
		const web = bullets.filter((b) => b.includes("web("));
		expect(web).toHaveLength(1);
		expect(web[0]).toContain("PROJECT");
		expect(web[0]).not.toContain("GLOBAL");
	});

	test("global helpers fill in what the project does not define", () => {
		const proj = mkdtempSync(join(tmpdir(), "pi-repl-proj-"));
		const global = mkdtempSync(join(tmpdir(), "pi-repl-global-"));
		mkdirSync(join(proj, ".pi", "helpers"), { recursive: true });
		writeFileSync(
			join(proj, ".pi", "helpers", "core.py"),
			'helper_description = """core() project."""\ndef core(): return 1\n',
		);
		writeFileSync(join(global, "web.py"), 'helper_description = """web() global."""\ndef web(): return 2\n');
		const bullets = buildHelpersMapForCwd(proj, global);
		expect(bullets.some((b) => b.includes("core()"))).toBe(true);
		expect(bullets.some((b) => b.includes("web()"))).toBe(true);
	});

	test("a project without a helpers dir falls back to global only", () => {
		const proj = mkdtempSync(join(tmpdir(), "pi-repl-proj-"));
		const global = mkdtempSync(join(tmpdir(), "pi-repl-global-"));
		writeFileSync(join(global, "web.py"), 'helper_description = """web() global."""\ndef web(): return 2\n');
		const bullets = buildHelpersMapForCwd(proj, global);
		expect(bullets.some((b) => b.includes("web()"))).toBe(true);
	});

	test("private underscore helpers never appear from either tier", () => {
		const proj = mkdtempSync(join(tmpdir(), "pi-repl-proj-"));
		const global = mkdtempSync(join(tmpdir(), "pi-repl-global-"));
		mkdirSync(join(proj, ".pi", "helpers"), { recursive: true });
		writeFileSync(join(proj, ".pi", "helpers", "_priv.py"), 'helper_description = """leak"""\ndef _priv(): pass\n');
		writeFileSync(join(global, "_priv2.py"), 'helper_description = """leak2"""\ndef _priv2(): pass\n');
		const bullets = buildHelpersMapForCwd(proj, global);
		expect(bullets.some((b) => b.includes("_priv"))).toBe(false);
	});

	test("works from a deep subfolder: .pi/helpers found at the git root", () => {
		const proj = mkdtempSync(join(tmpdir(), "pi-repl-proj-"));
		const global = mkdtempSync(join(tmpdir(), "pi-repl-global-"));
		mkdirSync(join(proj, ".git"), { recursive: true });
		mkdirSync(join(proj, ".pi", "helpers"), { recursive: true });
		mkdirSync(join(proj, "src", "tools"), { recursive: true });
		writeFileSync(
			join(proj, ".pi", "helpers", "web.py"),
			'helper_description = """web() root."""\ndef web(): return 1\n',
		);
		const bullets = buildHelpersMapForCwd(join(proj, "src", "tools"), global);
		expect(bullets.some((b) => b.includes("web()"))).toBe(true);
	});

	test("resolveHelperDirs stops the ancestor walk at the git root", () => {
		const proj = mkdtempSync(join(tmpdir(), "pi-repl-proj-"));
		const global = mkdtempSync(join(tmpdir(), "pi-repl-global-"));
		mkdirSync(join(proj, ".git"), { recursive: true });
		mkdirSync(join(proj, ".pi", "helpers"), { recursive: true });
		mkdirSync(join(proj, "src", "deep"), { recursive: true });
		const dirs = resolveHelperDirs(join(proj, "src", "deep"), global);
		const nonGlobal = dirs.slice(0, -1);
		expect(nonGlobal).toEqual([join(proj, ".pi", "helpers")]);
		expect(dirs[dirs.length - 1]).toBe(global);
	});
});

describe("helper boot announcements", () => {
	function withEnv(key: string, value: string | undefined, fn: () => void) {
		const prev = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
		try {
			fn();
		} finally {
			if (prev === undefined) delete process.env[key];
			else process.env[key] = prev;
		}
	}

	test("the per-session prompt section lists the cwd's helpers, or is absent", () => {
		const proj = mkdtempSync(join(tmpdir(), "pi-repl-sec-"));
		const global = mkdtempSync(join(tmpdir(), "pi-repl-sec-global-"));
		mkdirSync(join(proj, ".git"), { recursive: true });
		mkdirSync(join(proj, ".pi", "helpers"), { recursive: true });
		writeFileSync(
			join(proj, ".pi", "helpers", "web.py"),
			'helper_description = """web(q) the PROJECT version."""\ndef web(q): return "project"\n',
		);
		withEnv("PI_HELPERS_GLOBAL_DIR", global, () => {
			const block = buildHelpersPromptSection(proj);
			expect(block).toBeDefined();
			expect(block).toContain("Preloaded helpers");
			expect(block).toContain("web(q) the PROJECT version.");
		});
		// "absent" needs *no* helpers anywhere. The global tier falls back to this machine's real
		// ~/.pi/agent/pi-repl/helpers, so an unisolated call advertises whoever's helpers happen to be
		// installed — on bagheera that is cap/show, grist, sessions, patch/peek and trimwatch, and the
		// assertion has been red there ever since the global tier grew a default. The claim under test
		// is "an empty corpus advertises nothing", not "this machine has no helpers".
		const empty = mkdtempSync(join(tmpdir(), "pi-repl-sec-empty-"));
		const emptyGlobal = mkdtempSync(join(tmpdir(), "pi-repl-sec-empty-global-"));
		withEnv("PI_HELPERS_GLOBAL_DIR", emptyGlobal, () => {
			expect(buildHelpersPromptSection(empty)).toBeUndefined();
		});
	});

	test("PI_HELPERS_DIR replaces the whole tier list in the prompt section, like the kernel", () => {
		const proj = mkdtempSync(join(tmpdir(), "pi-repl-sec-"));
		const dir = mkdtempSync(join(tmpdir(), "pi-repl-sec-dir-"));
		mkdirSync(join(proj, ".git"), { recursive: true });
		mkdirSync(join(proj, ".pi", "helpers"), { recursive: true });
		writeFileSync(join(proj, ".pi", "helpers", "project_only.py"), 'helper_description = """project"""\n');
		writeFileSync(join(dir, "override.py"), 'helper_description = """override"""\n');
		withEnv("PI_HELPERS_DIR", dir, () => {
			const block = buildHelpersPromptSection(proj);
			expect(block?.includes("override")).toBe(true);
			expect(block?.includes("project_only")).toBe(false); // project tier is replaced, not merged
		});
		withEnv("PI_HELPERS_GLOBAL_DIR", undefined, () => {});
	});

	test("PI_HELPERS_GLOBAL_DIR swaps the global tier, not the project walk", () => {
		const proj = mkdtempSync(join(tmpdir(), "pi-repl-sec-"));
		const global = mkdtempSync(join(tmpdir(), "pi-repl-sec-global-"));
		mkdirSync(join(proj, ".git"), { recursive: true });
		mkdirSync(join(proj, ".pi", "helpers"), { recursive: true });
		writeFileSync(join(proj, ".pi", "helpers", "core.py"), 'helper_description = """core"""\n');
		writeFileSync(join(global, "extra.py"), 'helper_description = """extra"""\n');
		withEnv("PI_HELPERS_GLOBAL_DIR", global, () => {
			const block = buildHelpersPromptSection(proj);
			expect(block?.includes("core")).toBe(true);
			expect(block?.includes("extra")).toBe(true);
		});
	});

	test("a file without a description points at the triple-quoted contract", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-repl-helpers-"));
		writeFileSync(join(dir, "bare.py"), "def bare(x):\n    return x\n");
		const bullet = buildHelpersMap(dir).find((b) => b.includes("bare"));
		expect(bullet).toContain("triple-quoted");
		expect(bullet).toContain("bare.__doc__");
	});

	test("a helper that carries the marker is QUERIED, not scraped", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-repl-surface-"));
		writeFileSync(
			join(dir, "selfrender.py"),
			`${SURFACE_QUERY_MARKER}\nhelper_description = """the scraped literal."""\n`,
		);
		const calls: string[] = [];
		const entries = helperEntriesForCwd(dir, undefined, dir, {
			query: (path) => {
				calls.push(path);
				return "the queried block";
			},
		});
		expect(entries.map((e) => e.description)).toEqual(["the queried block"]);
		expect(calls).toEqual([join(dir, "selfrender.py")]);
		// non-vacuity: the literal is still in the file, so "not scraped" is a real claim
		expect(readFileSync(join(dir, "selfrender.py"), "utf8")).toContain("the scraped literal");
	});

	test("a helper without the marker never spawns a query", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-repl-surface-off-"));
		writeFileSync(join(dir, "plain.py"), 'helper_description = """plain literal."""\n');
		let calls = 0;
		const entries = helperEntriesForCwd(dir, undefined, dir, {
			query: () => {
				calls += 1;
				return "should never be used";
			},
		});
		expect(entries.map((e) => e.description)).toEqual(["plain literal."]);
		expect(calls).toBe(0);
	});

	test("a failed query degrades to a VISIBLE cache, never to a silent source", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-repl-surface-fail-"));
		writeFileSync(
			join(dir, "selfrender.py"),
			`${SURFACE_QUERY_MARKER}\nhelper_description = """the scraped literal."""\n`,
		);
		const cache = new Map<string, string>();
		const opts = {
			cache,
			query: (() => {
				let n = 0;
				return () => {
					n += 1;
					if (n === 1) return "the good block";
					throw new Error("exit code 2\ntraceback noise");
				};
			})(),
		};
		// first run succeeds and seeds the cache
		expect(helperEntriesForCwd(dir, undefined, dir, opts)[0].description).toBe("the good block");
		// second run fails: the cached text survives, and the block says it is a cache and why
		const stale = helperEntriesForCwd(dir, undefined, dir, opts)[0].description;
		expect(stale).toContain("the good block");
		expect(stale).toContain("STALE");
		expect(stale).toContain("cached render");
		expect(stale).toContain("exit code 2"); // the reason, first line only
		expect(stale).not.toContain("traceback noise");
		// stable bytes: a query that fails every run must not change the prompt's bytes every run
		expect(helperEntriesForCwd(dir, undefined, dir, opts)[0].description).toBe(stale);
		// the failed run must not overwrite the good cache
		expect(cache.get(join(dir, "selfrender.py"))).toBe("the good block");
	});

	test("a failed query with no cache falls back to the literal, and says that too", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-repl-surface-nocache-"));
		writeFileSync(join(dir, "selfrender.py"), `${SURFACE_QUERY_MARKER}\nhelper_description = """the literal."""\n`);
		const e = helperEntriesForCwd(dir, undefined, dir, {
			cache: new Map(),
			query: () => {
				throw new Error("python not found");
			},
		})[0];
		expect(e.description).toContain("the literal.");
		expect(e.description).toContain("STALE");
		expect(e.description).toContain("scraped literal");
		expect(e.description).toContain("python not found");
	});

	// --- the third way down: a self-rendering helper has NO literal to fall back to ---------------------
	// Key 221 part 3 deletes the generated literal from pan.py. Under the old two-way fallback this case
	// returned "" plus "(STALE: scraped literal ...)" — a note advertising a copy that does not exist,
	// which is the same lie step 4 exists to kill, wearing a hat. So this test's job is to refuse it.
	test("a failed query with no cache AND no literal says there is no block, and never claims a copy", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-repl-surface-noblock-"));
		// a self-rendering helper as it exists after part 3: the marker, and no helper_description at all
		writeFileSync(join(dir, "selfrender.py"), `${SURFACE_QUERY_MARKER}\ndef selfrender(): ...\n`);
		const cache = new Map<string, string>();
		const opts = {
			cache,
			pythonPath: "/venv/bin/python3",
			query: () => {
				throw new Error("ModuleNotFoundError: no module named panlib");
			},
		};
		const e = helperEntriesForCwd(dir, undefined, dir, opts)[0];
		// non-vacuity: there is nothing in this file to scrape
		expect(readFileSync(join(dir, "selfrender.py"), "utf8")).not.toContain("helper_description");
		expect(e.description).not.toContain("scraped literal");
		expect(e.description).not.toContain("cached render");
		// an absence is not a stale copy, so it must not borrow the STALE label
		expect(e.description).toContain("NO BLOCK");
		expect(e.description).toContain("ModuleNotFoundError");
		// the claim that decides what I do next: the DESCRIPTION path failed, the binding may be fine
		expect(e.description).toContain("may still be bound");
		expect(e.description).toContain("not the binding");
		// and the repair is copy-pasteable, naming the SAME interpreter the kernel got
		expect(e.description).toContain("repair: /venv/bin/python3 ");
		expect(e.description).toContain(join(dir, "selfrender.py"));
		expect(e.description).toContain(`${SURFACE_QUERY_ARG})`);
		// stable bytes, and a failed run must not seed the cache with its own note
		expect(helperEntriesForCwd(dir, undefined, dir, opts)[0].description).toBe(e.description);
		expect(cache.size).toBe(0);
		// the note is one line: it sits in the always-loaded block, and a report-shaped note is one I skim
		expect(e.description).not.toContain("\n");
		// the note carries the helper's name -- the description's first line normally names the bullet,
		// and here there is no first line, so without this the failure is a hole with no owner
		const block = formatHelpersBlock([e]) ?? "";
		expect(block).toContain("NO BLOCK for selfrender");
	});

	// --- the divergence note: what the live kernel binds, against the block being advertised -----------
	test("a kernel that agrees with the block pays nothing, and so does the absence of a kernel", () => {
		expect(formatDivergenceNote({ divergences: [] })).toBe("");
		expect(formatDivergenceNote(null)).toBe("");
		expect(formatDivergenceNote(undefined)).toBe("");
	});

	test("a fault is never read as clean: an error answer names the fault", () => {
		const note = formatDivergenceNote({ error: "ModuleNotFoundError: no module named panlib" });
		expect(note).toContain("STALE BINDINGS");
		expect(note).toContain("could not answer");
		expect(note).toContain("ModuleNotFoundError");
	});

	test("the note is ONE line, names the repair, and caps how many clauses it drowns me in", () => {
		const note = formatDivergenceNote({
			divergences: [
				{ kind: "generation", count: 34, names: ["patch", "cap"] },
				{ kind: "class", name: "git" },
				{ kind: "signature", name: "patch" },
				{ kind: "unbound", name: "sessions_index" },
			],
		});
		expect(note).not.toContain("\n");
		expect(note).toContain("34 flat names are a pre-reload generation");
		expect(note).toContain("git's class is stale under it");
		expect(note).toContain("repair: helpers_reload() / rebind the name");
		expect(note).toContain("(+2 more)");
		// Priced, not vibes: this is an always-loaded line in the system prompt.
		expect(note.length).toBeLessThan(200);
	});

	test("parseSurfaceAnswer: the contract is one non-empty string under block", () => {
		expect(parseSurfaceAnswer('{"block":"hi"}')).toBe("hi");
		expect(() => parseSurfaceAnswer("not json")).toThrow("not JSON");
		expect(() => parseSurfaceAnswer('{"block":""}')).toThrow("non-empty");
		expect(() => parseSurfaceAnswer('{"names":41}')).toThrow("non-empty");
	});

	test("formatHelperFailuresLine: silent when good, one line when broken", () => {
		expect(formatHelperFailuresLine(null)).toBeUndefined();
		expect(
			formatHelperFailuresLine([
				{ name: "web", ok: true },
				{ name: "core", ok: true },
			]),
		).toBeUndefined();
		const line = formatHelperFailuresLine([
			{ name: "web", ok: true },
			{ name: "scraper", ok: false, error: "NameError: x is not defined" },
		]);
		expect(line).toContain("<repl_helpers_failed:");
		expect(line).toContain("scraper (NameError: x is not defined)");
		expect(line).not.toContain("web");
	});

	test("formatHelperToast: names the loaded set and appends failures", () => {
		const good = formatHelperToast([
			{ name: "web", ok: true },
			{ name: "core", ok: true },
		]);
		expect(good).toBe("repl helpers loaded: web, core");
		const mixed = formatHelperToast([
			{ name: "web", ok: true },
			{ name: "scraper", ok: false, error: "SyntaxError: invalid syntax" },
		]);
		expect(mixed).toContain("web");
		expect(mixed).toContain("failed: scraper (SyntaxError: invalid syntax)");
		const none = formatHelperToast([{ name: "scraper", ok: false, error: "boom" }]);
		expect(none).toBe("repl no helpers loaded · failed: scraper (boom)");
	});

	test("static guidelines carry no roster and no helper marker; the per-session block carries both", () => {
		const bullets = buildPromptGuidelines();
		expect(bullets.some((b) => b.includes("<repl_engine_reset>"))).toBe(true);
		expect(bullets.some((b) => b.includes("Preloaded helpers"))).toBe(false); // the roster moves to the system prompt
		expect(bullets.some((b) => b.includes("<repl_helpers_failed>"))).toBe(false); // ...and so does its marker note

		const proj = mkdtempSync(join(tmpdir(), "pi-repl-sec-"));
		const global = mkdtempSync(join(tmpdir(), "pi-repl-sec-global-"));
		mkdirSync(join(proj, ".pi", "helpers"), { recursive: true });
		writeFileSync(join(proj, ".pi", "helpers", "web.py"), 'helper_description = """web() the block."""\n');
		const block = buildHelpersPromptSection(proj);
		expect(block?.includes("<repl_helpers_failed>")).toBe(true);
	});
});

const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (text: string) => text.replace(ANSI, "");

function testDeps(overrides: Partial<RenderDeps> = {}): RenderDeps {
	return {
		fg: (_color, text) => `\x1b[31m${text}\x1b[0m`,
		getBgAnsi: () => "\x1b[44m",
		highlight: (code) => code.split("\n").map((line) => `\x1b[32m${line}\x1b[0m`),
		keyHint: (expanded) => (expanded ? "ctrl+o to collapse" : "ctrl+o to expand"),
		visibleWidth: (text) => stripAnsi(text).length,
		truncateToWidth: (text, width, ellipsis = "") => {
			// ANSI-aware like the real primitive: keep escapes, count only visible
			// characters, and append the ellipsis when content was dropped.
			const plainLength = stripAnsi(text).length;
			if (plainLength <= width) return text;
			const budget = Math.max(0, width - stripAnsi(ellipsis).length);
			let visible = 0;
			let out = "";
			let index = 0;
			while (index < text.length) {
				const match = text.slice(index).match(/^\x1b\[[0-9;]*m/);
				if (match) {
					out += match[0];
					index += match[0].length;
					continue;
				}
				if (visible >= budget) break;
				out += text[index];
				visible += 1;
				index += 1;
			}
			return out + ellipsis;
		},
		wrapTextWithAnsi: (text, width) => {
			const plain = stripAnsi(text);
			if (plain.length <= width) return [text];
			const chunks: string[] = [];
			for (let i = 0; i < plain.length; i += width) chunks.push(plain.slice(i, i + width));
			return chunks;
		},
		now: () => 0,
		...overrides,
	};
}

function makeState(overrides: Partial<ExecuteRenderState> = {}): ExecuteRenderState {
	return {
		code: "const a = 1;\na + 1",
		details: { status: "ok", durationMs: 120, stdout: "hello\n", result: "2" },
		isPartial: false,
		isError: false,
		expanded: false,
		executionStarted: true,
		hasResult: true,
		...overrides,
	};
}
describe("render-core: helpers", () => {
	test("closeOpenSgr resets colors left open by wrapping", () => {
		expect(closeOpenSgr("\x1b[31mred")).toBe("\x1b[31mred\x1b[0m");
		expect(closeOpenSgr("\x1b[38;5;10mgreen")).toBe("\x1b[38;5;10mgreen\x1b[0m");
		expect(closeOpenSgr("\x1b[31mred\x1b[0m")).toBe("\x1b[31mred\x1b[0m");
		expect(closeOpenSgr("plain")).toBe("plain");
	});

	test("a Python cell containing a Bun.$ literal is still syntax-highlighted", () => {
		const deps = testDeps();
		const state = makeState({ expanded: true, code: 'print("Bun.\\$ is not special here")' });
		const rendered = renderExecuteCell(state, 80, deps);
		// The mock highlighter wraps every line in green — not accent, and the
		// whole cell must not be downgraded to a single flat color.
		expect(rendered.join("\n")).toContain("\x1b[32m");
	});

	test("formatDuration switches units at one second", () => {
		expect(formatDuration(undefined)).toBeUndefined();
		expect(formatDuration(120)).toBe("120ms");
		expect(formatDuration(999)).toBe("999ms");
		expect(formatDuration(1500)).toBe("1.5s");
	});

	test("statusKind and backgroundFor agree on every state", () => {
		expect(statusKind(makeState())).toBe("done");
		expect(statusKind(makeState({ isError: true }))).toBe("error");
		expect(statusKind(makeState({ details: { status: "aborted" } }))).toBe("aborted");
		expect(statusKind(makeState({ details: undefined, hasResult: false, isPartial: true }))).toBe("running");
		expect(statusKind(makeState({ details: undefined, hasResult: false, executionStarted: false }))).toBe("queued");

		expect(backgroundFor("done")).toBe("toolSuccessBg");
		expect(backgroundFor("error")).toBe("toolErrorBg");
		expect(backgroundFor("aborted")).toBe("toolErrorBg");
		expect(backgroundFor("running")).toBe("toolPendingBg");
		expect(backgroundFor("queued")).toBe("toolPendingBg");
	});
});

describe("render-core: layout", () => {
	test("collapsed renders exactly one row; expanded renders code and output", () => {
		const deps = testDeps();
		const collapsed = renderExecuteCell(makeState(), 80, deps);
		expect(collapsed).toHaveLength(1);

		const expanded = renderExecuteCell(makeState({ expanded: true }), 80, deps);
		expect(expanded.length).toBeGreaterThan(collapsed.length);
		const joined = stripAnsi(expanded.join("\n"));
		expect(joined).toContain("const a = 1;");
		expect(joined).toContain("hello");
	});

	test("header and body split reconstructs the full cell", () => {
		const deps = testDeps();
		const state = makeState({ expanded: true });
		const full = renderExecuteCell(state, 80, deps);
		const header = renderExecuteHeader(state, 80, deps);
		const body = renderExecuteBody(state, 80, deps);
		expect(header).toHaveLength(1);
		expect(stripAnsi(header[0])).toBe(stripAnsi(full[0]));
		expect([...header, ...body]).toHaveLength(full.length);
		expect(stripAnsi([...header, ...body].join("\n"))).toBe(stripAnsi(full.join("\n")));

		const collapsedBody = renderExecuteBody(makeState({ expanded: false }), 80, deps);
		expect(collapsedBody).toHaveLength(0);
	});

	test("every rendered line fits the pane width, at any width", () => {
		const deps = testDeps();
		const state = makeState({
			expanded: true,
			code: "const configurationSnapshotForRenderWidthProbe = { alpha: 1, beta: 2, gamma: 3, delta: 4, epsilon: 5 };",
			details: { status: "ok", durationMs: 90, stdout: "x".repeat(400), result: "y".repeat(200) },
		});
		for (const width of [20, 40, 80, 120, 200]) {
			for (const line of renderExecuteCell(state, width, deps)) {
				expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
			}
		}
	});

	test("a long first line keeps the trailing metadata visible", () => {
		const deps = testDeps();
		const state = makeState({
			code: "const configurationSnapshotForRenderWidthProbe = { alpha: 1, beta: 2, gamma: 3, delta: 4, epsilon: 5 };",
		});
		// The preview absorbs truncation so the metadata suffix survives at any
		// width that can hold it; the preview is elided instead of the counts,
		// duration, and expand hint.
		for (const width of [80, 100, 140]) {
			const row = stripAnsi(renderExecuteCell(state, width, deps)[0]);
			expect(row).toContain("ctrl+o to expand");
			expect(row).toContain("120ms");
			expect(row).toContain("↑ 1");
			expect(row).toContain("const co");
			expect(row).toContain("…");
			expect(row.length).toBeLessThanOrEqual(width);
		}
	});

	test("status glyph and background track the cell status", () => {
		const deps = testDeps();
		expect(stripAnsi(renderExecuteCell(makeState(), 80, deps)[0])).toContain("✓");
		expect(stripAnsi(renderExecuteCell(makeState({ isError: true }), 80, deps)[0])).toContain("✗");
		const queued = makeState({ details: undefined, hasResult: false, executionStarted: false });
		expect(stripAnsi(renderExecuteCell(queued, 80, deps)[0])).toContain("◇");
	});

	test("line counts and duration appear in the collapsed row", () => {
		const deps = testDeps();
		const row = stripAnsi(renderExecuteCell(makeState(), 200, deps)[0]);
		expect(row).toContain("↑ 2");
		expect(row).toContain("lines");
		expect(row).toContain("120ms");
		expect(row).toContain("ctrl+o to expand");
	});

	test("error name and stack are surfaced", () => {
		const deps = testDeps();
		const state = makeState({
			expanded: true,
			isError: true,
			details: { status: "error", errorName: "RangeError", errorStack: ["RangeError: demo explosion", "  at cell"] },
		});
		const rendered = stripAnsi(renderExecuteCell(state, 120, deps).join("\n"));
		expect(rendered).toContain("RangeError");
		expect(rendered).toContain("demo explosion");
	});

	test("a pure-traceback error cell does not claim it had no output", () => {
		const deps = testDeps();
		const state = makeState({
			expanded: true,
			isError: true,
			details: {
				status: "error",
				errorName: "ZeroDivisionError",
				errorStack: ["Traceback (most recent call last):", "ZeroDivisionError: division by zero"],
			},
		});
		const plain = stripAnsi(renderExecuteCell(state, 80, deps).join("\n"));
		expect(plain).toContain("traceback:");
		expect(plain).toContain("ZeroDivisionError");
		expect(plain).not.toContain("no output");
	});

	test("the expanded panel always ends with a cushion row, never text on the edge", () => {
		const deps = testDeps();
		const cases: Array<{ name: string; details: any; expectText: string }> = [
			// traceback renders bare (no trailing newline) and must still get the cushion
			{
				name: "traceback",
				details: { status: "error", errorName: "E", errorStack: ["Traceback (most recent call last):", "E: boom"] },
				expectText: "E: boom",
			},
			// the placeholder renders bare and must also sit above the edge
			{ name: "placeholder", details: { status: "ok", durationMs: 5 }, expectText: "no output" },
			// a result repr carries no trailing newline either
			{ name: "result", details: { status: "ok", result: "'res'" }, expectText: "'res'" },
		];
		for (const { name, details, expectText } of cases) {
			const lines = renderExecuteBody(makeState({ expanded: true, details }), 80, deps);
			const last = stripAnsi(lines[lines.length - 1]).trim();
			const above = stripAnsi(lines[lines.length - 2]).trim();
			expect(last, `${name}: bottom row must be blank`).toBe("");
			expect(above, `${name}: content sits above the cushion`).toContain(expectText);
		}
		// blob paths already ended blank via the stream's trailing newline; the cushion must
		// recognize that row and not stack a second one
		const streamed = renderExecuteBody(
			makeState({ expanded: true, details: { status: "ok", stdout: "hi\n" } }),
			80,
			deps,
		);
		expect(stripAnsi(streamed[streamed.length - 1]).trim()).toBe("");
		expect(stripAnsi(streamed[streamed.length - 2]).trim()).toBe("hi");
	});

	test("empty output says so; a running cell says it is waiting", () => {
		const deps = testDeps();
		const done = makeState({ expanded: true, details: { status: "ok", durationMs: 5 } });
		expect(stripAnsi(renderExecuteCell(done, 80, deps).join("\n"))).toContain("no output");
		const running = makeState({ expanded: true, details: undefined, hasResult: false, isPartial: true });
		expect(stripAnsi(renderExecuteCell(running, 80, deps).join("\n"))).toContain("waiting for output");
	});

	test("output ANSI escapes are stripped before section coloring is applied", () => {
		const deps = testDeps();
		const state = makeState({
			expanded: true,
			details: {
				status: "ok",
				stdout: "\x1b[31mred\x1b[0m\n\x07beep\t",
				stderr: "\r\x00\x1b[1m",
			},
		});
		const raw = renderExecuteCell(state, 80, deps).join("\n");
		const plain = stripAnsi(raw);
		// User ANSI is stripped; our section color is applied afterward.
		expect(plain).toContain("red");
		expect(plain).toContain("beep");
		expect(plain).not.toContain("\x07");
		expect(plain).toContain("    "); // tab expanded
		expect(plain).toContain("stdout:");
		expect(plain).toContain("stderr:");
		expect(raw).toContain("␍"); // carriage return escaped as a control picture
		// color SGR must be stripped, not re-escaped into visible ␣[31m noise
		expect(raw).not.toContain("␛[31m");
		expect(raw).not.toContain("␛[0m");
	});

	test("stdout/stderr/result are labeled and color-coded", () => {
		const deps = testDeps();
		const state = makeState({
			expanded: true,
			details: {
				status: "ok",
				stdout: "out",
				stderr: "err",
				result: "res",
			},
		});
		const plain = stripAnsi(renderExecuteCell(state, 80, deps).join("\n"));
		expect(plain).toContain("stdout:");
		expect(plain).toContain("stderr:");
		expect(plain).toContain("result:");
		expect(plain).toContain("out");
		expect(plain).toContain("err");
		expect(plain).toContain("res");
	});

	test("expanded output renders in full, bounded only by the data cap", () => {
		const deps = testDeps();
		const state = makeState({
			expanded: true,
			details: { status: "ok", stdout: Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n") },
		});
		const plain = stripAnsi(renderExecuteCell(state, 80, deps).join("\n"));
		expect(plain).toContain("line 0");
		expect(plain).toContain("line 119");
		// Every line is present; nothing is hidden behind a marker.
		expect(plain).not.toContain("hidden");
		expect(plain.match(/line \d+/g)?.length).toBe(120);
	});

	test("appended streaming output re-wraps incrementally with identical results", () => {
		const deps = testDeps();
		const tail = "b".repeat(200);
		const big = `alpha\n${tail}\ngamma\ndelta`;
		const state = makeState({
			expanded: true,
			details: undefined,
			hasResult: false,
			isPartial: true,
			contentText: `alpha\n${tail}`,
		});
		const first = renderExecuteBody(state, 80, deps);
		// Append the next batch on the same (persistent) state object.
		state.contentText = big;
		const second = renderExecuteBody(state, 80, deps);
		// Same text on a fresh state must wrap identically.
		const fresh = makeState({
			expanded: true,
			details: undefined,
			hasResult: false,
			isPartial: true,
			contentText: big,
		});
		const full = renderExecuteBody(fresh, 80, deps);
		expect(second.length).toBeGreaterThan(first.length);
		expect(second.join("\n")).toBe(full.join("\n"));
		// Rendering the same text again is a cache hit and stays stable.
		expect(renderExecuteBody(state, 80, deps).join("\n")).toBe(full.join("\n"));
		// A mid-stream rewrite (not an append) falls back to a fresh full wrap.
		state.contentText = "zzz";
		const rewritten = renderExecuteBody(state, 80, deps);
		expect(stripAnsi(rewritten.join("\n"))).toContain("zzz");
		expect(rewritten.join("\n")).toBe(
			renderExecuteBody(
				makeState({ expanded: true, details: undefined, hasResult: false, isPartial: true, contentText: "zzz" }),
				80,
				deps,
			).join("\n"),
		);
	});

	test("settled stdout reuses the streaming wrap when the text is identical", () => {
		const deps = testDeps();
		const body = "x".repeat(60) + "\n" + "y".repeat(60);
		const state = makeState({
			code: "",
			expanded: true,
			details: undefined,
			hasResult: false,
			isPartial: true,
			contentText: body,
		});
		const streamed = renderExecuteBody(state, 80, deps).join("\n");
		// Settle: the engine delivers the same bytes as details.stdout.
		state.details = { status: "ok", durationMs: 5, stdout: body };
		state.isPartial = false;
		state.version = 1;
		const settled = renderExecuteBody(state, 80, deps).join("\n");
		expect(settled).toContain("stdout:");
		expect(stripAnsi(settled)).toContain("x".repeat(30));
		// The wrapped rows are the cached ones (label line aside): no re-wrap hitch at settle.
		expect(settled.slice(settled.indexOf("\n") + 1)).toBe(streamed);
	});

	test("background is re-armed after inner SGR resets so it spans the row", () => {
		const deps = testDeps();
		const painted = paintBackground("\x1b[31mred\x1b[0mplain", 20, "done", deps);
		expect(painted.startsWith("\x1b[44m")).toBe(true);
		expect(painted.endsWith("\x1b[0m")).toBe(true);
		// Every reset inside the row must be followed by the background again.
		const resets = painted.split("\x1b[0m");
		for (const segment of resets.slice(1, -1)) expect(segment.startsWith("\x1b[44m")).toBe(true);
		expect(stripAnsi(painted)).toHaveLength(20);
	});
});

describe("per-line output cap", () => {
	test("short lines pass through unchanged", () => {
		const { text, trimmed } = capLinesForContext("a\nbb\nccc\n");
		expect(trimmed).toBe(false);
		expect(text).toBe("a\nbb\nccc\n");
	});

	test("a single oversized line is trimmed to the per-line cap", () => {
		const { text, trimmed } = capLinesForContext(`${"x".repeat(10_000_000)}\n`);
		expect(trimmed).toBe(true);
		expect(text.split("\n")[0].length).toBe(MAX_OUTPUT_LINE_CHARS);
		expect(text.split("\n")[0]).not.toContain("xyz");
	});

	test("only the offending line is trimmed, neighbors are untouched", () => {
		const { text, trimmed } = capLinesForContext(`ok\n${"y".repeat(10_000)}\nfine`);
		expect(trimmed).toBe(true);
		const [a, b, c] = text.split("\n");
		expect(a).toBe("ok");
		expect(b.length).toBe(MAX_OUTPUT_LINE_CHARS);
		expect(c).toBe("fine");
	});
});

describe("cell result bound", () => {
	const many = (n: number) => Array.from({ length: n }, (_, i) => `line ${i} of a deliberately long value`).join("\n");

	test("a result inside both budgets passes through untouched", () => {
		const r = boundResult("one\ntwo\nthree");
		expect(r.trimmed).toBe(false);
		expect(r.text).toBe("one\ntwo\nthree");
		expect(r.lines).toBe(3);
	});

	test("a result at exactly the line budget is NOT trimmed", () => {
		const text = Array.from({ length: DEFAULT_MAX_RESULT_LINES }, (_, i) => `line ${i}`).join("\n");
		const r = boundResult(text);
		expect(r.trimmed).toBe(false);
		expect(r.text).toBe(text);
	});

	test("a long multi-line result is cut to the line budget, marker included", () => {
		const text = many(300);
		const r = boundResult(text);
		expect(r.trimmed).toBe(true);
		expect(r.text.split("\n").length).toBe(DEFAULT_MAX_RESULT_LINES + 1);
		expect(r.lines).toBe(300);
		expect(r.shownLines).toBe(DEFAULT_MAX_RESULT_LINES);
	});

	test("the marker names the TRUE totals, so a bounded echo cannot understate what it cut", () => {
		const text = many(300);
		const r = boundResult(text);
		expect(r.text).toContain(`showed ${DEFAULT_MAX_RESULT_LINES} of 300 lines`);
		expect(r.text).toContain(`${text.length} chars total`);
	});

	test("one giant line is cut by the char budget, and the marker says so", () => {
		const text = "x".repeat(200_000);
		const r = boundResult(text);
		expect(r.trimmed).toBe(true);
		expect(r.lines).toBe(1);
		expect(r.text.length).toBeLessThanOrEqual(DEFAULT_MAX_RESULT_CHARS + 250);
		expect(r.text).toContain(`cut at ${DEFAULT_MAX_RESULT_CHARS} chars`);
	});

	test("the marker names the repair: the kernel keeps nothing unbound", () => {
		const r = boundResult("a\n".repeat(500));
		expect(r.text).toContain("assign it");
	});
});

describe("stream view bound", () => {
	// The rule this pins: a bounded view is only honest when a pointer at the whole thing exists.
	const many = (n: number) => Array.from({ length: n }, (_, i) => `line ${i} of a deliberately long value`).join("\n");

	test("a stream inside the view budget passes through and claims no copy", () => {
		const r = boundView("one\ntwo\nthree", 120, "/tmp/cell-000007.txt");
		expect(r.trimmed).toBe(false);
		expect(r.text).toBe("one\ntwo\nthree");
		expect(r.text).not.toContain("full text:");
	});

	test("over the budget the marker names the copy, and the hint omits n because peek has a default", () => {
		const r = boundView(many(400), 120, "/tmp/pan-out/stem/cell-000007.txt");
		expect(r.trimmed).toBe(true);
		expect(r.text.split("\n").length).toBe(122); // 120 lines + marker + peek hint
		expect(r.text).toContain("full text: /tmp/pan-out/stem/cell-000007.txt]");
		expect(r.text).toContain("peek('/tmp/pan-out/stem/cell-000007.txt', start=121)");
		expect(r.text).not.toContain("start=121, n=");
	});

	test("the totals come from the tee, not from the head that survived", () => {
		// a truncated head arriving from a mismatched bridge must not make the marker understate the cell
		const r = boundView(many(150), 120, "/x/cell-000009.txt", { lines: 900, bytes: 123456 });
		expect(r.text).toContain("900 lines, 123456 chars");
		expect(r.lines).toBe(900);
	});

	test("with no capture the marker refuses to invent a path", () => {
		const r = boundView(many(400), 120);
		expect(r.trimmed).toBe(true);
		expect(r.text).toContain("PI_REPL_CAPTURE_DIR is unset");
		expect(r.text).not.toContain("full text:");
	});

	test("the char bound keeps one giant line inside the channel budget", () => {
		const r = boundView(`${"x".repeat(200_000)}\n${many(400)}`, 120, "/x/cell-000011.txt", undefined, DEFAULT_MAX_OUTPUT_CHARS);
		expect(r.text.length).toBeLessThanOrEqual(DEFAULT_MAX_OUTPUT_CHARS);
		expect(r.cutByChars).toBe(true);
	});

	test("the default view budget is the measured one, and changing it is a decision", () => {
		// 120 is not a taste: 25,413 tool results measured p90 62 / p95 92 / p99 245 lines. A test that
		// passes an explicit budget cannot catch the default drifting, so this one does not.
		expect(DEFAULT_OUTPUT_VIEW_LINES).toBe(120);
		const r = boundView(many(400), undefined, "/x/cell-000013.txt");
		expect(r.shownLines).toBe(DEFAULT_OUTPUT_VIEW_LINES);
		expect(r.trimmed).toBe(true);
	});

	test("when the copy itself hit its byte bound, the marker says the totals are not the cell's", () => {
		// the tee caps one cell so a runaway loop cannot own the tier; the numbers it reports are then what
		// it HELD, and a marker that states them as the cell's total is the lie this channel exists to avoid
		const r = boundView(many(400), 120, "/x/cell-000014.txt", { lines: 400, bytes: 2048, cut: true });
		expect(r.text).toContain("full text: /x/cell-000014.txt]");
		expect(r.text).toContain("note: the copy hit its own byte bound");
		const clean = boundView(many(400), 120, "/x/cell-000015.txt", { lines: 400, bytes: 999_999 });
		expect(clean.text).not.toContain("byte bound");
	});
});

describe("pi-repl.json config", () => {
	// the value goes to the bridge as PI_REPL_CAPTURE_DIR and the bridge mkdir's it verbatim, so an
	// unexpanded "~/pan-out" creates a directory literally named "~" and reads exactly like a tee that
	// works. panlib applies the same rule on its half of the boundary (`panout._dir`), same reason.
	test("a captureDir written with a leading ~ resolves to home, never to a directory named ~", () => {
		const home = homedir();
		const none = () => {};
		expect(parseReplConfig({ captureDir: "~/pan-out" }, none).captureDir).toBe(join(home, "pan-out"));
		expect(parseReplConfig({ captureDir: "~" }, none).captureDir).toBe(home);
		expect(parseReplConfig({ captureDir: "/tmp/pan-out" }, none).captureDir).toBe("/tmp/pan-out");
		expect(parseReplConfig({ captureDir: "a/~/b" }, none).captureDir).toBe("a/~/b");
	});

	// Pinned from the other side on purpose. For a day the fork handed the kernel PI_REPL_VIEW_LINES while
	// panlib's `panout.VIEW_ENV` was PAN_VIEW_LINES: each repo read its own name, saw a plausible default,
	// and both suites stayed green while the page size was 60 in one layer and 120 in the other. A name
	// that crosses a process boundary cannot be pinned from inside either repo alone.
	test("the view knob crosses the kernel boundary as one constant, and panlib reads that same name", () => {
		expect(VIEW_LINES_ENV).toBe("PAN_VIEW_LINES");
		const src = readFileSync(join(import.meta.dir, "..", "src", "engine", "index.ts"), "utf8");
		expect(src).toContain("process.env[VIEW_LINES_ENV]"); // the constant is used, not just exported
		// The pin is on the *read shape*, not on the string: the docstring above that constant tells the story
		// of the drift, and prose is not a read. A whole-file negative assertion is defeated by its own comment.
		expect(src).not.toMatch(/(?:process\.env|env\?\.)\.PI_REPL_VIEW_LINES\b/);
	});

	const panlibPanout = join(homedir(), ".pi", "pan", "lib", "panlib", "output", "panout.py");
	(existsSync(panlibPanout) ? test : test.skip)(
		"panlib declares the env name the fork hands over, not a look-alike of it",
		() => {
			const m = /\bVIEW_ENV\s*=\s*"([A-Z0-9_]+)"/.exec(readFileSync(panlibPanout, "utf8"));
			expect(m).not.toBeNull();
			expect(m![1]).toBe(VIEW_LINES_ENV);
		},
	);

	// cellMaxMb is the one authored number behind PI_REPL_CAPTURE_MAX_BYTES; bridge.py's own 32 MiB is a
	// default for a spawn with no config (a probe, a test), not a second policy for the same tier.
	test("cellMaxMb bounds one cell's copy, and junk is ignored rather than obeyed", () => {
		const warns: string[] = [];
		expect(parseReplConfig({ cellMaxMb: 8 }, () => {}).cellMaxMb).toBe(8);
		expect(parseReplConfig({ cellMaxMb: 0 }, (m) => warns.push(m)).cellMaxMb).toBe(32);
		expect(parseReplConfig({ cellMaxMb: "lots" }, (m) => warns.push(m)).cellMaxMb).toBe(32);
		expect(warns.length).toBe(2);
		expect(DEFAULT_REPL_CONFIG.cellMaxMb).toBe(32);
		// Nothing in this repo imports the extension entry (grep: no test reads ../index), so the wiring line
		// inside create() cannot be executed here. It is pinned textually instead: a key that is parsed but
		// never handed over is the "installed fix that never runs" shape, and a deliberate edit to this line
		// should be exactly that — deliberate.
		const ext = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf8");
		expect(ext).toContain("PI_REPL_CAPTURE_MAX_BYTES: String(config.cellMaxMb * 1024 * 1024)");
		expect(ext).toContain("[VIEW_LINES_ENV]: String(config.viewLines)");
		expect(ext).toContain("PI_REPL_CAPTURE_DIR: config.captureDir");
	});

	test("captureDir and viewLines are read, and junk is reported rather than obeyed", () => {
		const warns: string[] = [];
		const cfg = parseReplConfig({ captureDir: "/tmp/pan-out", viewLines: 60 }, (m) => warns.push(m));
		expect(cfg.captureDir).toBe("/tmp/pan-out");
		expect(cfg.viewLines).toBe(60);
		const bad = parseReplConfig({ captureDir: 7, viewLines: "many" }, (m) => warns.push(m));
		expect(bad.captureDir).toBe("");
		expect(bad.viewLines).toBe(120);
		expect(warns.length).toBe(2);
	});

	test("an unset captureDir means the tee is off, which is the default", () => {
		const cfg = parseReplConfig({}, () => {});
		expect(cfg.captureDir).toBe("");
		expect(DEFAULT_REPL_CONFIG.captureDir).toBe("");
	});
});

describe("/repl toggle", () => {
	test("parses on/off, case-insensitive, whitespace-tolerant", () => {
		expect(parseReplToggle("on")).toBe("on");
		expect(parseReplToggle(" OFF ")).toBe("off");
		expect(parseReplToggle("")).toBeUndefined();
		expect(parseReplToggle("maybe")).toBeUndefined();
		// a bare toggle is not a subcommand: the usage case
		expect(parseReplToggle("true")).toBeUndefined();
	});

	test("completes on/off by prefix; null falls through to default completion", () => {
		expect(replArgumentCompletions("")!.map((c) => c.value)).toEqual(["on", "off"]);
		expect(replArgumentCompletions("o")!.map((c) => c.value)).toEqual(["on", "off"]);
		expect(replArgumentCompletions("of")!.map((c) => c.value)).toEqual(["off"]);
		expect(replArgumentCompletions("x")).toBeNull();
	});

	test("usage message nudges toward the subcommand that would change something", () => {
		expect(replUsageMessage(true)).toContain("/repl off");
		expect(replUsageMessage(true)).toContain("currently on");
		expect(replUsageMessage(false)).toContain("/repl on");
		expect(replUsageMessage(false)).toContain("currently off");
	});

	test("toasts announce the mode and the transition", () => {
		expect(replToast("on")).toContain("repl on");
		expect(replToast("on")).toContain("execute");
		expect(replToast("off")).toContain("repl off");
		expect(replToast("off")).toContain("stays warm");
	});

	test("restoring prefers the captured stock loadout; falls back to the built-ins", () => {
		expect(restoredTools(["read", "bash", "my_tool"])).toEqual(["read", "bash", "my_tool"]);
		expect(restoredTools(undefined)).toEqual(["read", "bash", "edit", "write"]);
		// an empty capture must never restore zero tools — setActiveTools([]) bricks the session
		expect(restoredTools([])).toEqual(["read", "bash", "edit", "write"]);
	});
});

describe("repl tool surface: prune Pi's built-ins, never another extension's tools", () => {
	// The loadout bagheera actually runs, measured at before_provider_request on 2026-10-14.
	const STOCK = ["read", "bash", "edit", "write", "codemode", "llama_slots", "sessions", "ask_user_question", "remote", "context_checkpoint", "context_timeline", "context_compact"];

	test("the prune drops Pi's built-ins and leaves every extension tool active", () => {
		expect(prunedLoadout(STOCK)).toEqual(["execute", "read", "edit", "codemode", "llama_slots", "sessions", "ask_user_question", "remote", "context_checkpoint", "context_timeline", "context_compact"]);
	});

	test("built-ins are pruned by NAME, not by provenance", () => {
		// pi-ssh-remote wraps read/bash/edit/write, so on a box that installs it those four carry
		// sourceInfo "npm:pi-ssh-remote". Pruning by source would keep the wrapped copies — edit
		// alone costs 1,180 B of schema+description — and would drop nothing the kernel replaces.
		// bash/write still go by name; read and edit survive for their own reasons (the modality
		// channel, and patch() not yet at parity) — see BUILTIN_TOOL_NAMES in repl-command.ts.
		expect(prunedLoadout(["read", "bash", "edit", "write"])).toEqual(["execute", "read", "edit"]);
		// a wrapped copy of a name that IS replaced is pruned exactly like Pi's own
		expect(prunedLoadout(["bash", "write"])).toEqual(["execute"]);
	});

	test("the operator drop list removes named extension tools, and can never remove execute", () => {
		expect(prunedLoadout(["execute", "sessions", "remote", "context_compact"], ["sessions", "remote"])).toEqual(["execute", "context_compact"]);
		// a drop list that names execute still leaves the kernel: the mode is the point
		expect(prunedLoadout(["sessions"], ["execute", "sessions"])).toEqual(["execute"]);
		// a name that is not registered is a no-op, not an error
		expect(prunedLoadout(["codemode"], ["no_such_tool"])).toEqual(["execute", "codemode"]);
	});

	test("the toast names what the prune took, so a lost tool is visible instead of inferred", () => {
		const next = prunedLoadout(STOCK, ["sessions", "remote"]);
		const dropped = droppedToolNames(STOCK, next);
		expect(dropped).toEqual(["bash", "write", "sessions", "remote"]);
		const toast = replToast("on", dropped, next);
		expect(toast).toContain("dropped: bash write sessions remote");
		expect(toast).toContain("kept:");
		expect(toast).toContain("context_timeline");
		// and the modality channel is named as KEPT, because a jpeg reaching me is not a nicety
		expect(toast).toContain("read");
		// the point of the rule, said out loud: it is Pi's built-ins that go inactive
		expect(toast).toContain("Pi's built-in tools");
	});

	test("BUILTIN_TOOL_NAMES covers the names the kernel replaces, and not the ones it does not", () => {
		for (const name of ["bash", "write", "grep", "find", "ls", "powershell"]) expect(BUILTIN_TOOL_NAMES).toContain(name);
		// Pinned OUT on purpose, 2026-10-14, so nothing silently puts them back:
		//  - read is the only route to a non-text modality — a cell can read bytes, but only Pi's read
		//    hands an image to the model's vision encoder, so the kernel does not replace that job;
		//  - edit stays alongside patch() until patch() reaches parity (several anchors, one file, one
		//    atomic write, one diff).
		expect(BUILTIN_TOOL_NAMES).not.toContain("read");
		expect(BUILTIN_TOOL_NAMES).not.toContain("edit");
		// codemode is a composition surface (and today the only programmatic route to extension tools
		// from a cell), so repl mode must not prune it
		expect(BUILTIN_TOOL_NAMES).not.toContain("codemode");
		expect(BUILTIN_TOOL_NAMES).not.toContain("execute");
	});

	test("/repl off names what came back", () => {
		expect(replToast("off", ["sessions", "remote"])).toContain("restored: sessions remote");
		expect(replToast("off")).toContain("stays warm");
	});
});

describe("pi-repl.json: start repl engaged, and drop tools on purpose", () => {
	test("a box with no config file gets the defaults", () => {
		// Whole-object pins on purpose: a new config field has to earn its default here, in the open.
		// captureDir "" means the tee is off; viewLines 120 is the measured view budget.
		const missing = mkdtempSync(join(tmpdir(), "pi-repl-nocfg-"));
		expect(loadReplConfig(missing)).toEqual({ defaultOn: false, drop: [], captureDir: "", viewLines: 120, cellMaxMb: 32 });
	});

	test("defaultOn and the drop list are read", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-repl-cfg-"));
		writeFileSync(join(dir, "pi-repl.json"), JSON.stringify({ defaultOn: true, drop: ["sessions", "remote"] }));
		expect(loadReplConfig(dir)).toEqual({ defaultOn: true, drop: ["sessions", "remote"], captureDir: "", viewLines: 120, cellMaxMb: 32 });
	});

	test("a config file that exists but cannot be parsed is loud, and defaults apply", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-repl-cfg-bad-"));
		writeFileSync(join(dir, "pi-repl.json"), "{ defaultOn: true,,");
		const warns: string[] = [];
		expect(loadReplConfig(dir, (m) => warns.push(m))).toEqual(DEFAULT_REPL_CONFIG);
		expect(warns.length).toBe(1);
		expect(warns[0]).toContain("pi-repl.json");
	});

	test("junk entries are ignored with a count, never silently", () => {
		const warns: string[] = [];
		expect(parseReplConfig({ drop: ["sessions", 5, "", "remote"] }, (m) => warns.push(m))).toEqual({ defaultOn: false, drop: ["sessions", "remote"], captureDir: "", viewLines: 120, cellMaxMb: 32 });
		expect(warns.join(" ")).toContain("ignored 2");
		const warns2: string[] = [];
		expect(parseReplConfig({ defaultOn: "yes", drop: "sessions" }, (m) => warns2.push(m))).toEqual(DEFAULT_REPL_CONFIG);
		expect(warns2.length).toBe(2);
	});

	test("precedence: the escape hatch wins both ways, then the flag, then the configured default", () => {
		expect(startEngaged({ flagOn: false, force: "1", defaultOn: false })).toBe(true);
		expect(startEngaged({ flagOn: true, force: "0", defaultOn: true })).toBe(false);
		expect(startEngaged({ flagOn: true, defaultOn: false })).toBe(true);
		expect(startEngaged({ flagOn: false, defaultOn: true })).toBe(true);
		expect(startEngaged({ flagOn: false, defaultOn: false })).toBe(false);
		// any other value of the escape hatch is not a force
		expect(startEngaged({ flagOn: false, force: "yes", defaultOn: true })).toBe(true);
	});
});

describe("the execute tool description states the output contract", () => {
	test("with no tee it says truncated and names the char bound, because nothing is left to read", () => {
		const d = executeToolDescription();
		expect(d).toContain(`truncated to ${DEFAULT_MAX_OUTPUT_CHARS} chars`);
		expect(d).not.toContain("cell-<n>.txt");
	});

	test("with a tee it says bounded, names the line bound, and says where the whole cell lives", () => {
		const d = executeToolDescription({ dir: "/tmp/pan-out", viewLines: 120 });
		expect(d).toContain("bounded to 120 lines");
		expect(d).toContain("/tmp/pan-out/<session>/cell-<n>.txt");
		expect(d).not.toContain("truncated to");
	});

	test("both modes open with the same namespace sentence: that part is not a tee detail", () => {
		const head = "in one cell stay available to every later cell.";
		expect(executeToolDescription()).toContain(head);
		expect(executeToolDescription({ dir: "/x", viewLines: 1 })).toContain(head);
	});
});

describe("skills advertisement in --repl (withSkillsBlock)", () => {
	const skill = {
		name: "session-memory",
		description: "Recall past pi conversations from session history.",
		filePath: "/home/k2/.pi/agent/skills/session-memory/SKILL.md",
		baseDir: "/home/k2/.pi/agent/skills/session-memory",
		sourceInfo: {} as any,
		disableModelInvocation: false,
	};

	// A prompt shaped like buildSystemPrompt's tail: project context then cwd last.
	const promptWithCwd = "You are an expert.\n</project_context>\nCurrent working directory: /home/k2/works";

	test("injects the block, with execute in place of read", () => {
		const out = withSkillsBlock(promptWithCwd, [skill]);
		expect(out).toBeDefined();
		// lands in pi's slot: before the cwd line, never inside it
		expect(out!.indexOf("<available_skills>")).toBeLessThan(out!.indexOf("Current working directory:"));
		expect(out).toContain("<name>session-memory</name>");
		expect(out).toContain("<description>Recall past pi conversations from session history.</description>");
		// repl-corrected loading line
		expect(out).toContain("via execute (read the file with Python)");
		expect(out).not.toContain("Use the read tool to load");
	});

	test("stays undefined with no skills", () => {
		expect(withSkillsBlock(promptWithCwd, [])).toBeUndefined();
	});

	test("stays undefined when the block is already present (read-capable pi)", () => {
		const already = promptWithCwd + "\n<available_skills>\n</available_skills>";
		expect(withSkillsBlock(already, [skill])).toBeUndefined();
	});

	test("appends at the end when there is no cwd marker", () => {
		const bare = "You are a bot.";
		const out = withSkillsBlock(bare, [skill]);
		expect(out!.endsWith("<available_skills>\n</available_skills>")).toBe(false);
		expect(out!.startsWith(bare)).toBe(true);
		expect(out).toContain("<name>session-memory</name>");
	});
});

describe("render-core: code indent on wrap", () => {
	test("continuation rows line up with the wrapped statement's indentation", () => {
		const deps = testDeps({
			wrapTextWithAnsi: (text: string, width: number) => {
				const chunks: string[] = [];
				let line = "";
				let i = 0;
				while (i < text.length) {
					if (text[i] === "\x1b") {
						const end = text.indexOf("m", i);
						line += text.slice(i, end + 1);
						i = end + 1;
					} else {
						line += text[i];
						if (stripAnsi(line).length >= width) {
							chunks.push(line);
							line = "";
						}
						i++;
					}
				}
				if (line) chunks.push(line);
				for (let c = 1; c < chunks.length; c++) chunks[c] = chunks[c].replace(/^[ \t]+/, "");
				return chunks.length ? chunks : [""];
			},
		});
		const state = makeState({
			code:
				"def scale(values):\n" +
				"    total = digitsum(every_token_that_gets_wrapped_along_the_row_here_padded)\n" +
				"    return total",
			expanded: true,
		});
		const lines = renderExecuteCell(state, 30, deps).map(stripAnsi);
		const target = 7;
		const statement = lines.filter(
			(l) => l.includes("digitsum") || l.includes("_that_gets_wrapped") || l.includes("_padded"),
		);
		expect(statement.length).toBeGreaterThan(1);
		for (const row of statement) {
			expect(row.length - row.trimStart().length).toBe(target);
		}
	});
});

describe("render-core: cached code re-render", () => {
	test("repeated frames render identically from the cache", () => {
		const deps = testDeps();
		const state = makeState({ expanded: true, code: "def f(x):\n    return x * 2\nf(21)" });
		const first = renderExecuteBody(state, 60, deps);
		const second = renderExecuteBody(state, 60, deps);
		expect(second).toEqual(first);
		expect(second.join("\n")).toContain("def f(x)");
	});

	test("a changed body on the same state renders fresh, not stale", () => {
		const deps = testDeps();
		const state = makeState({ expanded: true, code: "old_body = 1" });
		renderExecuteBody(state, 60, deps);
		state.code = "new_body = 2";
		const rendered = renderExecuteBody(state, 60, deps).join("\n");
		expect(rendered).toContain("new_body = 2");
		expect(rendered).not.toContain("old_body = 1");
	});

	test("width churn (resizes) stays correct after cache eviction", () => {
		const deps = testDeps();
		const state = makeState({ expanded: true, code: "value = 'x' * 120\nprint(value)" });
		const reference = renderExecuteBody(state, 40, deps);
		[50, 70, 90, 110].forEach((w) => {
			renderExecuteBody(state, w, deps);
		});
		// the first width was evicted from the bound cache; re-render must rebuild it
		const again = renderExecuteBody(state, 40, deps);
		expect(again).toEqual(reference);
	});
});

describe("render-core: bare identifier coloring", () => {
	test("raw identifiers are painted with syntaxVariable; colored tokens are left alone", () => {
		const calls: Array<[string, string]> = [];
		const deps = testDeps({
			fg: (color: string, text: string) => {
				calls.push([color, text]);
				return `\x1b[38;2;1;2;3m${text}\x1b[39m`;
			},
			highlight: (code) =>
				code.split("\n").map((line) =>
					// only the word KEY is a pre-colored token; everything else is raw
					line.replace(/KEY/g, "\x1b[38;2;86;156;214mKEY\x1b[39m"),
				),
		});
		const state = makeState({
			code: "result = call_me(arg)\nKEY = 1",
			expanded: true,
		});
		renderExecuteCell(state, 40, deps);
		const ids = calls.filter(([c]) => c === "syntaxVariable").map(([, t]) => t);
		expect(ids).toContain("result");
		expect(ids).toContain("call_me");
		expect(ids).toContain("arg");
		expect(ids).not.toContain("KEY");
	});
});

describe("EngineLifecycle reset notices", () => {
	// --- a fake engine so the lifecycle policy is testable without a kernel. start() hangs
	// --- to simulate a wedged boot; the restore result is settleable by the test so the
	// --- async-recovery contract (acquire never waits, notice follows completion) is provable. ---
	class FakeEngine implements RevivableEngine {
		readonly started: boolean[] = [];
		private resolveRestore!: (r: RestoreResult | null) => void;
		private restoreSettled: Promise<RestoreResult | null>;
		constructor(
			private readonly restore: RestoreResult | null,
			readonly history: boolean,
			private readonly hang = false,
			readonly skip: boolean = false,
			pending = false,
		) {
			// a skipped engine's recovery settles null, exactly like EngineManager
			this.restoreSettled = pending
				? new Promise((resolve) => {
						this.resolveRestore = resolve;
					})
				: Promise.resolve(skip ? null : this.restore);
		}
		async start(): Promise<void> {
			this.started.push(this.skip); // records the skip flag each boot attempt
			if (this.hang) return new Promise<never>(() => {});
		}
		restoreResult(): Promise<RestoreResult | null> {
			return this.restoreSettled;
		}
		/** Settle a pending recovery, as the engine's quiet-gap restore would. */
		finishRestore(r: RestoreResult | null): void {
			this.resolveRestore(r);
		}
		restoreWasSkipped(): boolean {
			return this.skip;
		}
		hasSnapshotHistory(): boolean {
			return this.history;
		}
	}

	const deps = (restore: RestoreResult | null, history: boolean) =>
		({
			create: (skip?: boolean) => new FakeEngine(restore, history, false, skip ?? false),
			async dispose() {},
		}) as EngineLifecycleDeps<FakeEngine>;

	const restored = (n: string[]): RestoreResult => ({ path: "/tmp/ns.snapshot", restored: n, failed: [] });

	// --- notices land once the (background) recovery settles; the fakes above resolve it on
	// --- the microtask queue, so by the time acquire() has returned the notice is present ---

	test("a mid-session rebuild announces on the next cell", async () => {
		const lc = new EngineLifecycle(deps(restored(["data"]), false));
		await lc.acquire("cell");
		const notice = lc.takeResetNotice();
		expect(notice).toBeDefined();
		expect(notice?.notice).toContain("Revived (1): data");
	});

	test("a resumed conversation announces its restore on the first cell", async () => {
		const lc = new EngineLifecycle(deps(restored(["data", "model"]), true));
		await lc.acquire("startup");
		const notice = lc.takeResetNotice();
		expect(notice).toBeDefined();
		expect(notice?.notice).toContain("started fresh");
		expect(notice?.notice).toContain("Revived (2): data, model");
	});

	test("a first-ever session stays quiet", async () => {
		const lc = new EngineLifecycle(deps(restored(["data"]), false));
		await lc.acquire("startup");
		expect(lc.takeResetNotice()).toBeUndefined();
	});

	test("a resumed conversation with no snapshot says so instead of pretending", async () => {
		const lc = new EngineLifecycle(deps(null, true));
		await lc.acquire("startup");
		const notice = lc.takeResetNotice();
		expect(notice).toBeDefined();
		expect(notice?.notice).toContain("no saved snapshot was available to revive");
	});

	test("a partial revive names the losses", async () => {
		const failed = [{ name: "handle", reason: "can't pickle" }];
		const lc = new EngineLifecycle(deps({ path: "/tmp/ns.snapshot", restored: ["ok"], failed }, true));
		await lc.acquire("startup");
		const notice = lc.takeResetNotice();
		expect(notice?.notice).toContain("Lost (1): handle");
		expect(notice?.notice).toContain("cannot be snapshotted");
	});

	test("an existing engine never re-announces; the notice is taken exactly once", async () => {
		const lc = new EngineLifecycle(deps(restored(["data"]), true));
		await lc.acquire("startup");
		expect(lc.takeResetNotice()).toBeDefined();
		expect(lc.takeResetNotice()).toBeUndefined();
		// a later cell acquire reuses the engine without a new notice
		await lc.acquire("cell");
		expect(lc.takeResetNotice()).toBeUndefined();
	});

	test("acquire returns before a slow recovery completes; the notice follows the restore", async () => {
		const created: FakeEngine[] = [];
		const lc = new EngineLifecycle<FakeEngine>({
			create: (skip?: boolean) => {
				const e = new FakeEngine(null, true, false, skip ?? false, true); // pending restore
				created.push(e);
				return e;
			},
			async dispose() {},
		});
		const acquire = lc.acquire("startup"); // not awaited until the guard below
		const { engine, created: wasCreated } = await acquire;
		expect(wasCreated).toBe(true);
		// the recovery is still in flight: acquire must have returned without it
		expect(lc.takeResetNotice()).toBeUndefined();
		// the quiet-gap restore settles later; the notice lands then
		created[0]!.finishRestore(restored(["data"]));
		await new Promise((resolve) => setImmediate(resolve));
		const notice = lc.takeResetNotice();
		expect(notice).toBeDefined();
		expect(notice?.notice).toContain("Revived (1): data");
		expect(engine).toBe(created[0]);
	});

	test("a different conversation's acquire replaces the engine instead of bleeding into it", async () => {
		const created: FakeEngine[] = [];
		const disposed: FakeEngine[] = [];
		const lc = new EngineLifecycle<FakeEngine>({
			create: (skip?: boolean) => {
				const e = new FakeEngine(restored(["conv-state"]), true, false, skip ?? false);
				created.push(e);
				return e;
			},
			async dispose(e) {
				disposed.push(e);
			},
		});
		await lc.acquire("startup", "conv-A");
		await lc.acquire("cell", "conv-A"); // same conversation: the engine is reused, not rebuilt
		expect(created).toHaveLength(1);
		const first = created[0]!;
		await lc.acquire("startup", "conv-B"); // different conversation: flush + rebuild
		expect(disposed).toEqual([first]);
		expect(created).toHaveLength(2);
		// the new conversation got its own engine + its own (fresh) announcement
		const notice = lc.takeResetNotice();
		expect(notice?.notice).toContain("started fresh");
		expect(notice?.notice).toContain("Revived (1): conv-state");
	});

	test("an engine bound to no key serves any acquire without a teardown", async () => {
		const lc = new EngineLifecycle(deps(restored(["data"]), true));
		await lc.acquire("startup");
		await lc.acquire("cell", "some-key"); // key appears later: nothing to bleed, no teardown
		expect(lc.takeResetNotice()).toBeDefined();
	});

	test("a wedged recovery is announced as skipped, honestly", async () => {
		// the engine's restore-cell watchdog found a poisoned pickle, killed the kernel, and
		// marked ITSELF skipped (restoreResult settles null, restoreWasSkipped is true): the
		// lifecycle must say "wedged; skipped", never "no snapshot available"
		const lc = new EngineLifecycle<FakeEngine>({
			create: () => new FakeEngine(null, true, false, true),
			async dispose() {},
		});
		const { engine } = await lc.acquire("cell");
		expect(engine.restoreWasSkipped()).toBe(true);
		const notice = lc.takeResetNotice();
		expect(notice).toBeDefined();
		expect(notice?.notice).toContain("wedged");
		expect(notice?.notice).toContain("skipped");
		expect(notice?.restore).toBe(null);
		expect(notice?.wedged).toBe(true);
	});

	test("the reset toast is terse and agrees with the marker's counts", () => {
		// rebuilt mid-session with a full revive
		expect(formatResetToast("cell", restored(["a", "b"]))).toBe("repl kernel rebuilt, 2 names revived");
		// revived some, lost some
		expect(formatResetToast("cell", { path: "/tmp/x", restored: ["a"], failed: [{ name: "h", reason: "r" }] })).toBe(
			"repl kernel rebuilt, 1 name revived, 1 lost",
		);
		// resumed conversation
		expect(formatResetToast("startup", restored(["data"]))).toBe("repl session resumed, 1 name revived");
		// nothing saved vs nothing revived are distinct and accurate
		expect(formatResetToast("cell", null)).toBe("repl kernel rebuilt, nothing saved to revive");
		expect(formatResetToast("startup", { path: "/tmp/x", restored: [], failed: [] })).toBe(
			"repl session resumed, nothing could be revived",
		);
		// a wedged revive names the skip so nobody mistakes it for "nothing saved"
		expect(formatResetToast("cell", null, true)).toBe("repl kernel rebuilt, snapshot revive skipped (wedged)");
		expect(formatResetToast("startup", null, true)).toBe("repl session resumed, snapshot revive skipped (wedged)");
	});

	test("a boot that wedges is killed and retried fresh, with the snapshot skipped honestly", async () => {
		const created: FakeEngine[] = [];
		const discarded: FakeEngine[] = [];
		const lc = new EngineLifecycle<FakeEngine>({
			create: (skip?: boolean) => {
				const hang = created.length === 0; // first engine hangs at boot
				const e = new FakeEngine(hang ? null : restored(["data"]), true, hang, skip ?? false);
				created.push(e);
				return e;
			},
			async dispose() {},
			async discard(e) {
				discarded.push(e);
			},
			bootTimeoutMs: 40,
		});
		const { engine, restore } = await lc.acquire("cell");
		expect(engine).toBe(created[1]);
		expect(restore).toBe(null);
		expect(discarded).toEqual([created[0]]);
		// the retry booted WITHOUT the snapshot, so the poisoned snapshot can't wedge twice
		expect(created[1]!.skip).toBe(true);
		expect(created[1]!.started).toEqual([true]);
		const notice = lc.takeResetNotice();
		expect(notice?.notice).toContain("wedged");
		expect(notice?.notice).toContain("skipped");
		expect(notice?.restore).toBe(null);
	});

	test("a boot that wedges twice fails loudly instead of hanging the session", async () => {
		const created: FakeEngine[] = [];
		const discarded: FakeEngine[] = [];
		const lc = new EngineLifecycle<FakeEngine>({
			create: (skip?: boolean) => {
				const e = new FakeEngine(null, true, true, skip ?? false);
				created.push(e);
				return e;
			},
			async dispose() {},
			async discard(e) {
				discarded.push(e);
			},
			bootTimeoutMs: 40,
		});
		await expect(lc.acquire("cell")).rejects.toThrow("timed out twice");
		expect(created).toHaveLength(2);
		expect(discarded).toEqual(created);
	});
});

describe("session state layout: keys never collide across conversations", () => {
	test("the state dir key joins the project slug with the conversation name", () => {
		expect(sessionStateDirName("/root/sessions/--proj-a--/2026-01-01T00-00-00Z_111.jsonl")).toBe(
			"--proj-a--__2026-01-01T00-00-00Z_111",
		);
		// two conversations with the same basename in different projects get different keys
		const a = sessionStateDirName("/root/sessions/--proj-a--/shared.jsonl");
		const b = sessionStateDirName("/root/sessions/--proj-b--/shared.jsonl");
		expect(a).not.toBe(b);
	});

	test("a legacy bare-name dir migrates to the slug key on the owning conversation's start", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-repl-statekey-"));
		try {
			const sessions = join(root, "sessions");
			const state = join(root, "state");
			mkdirSync(join(sessions, "--proj-a--"), { recursive: true });
			const conv = "2026-01-01T00-00-00Z_111";
			writeFileSync(join(sessions, "--proj-a--", `${conv}.jsonl`), "x");
			// pre-slug dir exists for this conversation
			const legacy = join(state, conv);
			mkdirSync(legacy, { recursive: true });
			writeFileSync(join(legacy, "namespace.snapshot"), "{}");
			const resolved = resolveStateDir(state, join(sessions, "--proj-a--", `${conv}.jsonl`));
			expect(resolved.snapshotPath).toBe(join(state, `--proj-a--__${conv}`, "namespace.snapshot"));
			expect(existsSync(resolved.snapshotPath)).toBe(true); // migrated, so the snapshot survives
			expect(existsSync(legacy)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("migration is skipped when the slug dir already owns a snapshot", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-repl-statekey-"));
		try {
			const state = join(root, "state");
			const dir = join(state, "--proj-a--__conv");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "namespace.snapshot"), "newer");
			const legacy = join(state, "conv");
			mkdirSync(legacy, { recursive: true });
			writeFileSync(join(legacy, "namespace.snapshot"), "older");
			const resolved = resolveStateDir(state, join(root, "sessions", "--proj-a--", "conv.jsonl"));
			expect(resolved.snapshotPath).toBe(join(dir, "namespace.snapshot"));
			expect(readFileSync(resolved.snapshotPath, "utf8")).toBe("newer");
			expect(existsSync(legacy)).toBe(true); // untouched; the orphan sweep sees it as live
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("pruneSnapshotDirs keeps only the newest snapshots", () => {
	test("deletes oldest snapshot dirs and never the live one", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-repl-prune-"));
		try {
			const mk = (name: string, ageMs: number) => {
				const dir = join(root, name);
				mkdirSync(dir, { recursive: true });
				const f = join(dir, "namespace.snapshot");
				writeFileSync(f, "{}");
				const t = Date.now() - ageMs;
				utimesSync(f, new Date(t), new Date(t));
				return dir;
			};
			const old1 = mk("old-1", 40 * 24 * 3600 * 1000);
			const old2 = mk("old-2", 30 * 24 * 3600 * 1000);
			const fresh = mk("fresh", 1000);
			mkdirSync(join(root, "no-manifest")); // unrelated dir with no snapshot: untouched
			pruneSnapshotDirs(root, 2);
			expect(existsSync(old1)).toBe(false);
			expect(existsSync(old2)).toBe(true);
			expect(existsSync(fresh)).toBe(true);
			expect(existsSync(join(root, "no-manifest"))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("orphaned snapshot dirs die with their conversation", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-repl-orphan-"));
		const sessions = mkdtempSync(join(tmpdir(), "pi-repl-sess-"));
		try {
			// project roots under the sessions root; alpha/beta conversations survive
			const a = join(sessions, "proj-a");
			const b = join(sessions, "proj-b");
			mkdirSync(a);
			mkdirSync(b);
			writeFileSync(join(a, "alpha.jsonl"), "x");
			writeFileSync(join(b, "beta.jsonl"), "x");
			// state dirs keyed by conversation basename
			const mk = (name: string) => {
				const d = join(root, name);
				mkdirSync(d);
				writeFileSync(join(d, "namespace.snapshot"), "{}");
				return d;
			};
			const alpha = mk("alpha");
			const beta = mk("beta");
			const gamma = mk("gamma"); // conversation deleted everywhere
			const current = mk("current-session");
			const ephemeral = mk("ephemeral"); // no-session fallback: always kept
			mkdirSync(join(root, "random-dir")); // no manifest: must never be touched

			const removed = pruneOrphanedSnapshotDirs(root, sessions, "current-session");
			expect(removed).toBe(1);
			expect(existsSync(gamma)).toBe(false);
			expect(existsSync(alpha)).toBe(true); // file lives under proj-a
			expect(existsSync(beta)).toBe(true);
			expect(existsSync(current)).toBe(true);
			expect(existsSync(ephemeral)).toBe(true);
			expect(existsSync(join(root, "random-dir"))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(sessions, { recursive: true, force: true });
		}
	});

	test("orphan sweep is a no-op without a sessions root", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-repl-orphan-"));
		try {
			const d = join(root, "gamma");
			mkdirSync(d);
			writeFileSync(join(d, "namespace.snapshot"), "{}");
			expect(pruneOrphanedSnapshotDirs(root, undefined, undefined)).toBe(0);
			expect(existsSync(d)).toBe(true);
			expect(pruneOrphanedSnapshotDirs(root, join(root, "no-such-root"), undefined)).toBe(0);
			expect(existsSync(d)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("the orphan sweep recognizes both legacy and slug-keyed dirs, so deletion cleans both", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-repl-orphan-"));
		const sessions = mkdtempSync(join(tmpdir(), "pi-repl-sess-"));
		try {
			// proj-a: alive.jsonl (slug dir) and carryover.jsonl (legacy pre-slug dir, not yet migrated)
			const a = join(sessions, "--proj-a--");
			mkdirSync(a);
			writeFileSync(join(a, "alive.jsonl"), "x");
			writeFileSync(join(a, "carryover.jsonl"), "x");
			// proj-b: deleted.jsonl was deleted → both its dir formats must be swept
			const b = join(sessions, "--proj-b--");
			mkdirSync(b);
			const mk = (name: string) => {
				const d = join(root, name);
				mkdirSync(d);
				writeFileSync(join(d, "namespace.snapshot"), "{}");
				return d;
			};
			const aliveSlug = mk("--proj-a--__alive");
			const carryoverLegacy = mk("carryover"); // live conversation, legacy format: kept
			const deletedSlug = mk("--proj-b--__deleted");
			const deletedLegacy = mk("deleted"); // same conversation's pre-slug dir: swept too
			const ephemeral = mk("ephemeral");

			const removed = pruneOrphanedSnapshotDirs(root, sessions, "--proj-a--__alive");
			expect(removed).toBe(2);
			expect(existsSync(aliveSlug)).toBe(true);
			expect(existsSync(carryoverLegacy)).toBe(true);
			expect(existsSync(deletedSlug)).toBe(false);
			expect(existsSync(deletedLegacy)).toBe(false);
			expect(existsSync(ephemeral)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(sessions, { recursive: true, force: true });
		}
	});
});

describe("fork inheritance", () => {
	function forkWorld() {
		const stateRoot = mkdtempSync(join(tmpdir(), "pi-repl-fork-state-"));
		const sessionsRoot = mkdtempSync(join(tmpdir(), "pi-repl-fork-sessions-"));
		const slugDir = join(sessionsRoot, "proj-a");
		mkdirSync(slugDir, { recursive: true });
		const parentFile = join(slugDir, "parent.jsonl");
		const forkFile = join(slugDir, "forked.jsonl");
		writeFileSync(parentFile, '{"type":"session","version":3,"id":"parent"}\n');
		return { stateRoot, parentFile, forkFile };
	}

	const parentSnap = (stateRoot: string, parentFile: string) => resolveStateDir(stateRoot, parentFile).snapshotPath;
	const forkSnap = (stateRoot: string, forkFile: string) => resolveStateDir(stateRoot, forkFile).snapshotPath;

	test("a fork with a parentSession copies the parent's snapshot exactly once", () => {
		const { stateRoot, parentFile, forkFile } = forkWorld();
		mkdirSync(dirname(parentSnap(stateRoot, parentFile)), { recursive: true });
		writeFileSync(parentSnap(stateRoot, parentFile), '{"version":3,"entries":[]}');
		writeFileSync(forkFile, JSON.stringify({ type: "session", parentSession: parentFile }));

		const target = forkSnap(stateRoot, forkFile);
		expect(existsSync(target)).toBe(false);
		inheritForkSnapshot(stateRoot, forkFile, target);
		expect(readFileSync(target, "utf8")).toBe('{"version":3,"entries":[]}');
		expect(existsSync(`${target}.tmp`)).toBe(false); // atomic copy leaves no temp
		expect(readFileSync(parentSnap(stateRoot, parentFile), "utf8")).toBe('{"version":3,"entries":[]}'); // parent untouched

		// idempotent: a fork that already has history is never overwritten
		writeFileSync(target, "newer-fork-history");
		inheritForkSnapshot(stateRoot, forkFile, target);
		expect(readFileSync(target, "utf8")).toBe("newer-fork-history");
	});

	test("a fork whose parent never snapshotted stays empty", () => {
		const { stateRoot, parentFile, forkFile } = forkWorld();
		writeFileSync(forkFile, JSON.stringify({ type: "session", parentSession: parentFile }));
		const target = forkSnap(stateRoot, forkFile);
		inheritForkSnapshot(stateRoot, forkFile, target);
		expect(existsSync(target)).toBe(false);
	});

	test("a resumed session (no parentSession) is untouched", () => {
		const { stateRoot, forkFile } = forkWorld();
		writeFileSync(forkFile, '{"type":"session","version":3,"id":"plain"}\n');
		forkParentSnapshot(stateRoot, forkFile, forkSnap(stateRoot, forkFile));
		inheritForkSnapshot(stateRoot, forkFile, forkSnap(stateRoot, forkFile));
		expect(existsSync(forkSnap(stateRoot, forkFile))).toBe(false);
	});

	test("an unreadable session file is not treated as a fork", () => {
		const { stateRoot, forkFile } = forkWorld();
		writeFileSync(forkFile, "not json at all");
		expect(forkParentSnapshot(stateRoot, forkFile, forkSnap(stateRoot, forkFile))).toBeUndefined();
	});

	test("formatForkToast names the inheritance, never masquerades as a resume", () => {
		expect(formatForkToast({ path: "x", restored: ["a", "b"], failed: [] })).toBe(
			"repl fork started — 2 names inherited from the parent session",
		);
		expect(formatForkToast({ path: "x", restored: ["a"], failed: [] })).toBe(
			"repl fork started — 1 name inherited from the parent session",
		);
		expect(formatForkToast(null)).toBe("repl fork started — nothing to inherit");
		expect(formatForkToast({ path: "x", restored: [], failed: [] })).toBe(
			"repl fork started — parent snapshot revived nothing",
		);
	});
});

describe("bridge pipe routing", () => {
	// KernelClient's private constructor spawns nothing; drive the JSON-line router by feeding
	// it lines, with send() captured so replies can be matched by op id.
	const Seam = KernelClient as unknown as new (
		opts: object,
	) => {
		send(msg: unknown): void;
		handleLine(line: string): void;
		executeCellNow(code: string, opts: object): Promise<CellResult>;
		readonly helperReport: { name: string; ok: boolean; error?: string }[];
	};

	function routedKernel() {
		const sent: unknown[] = [];
		const kc = new Seam({});
		kc.send = (m) => sent.push(m as never);
		const feed = (line: string) => kc.handleLine(line);
		return { kc, sent, feed };
	}

	test("stream and result events settle a cell, routed by op id", async () => {
		const { kc, sent, feed } = routedKernel();
		const chunks: string[] = [];
		const cell = kc.executeCellNow("x = 1", {
			maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
			onStream: (c: string, n: string) => chunks.push(`${n}:${c}`),
		});
		expect(sent).toHaveLength(1); // the exec request
		feed('{"type":"stream","id":"e0","name":"stdout","text":"hello "}');
		feed('{"type":"stream","id":"e0","name":"stderr","text":"warn\\n"}');
		feed('{"type":"result","id":"e0","status":"ok"}');
		const r = await cell;
		expect(r.status).toBe("ok");
		expect(r.stdout).toBe("hello ");
		expect(r.stderr).toBe("warn\n");
		expect(chunks).toEqual(["stdout:hello ", "stderr:warn\n"]);
	});

	test("a stream event for another op id is ignored", async () => {
		const { kc, feed } = routedKernel();
		const cell = kc.executeCellNow("x = 1", { maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS });
		feed('{"type":"stream","id":"e9","name":"stdout","text":"noise"}');
		feed('{"type":"result","id":"e0","status":"ok"}');
		const r = await cell;
		expect(r.stdout).toBe("");
	});

	test("channel caps apply during streaming and are reported", async () => {
		const { kc, feed } = routedKernel();
		const cell = kc.executeCellNow("print(1)", { maxOutputChars: 5 });
		feed('{"type":"stream","id":"e0","name":"stdout","text":"hello "}');
		feed('{"type":"stream","id":"e0","name":"stdout","text":"world"}');
		feed('{"type":"result","id":"e0","status":"ok"}');
		const r = await cell;
		expect(r.stdout).toBe("hello");
		expect(r.truncated?.stdout).toBe(true);
	});

	test("an error result surfaces name, message, and stack", async () => {
		const { kc, feed } = routedKernel();
		const cell = kc.executeCellNow("raise", { maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS });
		feed(
			'{"type":"result","id":"e0","status":"error","error":{"name":"ValueError","message":"boom","stack":["line1"]}}',
		);
		const r = await cell;
		expect(r.status).toBe("error");
		expect(r.error?.name).toBe("ValueError");
		expect(r.error?.stack).toEqual(["line1"]);
	});

	test("an aborted status wins over a carried error", async () => {
		const { kc, feed } = routedKernel();
		const cell = kc.executeCellNow("sleep", { maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS });
		feed(
			'{"type":"result","id":"e0","status":"aborted","error":{"name":"KeyboardInterrupt","message":"interrupted","stack":[]}}',
		);
		const r = await cell;
		expect(r.status).toBe("aborted");
	});

	test("a reply event resolves the pending request by id", async () => {
		const { kc, sent, feed } = routedKernel();
		const snap = kc.snapshot("/tmp/ns.snapshot", 1024);
		await Promise.resolve(); // the request is enqueued on a microtask
		const req = sent.find((m) => (m as { op?: string }).op === "snapshot") as { id: string };
		expect(req).toBeDefined();
		feed(`{"type":"reply","id":"${req.id}","saved":["a"],"failed":[],"complete":true,"bytes":5}`);
		const reply = await snap;
		expect(reply.complete).toBe(true);
		expect(reply.saved).toEqual(["a"]);
		expect(reply.bytes).toBe(5);
	});

	test("an error event rejects the pending request", async () => {
		const { kc, sent, feed } = routedKernel();
		const names = kc.listNames();
		await Promise.resolve(); // the request is enqueued on a microtask
		const req = sent.find((m) => (m as { op?: string }).op === "listNames") as { id: string };
		feed(`{"type":"error","id":"${req.id}","message":"unpicklable"}`);
		await expect(names).rejects.toThrow("unpicklable");
	});

	test("restore rejects on an error reply; unparseable bridge lines are dropped", async () => {
		const { kc, sent, feed } = routedKernel();
		const rest = kc.restore("/tmp/x");
		await Promise.resolve(); // the request is enqueued on a microtask
		const req = sent.find((m) => (m as { op?: string }).op === "restore") as { id: string };
		feed(`{"type":"reply","id":"${req.id}","error":"snapshot unreadable"}`);
		await expect(rest).rejects.toThrow("snapshot unreadable");
		expect(() => feed("this is not json")).not.toThrow();
	});

	// --- Key 221 step 2: the injected bootstrap line, and what the host does with its verdict.
	test("the injected line is one line, and naming it here is what makes changing it a decision", () => {
		// Nothing in the host parses this string. It is the whole mechanism, so the assertion is not
		// describing behaviour -- it is the tripwire on the one thing the extension injects.
		expect(DEFAULT_BOOTSTRAP).toBe("from panlib.boot import *");
	});

	test("a failed bootstrap joins the helper report, because that is the channel I already act on", () => {
		const { kc, feed } = routedKernel();
		feed(
			'{"type":"ready","helpers":[{"name":"capture","ok":true}],"bootstrap":{"ok":false,"line":"from panlib.boot import *","error":"ModuleNotFoundError: No module named panlib"}}',
		);
		const report = kc.helperReport;
		expect(report[0]).toEqual({
			name: "bootstrap",
			ok: false,
			error: "ModuleNotFoundError: No module named panlib",
		});
		expect(report.map((h) => h.name)).toEqual(["bootstrap", "capture"]); // the helpers are not displaced
	});

	test("a bootstrap that succeeded adds no entry, and neither does a bridge that sent no line", () => {
		const ok = routedKernel();
		ok.feed('{"type":"ready","helpers":[{"name":"capture","ok":true}],"bootstrap":{"ok":true,"line":"x = 1"}}');
		expect(ok.kc.helperReport.map((h) => h.name)).toEqual(["capture"]);

		const none = routedKernel();
		none.feed('{"type":"ready","helpers":[{"name":"capture","ok":true}],"bootstrap":null}');
		expect(none.kc.helperReport.map((h) => h.name)).toEqual(["capture"]);
	});
});

// --- Key 138 half 2: the diff card.
// testDeps' `fg` throws the colour name away, which is right for layout tests and useless for a diff,
// where the colour IS the information. These give `fg` a real palette so the assertion reads it back off
// the raw row, while stripAnsi still measures width correctly.
const PALETTE: Record<string, string> = {
	success: "32",
	error: "31",
	accent: "36",
	dim: "2",
	toolOutput: "37",
	warning: "33",
	muted: "90",
};
const colorDeps = (): RenderDeps =>
	testDeps({ fg: (color, text) => `\x1b[${PALETTE[color] ?? "0"}m${text}\x1b[0m` });

const DIFF = "--- a/notes.md\n+++ b/notes.md\n@@ -1,3 +1,3 @@\n context line\n-removed thing\n+added thing\n";
const cardOf = (items: unknown[], extra: Record<string, unknown> = {}) => ({ kind: "diffs", items, ...extra });
const itemOf = (over: Record<string, unknown> = {}) => ({
	path: "notes.md",
	added: 1,
	removed: 1,
	dryRun: false,
	diff: DIFF,
	...over,
});
const cardState = (card: unknown, overrides: Partial<ExecuteRenderState> = {}) =>
	makeState({ expanded: true, details: { status: "ok", durationMs: 40, card }, ...overrides });

describe("render-core: the diff card (Key 138)", () => {
	test("readDiffCard carries droppedItems, and omits it when nothing was hidden", () => {
		expect(readDiffCard(cardOf([itemOf()], { droppedItems: 3 }))?.droppedItems).toBe(3);
		expect(readDiffCard(cardOf([itemOf()], { droppedItems: 0 }))?.droppedItems).toBeUndefined();
		expect(readDiffCard(cardOf([itemOf()], { droppedItems: "three" }))?.droppedItems).toBeUndefined();
	});

	test("readDiffCard refuses junk instead of half-rendering it", () => {
		for (const junk of [undefined, null, "diffs", [], { kind: "other", items: [] }, { kind: "diffs", items: "no" }, { kind: "diffs", items: [{ path: 1, diff: 2 }] }]) {
			expect(readDiffCard(junk)).toBeUndefined();
		}
		expect(readDiffCard(cardOf([]))).toBeUndefined();
	});

	test("a card renders one header per file naming the path and its counts", () => {
		const rows = stripAnsi(renderExecuteBody(cardState(cardOf([itemOf()])), 80, colorDeps()).join("\n"));
		expect(rows).toContain("diff:");
		expect(rows).toContain("notes.md");
		expect(rows).toContain("+1");
		expect(rows).toContain("−1");
		expect(rows).toContain("removed thing");
		expect(rows).toContain("added thing");
	});

	test("diff lines are coloured by role, not by whatever the blob colour was", () => {
		const raw = renderExecuteBody(cardState(cardOf([itemOf()])), 120, colorDeps());
		const rowFor = (needle: string) => raw.find((row) => stripAnsi(row).includes(needle)) ?? "";
		expect(rowFor("added thing")).toContain("\x1b[32m"); // success
		expect(rowFor("removed thing")).toContain("\x1b[31m"); // error
		expect(rowFor("@@ -1,3 +1,3 @@")).toContain("\x1b[36m"); // accent
		expect(rowFor("--- a/notes.md")).toContain("\x1b[2m"); // dim
		expect(rowFor("+++ b/notes.md")).toContain("\x1b[2m");
		expect(rowFor("context line")).toContain("\x1b[37m"); // toolOutput
	});

	test("a collapsed cell still shows the change: counts in the header, no body needed", () => {
		const collapsed = makeState({ expanded: false, details: { status: "ok", durationMs: 40, card: cardOf([itemOf()]) } });
		expect(stripAnsi(renderExecuteHeader(collapsed, 100, colorDeps())[0])).toContain("diff +1 −1");
		const plain = makeState({ expanded: false });
		expect(stripAnsi(renderExecuteHeader(plain, 100, colorDeps())[0])).not.toContain("diff +");
	});

	test("the collapsed counts sum across files", () => {
		const two = makeState({
			expanded: false,
			details: { status: "ok", card: cardOf([itemOf({ added: 3, removed: 1 }), itemOf({ path: "other.py", added: 2, removed: 4 })]) },
		});
		expect(stripAnsi(renderExecuteHeader(two, 100, colorDeps())[0])).toContain("diff +5 −5");
	});

	test("a card that fails validation renders exactly the cell that had no card", () => {
		const withJunk = stripAnsi(renderExecuteBody(cardState({ kind: "diffs", items: "not a list" }), 80, colorDeps()).join("\n"));
		const without = stripAnsi(renderExecuteBody(cardState(undefined), 80, colorDeps()).join("\n"));
		expect(withJunk).toBe(without);
	});

	test("the writer's bound is announced, so a partial card does not read as the whole change", () => {
		const rows = stripAnsi(renderExecuteBody(cardState(cardOf([itemOf()], { droppedItems: 3 })), 80, colorDeps()).join("\n"));
		expect(rows).toContain("3 more change(s) not shown");
	});

	test("the card is not counted in the ↓ line count — that path assumes an append-only blob", () => {
		// Asserted as an equality against the same cell with no card, not against a number I picked:
		// the count itself has a pre-existing quirk (a trailing newline counts as a line, so "one line\n"
		// reports 2), and pinning that number here would make this test about someone else's bug.
		const counts = (card: unknown) => {
			const state = makeState({ expanded: false, details: { status: "ok", stdout: "one line\n", ...(card ? { card } : {}) } });
			return stripAnsi(renderExecuteHeader(state, 120, colorDeps())[0]).match(/↓ \d+ lines/)?.[0];
		};
		expect(counts(cardOf([itemOf()]))).toBe(counts(undefined));
		expect(counts(cardOf([itemOf({ diff: "x".repeat(4000) })]))).toBe(counts(undefined));
	});

	test("the card only asks for colours the theme actually has", () => {
		// render.ts does `theme.fg(color as Parameters<Theme["fg"]>[0], text)` — the cast means TypeScript
		// never checks a colour name, so a typo ("danger") renders uncoloured text and no layout test
		// notices. Re-derive the real set with:
		//   bun -e "const m=require('<pi-package>/dist/modes/interactive/theme/theme-tokens.js');\
		//     console.log(Object.keys(m.THEME_TOKENS).filter(k=>m.THEME_TOKENS[k].slot==='foreground'))"
		const seen = new Set<string>();
		const deps = testDeps({
			fg: (color, text) => {
				seen.add(color);
				return text;
			},
		});
		renderExecuteBody(cardState(cardOf([itemOf({ dryRun: true })])), 80, deps);
		expect([...seen].sort()).toEqual(["accent", "dim", "error", "success", "toolOutput", "warning"]);
	});

	test("a dry run is marked as one, and an empty diff says so rather than rendering nothing", () => {
		const dry = stripAnsi(renderExecuteBody(cardState(cardOf([itemOf({ dryRun: true })])), 80, colorDeps()).join("\n"));
		expect(dry).toContain("(dry run)");
		const empty = stripAnsi(renderExecuteBody(cardState(cardOf([itemOf({ diff: "" })])), 80, colorDeps()).join("\n"));
		expect(empty).toContain("(no diff text)");
		expect(empty).toContain("notes.md");
	});

	test("a card alone is output: the cell does not say 'no output' underneath a rendered diff", () => {
		const rows = stripAnsi(renderExecuteBody(cardState(cardOf([itemOf()])), 80, colorDeps()).join("\n"));
		expect(rows).not.toContain("no output");
	});

	test("every diff row stays inside the width, including the long hunk headers", () => {
		const wide = cardOf([itemOf({ diff: `@@ -${"9".repeat(60)} +${"9".repeat(60)} @@\n+${"x".repeat(200)}\n` })]);
		for (const width of [20, 40, 80]) {
			for (const row of renderExecuteBody(cardState(wide), width, colorDeps())) {
				expect(stripAnsi(row).length, `width ${width}: ${stripAnsi(row)}`).toBeLessThanOrEqual(width);
			}
		}
	});
});

describe("the repl tool: what the three verbs mean, and what they refuse", () => {
	// --- pure policy, no kernel: this is the half index.ts cannot be tested for, and the half where a
	// --- wrong answer costs the reader a re-derivation. Every refusal below is asserted to name the
	// --- repair, because that is what makes a refusal a cheap correction instead of a tax. ---

	test("a bare repl call says which actions exist", () => {
		const d = validateReplParams({});
		expect(d.ok).toBe(false);
		if (!d.ok) expect(d.error).toContain("status | reload | restart");
	});

	test("a near-miss action is answered with the list, not with a shrug", () => {
		const d = validateReplParams({ action: "restar" });
		expect(d.ok).toBe(false);
		if (!d.ok) {
			expect(d.error).toContain('"restar"');
			expect(d.error).toContain("expected status | reload | restart");
		}
	});

	test("fresh on a non-restart is refused by name, because it would silently do nothing", () => {
		const d = validateReplParams({ action: "status", fresh: true });
		expect(d.ok).toBe(false);
		if (!d.ok) expect(d.error).toContain('only means anything with action "restart"');
	});

	test("fresh must be a boolean, and a long reason says by how much it is over", () => {
		const bad = validateReplParams({ action: "restart", fresh: "yes" });
		expect(!bad.ok && !bad.ok && bad.error).toContain("fresh must be a boolean");
		const long = validateReplParams({ action: "restart", reason: "x".repeat(201) });
		expect(!long.ok && !long.ok && long.error).toContain("201 chars");
	});

	test("a reason is trimmed and kept; a non-object params is refused", () => {
		const ok = validateReplParams({ action: "restart", reason: "  poisoned namespace  " });
		expect(ok.ok && ok.ok && ok.params.reason).toBe("poisoned namespace");
		const nope = validateReplParams(null);
		expect(!nope.ok && !nope.ok && nope.error).toContain("takes an object");
	});

	test("diffHelpers separates new, gone, changed and identical", () => {
		const adv = [
			{ name: "capture", description: "cap()" },
			{ name: "git", description: "old words" },
			{ name: "gone", description: "still advertised" },
		];
		const disk = [
			{ name: "capture", description: "cap()" },
			{ name: "git", description: "new words" },
			{ name: "fresh", description: "just added" },
		];
		const d = diffHelpers(adv, disk);
		expect(d.added).toEqual(["fresh"]);
		expect(d.removed).toEqual(["gone"]);
		expect(d.changed).toEqual(["git"]);
		expect(d.same).toBe(1);
		expect(isEmptyDrift(d)).toBe(false);
		expect(isEmptyDrift(diffHelpers(disk, disk))).toBe(true);
	});

	const facts = (over: Partial<StatusFacts> = {}): StatusFacts => ({
		replMode: true,
		engine: { running: true, forkInherited: false, restoreSkipped: false, hasSnapshotHistory: false, names: 12 },
		snapshot: { path: "/tmp/state/ns.snapshot", exists: true, ageMs: 5_000, bytes: 1234 },
		capture: { configuredDir: "", viewLines: 120 },
		helpers: {
			files: [
				{ name: "capture", description: "cap()", path: "/h/capture.py", bytes: 3181, mtimeMs: Date.now() },
				{ name: "novocab", description: "", path: "/h/novocab.py", bytes: 10, mtimeMs: Date.now() },
			],
			advertised: [{ name: "capture", chars: 8 }],
			blockChars: 400,
			advertisedAt: Date.now() - 60_000,
		},
		wire: { requests: 3, systemChars: 100, toolsChars: 200, payloadChars: 300, at: Date.now() },
		drift: { added: [], removed: [], changed: [], same: 1 },
		activeTools: ["execute", "read"],
		...over,
	});

	test("status reports drift by name, and says so plainly when there is none", () => {
		const drift: Drift = { added: ["fresh"], removed: [], changed: ["git"], same: 1 };
		const withDrift = formatStatus(facts({ drift }));
		expect(withDrift).toContain("DRIFT between advertised and disk");
		expect(withDrift).toContain("new on disk, not advertised yet: fresh");
		expect(withDrift).toContain("description changed: git");
		expect(formatStatus(facts())).toContain("advertised matches disk");
	});

	test("status never invents a wire measurement that has not happened", () => {
		expect(formatStatus(facts({ wire: null }))).toContain("measured on the wire: nothing yet this session");
		expect(formatStatus(facts({ wire: { requests: 0, systemChars: null, toolsChars: null, payloadChars: null, at: null } })))
			.toContain("nothing yet this session");
	});

	test("status distinguishes no snapshot from snapshots turned off", () => {
		expect(formatStatus(facts({ snapshot: null }))).toContain("snapshots are off for this session");
		expect(formatStatus(facts({ snapshot: { path: "/tmp/x", exists: false, ageMs: null, bytes: null } })))
			.toContain("none written yet");
	});

	test("status names a skipped revive, because that is the state that silently loses a namespace", () => {
		const s = formatStatus(facts({
			snapshot: { path: "/tmp/state/ns.snapshot", exists: false, ageMs: null, bytes: null },
			engine: { running: true, forkInherited: false, restoreSkipped: true, hasSnapshotHistory: true, names: 0 },
		}));
		expect(s).toContain("revive SKIPPED");
		expect(s).toContain("this conversation has a saved past");
	});

	test("status names the cell stream tee, on or off, because an off tee reads like a working one", () => {
		const on = formatStatus(facts({ capture: { configuredDir: "/tmp/pan-out", viewLines: 120, boot: { on: true, dir: "/tmp/pan-out", max_bytes: 33554432 } } }));
		expect(on).toContain("cell stream tee: ON");
		expect(on).toContain("/tmp/pan-out");
		expect(on).toContain("view bound 120 line(s)");
		const off = formatStatus(facts({ capture: { configuredDir: "", viewLines: 120, boot: { on: false, reason: "PI_REPL_CAPTURE_DIR is unset: cell streams are capped, not copied" } } }));
		expect(off).toContain("cell stream tee: OFF");
		expect(off).toContain("capped, not copied");
		// no kernel yet: the config is a wish, and status says it is unconfirmed rather than confirming it
		const unbooted = formatStatus(facts({ capture: { configuredDir: "/tmp/pan-out", viewLines: 60 } }));
		expect(unbooted).toContain("pi-repl.json asks for /tmp/pan-out");
		expect(unbooted).toContain("has not confirmed it");
	});

	test("status names the disagreement between the config and the bridge, in both directions", () => {
		// the failure mode I set myself up to hit tonight: a knob in pi-repl.json that the bridge never got
		const refused = formatStatus(facts({ capture: { configuredDir: "/tmp/pan-out", viewLines: 120, boot: { on: false, reason: "PAN_SESSION_STEM is unset" } } }));
		expect(refused).toContain("cell stream tee: OFF");
		expect(refused).toContain("PAN_SESSION_STEM is unset");
		expect(refused).toContain("pi-repl.json asks for /tmp/pan-out");
		const unasked = formatStatus(facts({ capture: { configuredDir: "", viewLines: 120, boot: { on: true, dir: "/elsewhere" } } }));
		expect(unasked).toContain("cell stream tee: ON");
		expect(unasked).toContain("set outside pi-repl.json");
	});

	test("restart always flushes first; only fresh skips the revive", () => {
		expect(planRestart({ action: "restart" })).toEqual({ flush: true, restore: true, fresh: false });
		expect(planRestart({ action: "restart", fresh: true })).toEqual({ flush: true, restore: false, fresh: true });
	});

	test("the marker says EMPTY when the namespace is empty, and names the undo path", () => {
		const plan = planRestart({ action: "restart", fresh: true });
		const m = restartMarker(plan, { saved: 40, failed: 2 }, null, "/tmp/state/ns.pre-restart", "poisoned namespace");
		expect(m).toContain("<repl_engine_reset>");
		expect(m).toContain("EMPTY namespace");
		expect(m).toContain("40 name(s) to the snapshot; 2 could not be serialized");
		expect(m).toContain("/tmp/state/ns.pre-restart");
		expect(m).toContain("Reason given: poisoned namespace");
		expect(m).toContain("repl restart (without fresh)");
		expect(m).toContain("</repl_engine_reset>");
	});

	test("the human's toast and the model's marker carry the same counts", () => {
		const plan = planRestart({ action: "restart" });
		const flushed = { saved: 12, failed: 0 };
		const revived = { restored: 12, failed: 0 };
		const toast = restartToast(plan, flushed, revived, "stale state");
		const marker = restartMarker(plan, flushed, revived, null, "stale state");
		expect(toast).toContain("12 flushed");
		expect(marker).toContain("12 name(s)");
		expect(toast).toContain("stale state");
		expect(restartToast(plan, null, null)).toContain("nothing flushed");
	});

	test("a restart refused mid-cell says what to do instead", () => {
		const n = restartBlockedNotice();
		expect(n).toContain("a cell is running right now");
		expect(n).toContain("Wait for the cell (or interrupt it)");
	});

	test("reload prefers the kernel's own verb and falls back to the sources the host just read", () => {
		const cell = reloadCell([{ name: "capture", source: "x = 1" }]);
		expect(cell).toContain("globals().get('helpers_reload')");
		expect(cell).toContain("host sources");
		expect(cell).toContain("x = 1");
		expect(formatReload("helpers_reload()", { restored: ["capture", "git"], failed: ["trimwatch: SyntaxError: x"] }, null, { added: [], removed: [], changed: [], same: 2 }, 400))
			.toContain("FAILED: trimwatch: SyntaxError: x");
		expect(formatReload("host sources", { restored: ["capture"], failed: [] }, null, { added: ["capture"], removed: [], changed: [], same: 0 }, 400))
			.toContain("advertised text CHANGED");
		expect(formatReload("host sources", null, "ValueError: boom", { added: [], removed: [], changed: [], same: 0 }, 0))
			.toContain("the reload cell raised ValueError: boom");
	});
});

describe("EngineLifecycle.restart: the engine half of the repl restart verb", () => {
	class Fake implements RevivableEngine {
		flushes = 0;
		discards = 0;
		boots: (boolean | undefined)[] = [];
		constructor(
			private readonly skip: boolean | undefined,
			private readonly log: string[],
		) {}
		async start(): Promise<void> {
			this.boots.push(this.skip);
			this.log.push(this.skip ? "boot:skip-restore" : "boot:restore");
		}
		restoreResult(): Promise<RestoreResult | null> {
			return Promise.resolve(null);
		}
		restoreWasSkipped(): boolean {
			return this.skip === true;
		}
		hasSnapshotHistory(): boolean {
			return false;
		}
		snapshotState() {
			this.flushes++;
			return Promise.resolve({ path: "/tmp/ns.snapshot", saved: ["kept"], failed: [] });
		}
	}

	const build = () => {
		const log: string[] = [];
		const created: Fake[] = [];
		const lc = new EngineLifecycle<Fake>({
			create: (skip?: boolean) => {
				const e = new Fake(skip, log);
				created.push(e);
				return e;
			},
			discard: async (e) => {
				e.discards++;
				log.push("discard");
			},
		} as EngineLifecycleDeps<Fake>);
		return { lc, log, created };
	};

	test("a restart flushes the live namespace before it tears the kernel down", async () => {
		const { lc, log, created } = build();
		await lc.acquire("cell", "conv");
		const first = created[0];
		const r = await lc.restart({ flush: true, restore: true }, "conv");
		expect(r.flushed?.saved).toEqual(["kept"]);
		expect(first.flushes).toBe(1);
		// the first entry is the acquire() boot; the restart's own sequence is discard → boot, and the
		// flush landed before the discard (asserted by `first.flushes === 1` on the live engine)
		expect(log).toEqual(["boot:restore", "discard", "boot:restore"]);
		expect(first.discards).toBe(1);
	});

	test("fresh restart boots an empty kernel, and the skip belongs to that kernel from then on", async () => {
		const { lc, log, created } = build();
		await lc.acquire("cell", "conv");
		await lc.restart({ flush: true, restore: false }, "conv");
		expect(log).toEqual(["boot:restore", "discard", "boot:skip-restore"]);
		expect(created[1].restoreWasSkipped()).toBe(true);
	});

	test("restart works when no engine is running, and reports nothing flushed", async () => {
		const { lc, created } = build();
		const r = await lc.restart({ flush: true, restore: true }, "conv");
		expect(r.flushed).toBeNull();
		expect(created.length).toBe(1);
		await lc.acquire("cell", "conv");
		expect(created[0].flushes).toBe(0);
	});

	test("current looks without booting, which is what makes repl status read-only", async () => {
		const { lc, created } = build();
		expect(lc.current).toBeUndefined();
		expect(created.length).toBe(0);
		await lc.acquire("cell", "conv");
		expect(lc.current).toBe(created[0]);
	});
});
