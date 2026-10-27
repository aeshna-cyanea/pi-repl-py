/**
 * engine.integration.test.ts — the real host ↔ real ipykernel seam.
 *
 * These are the guarantees the Python guest contract suite (guest_contract.py)
 * used to pin: persistence across cells, error survival, output attribution,
 * helpers loading, snapshot/restore round-trips, output caps, and the per-cell
 * silence timeout. The guest.py middleman is gone; the host now speaks the
 * Jupyter protocol directly, so the same guarantees are proven here against a
 * real kernel — each test boots one or more genuine ipykernel subprocesses,
 * which is why this suite is slow and kept out of `just check`.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { EngineManager } from "../src/engine/index.ts";
import { EngineLifecycle, formatForkToast } from "../src/extension/session-engine.ts";
import { inheritForkSnapshot, resolveStateDir } from "../src/extension/state-layout.ts";

const tempDirs: string[] = [];
const engines: EngineManager[] = [];

function tempDir(): string {
	const d = mkdtempSync(join(tmpdir(), "pi-repl-int-"));
	tempDirs.push(d);
	return d;
}

/**
 * Helper isolation. A kernel built with no env override resolves helpers from the OPERATOR's real
 * `~/.pi/agent/pi-repl/helpers` (helpers-locate.ts falls back to it), so on any box that actually has
 * helpers — mine does — every snapshot test suddenly snapshots somebody else's namespace. That was
 * silently costing two red tests: "bindings skipped at save time" found `Git`, `G` and `cap` in
 * `saved` instead of the test's own `kept`, and the /fork'd test revived 60 names including four
 * functions that cannot be pickled. Same class as the units-suite isolation fix, one layer down.
 * Tests that mean to exercise helper resolution pass PI_HELPERS_DIR / PI_HELPERS_GLOBAL_DIR
 * themselves; this default only covers the ones that never meant to load helpers at all.
 */
let isolatedHelpersDir: string | undefined;
function isolatedHelpers(): string {
	if (isolatedHelpersDir === undefined) isolatedHelpersDir = mkdtempSync(join(tmpdir(), "pi-repl-nohelpers-"));
	return isolatedHelpersDir;
}

function withHelperIsolation(opts: Record<string, unknown>): Record<string, unknown> {
	const given = (opts.env ?? {}) as Record<string, unknown>;
	if (given.PI_HELPERS_DIR !== undefined || given.PI_HELPERS_GLOBAL_DIR !== undefined) return opts;
	return { ...opts, env: { ...given, PI_HELPERS_GLOBAL_DIR: isolatedHelpers() } };
}

/**
 * Bootstrap isolation, same reasoning one layer over: the default injected line is the OPERATOR's
 * package, so on my box every test would boot 122 of my verbs. Tests that mean to exercise the
 * bootstrap pass PI_REPL_BOOTSTRAP themselves; this default covers the ones that never meant to run
 * boot-time code at all. An empty string is the documented off switch, not a missing value.
 */
function withBootIsolation(opts: Record<string, unknown>): Record<string, unknown> {
	const given = (opts.env ?? {}) as Record<string, unknown>;
	if (given.PI_REPL_BOOTSTRAP !== undefined) return opts;
	return { ...opts, env: { ...given, PI_REPL_BOOTSTRAP: "" } };
}

function engine(opts: Record<string, unknown>) {
	const m = new EngineManager(withBootIsolation(withHelperIsolation(opts)) as never);
	engines.push(m);
	return m;
}

/**
 * Scale a deadline to this machine's measured kernel cold-boot cost. The timing-sensitive
 * tests (reaper, silence watchdog) assume a warm x86 laptop; on a slow interpreter host
 * (Termux/Android, loaded CI) the same absolute deadlines flake. The cost that matters is
 * `import ipykernel`, not process spawn; one measurement, cached.
 */
let bootFactorCache: number | undefined;
function slowFactor(baseMs: number): number {
	if (bootFactorCache === undefined) {
		const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
		const py = process.env.PYTHON ?? `${process.env.HOME}/.pi/agent/pi-repl/venv/bin/python3`;
		const t0 = Date.now();
		const r = spawnSync(py, ["-c", "import ipykernel"], { timeout: 30_000 });
		const cold = Date.now() - t0;
		if (r.status !== 0) return baseMs; // measurement failed: keep the base deadline
		// a healthy laptop imports ipykernel in <1s; Termux takes ~2s. Scale linearly against
		// the 1s baseline, clamped to [1x, 8x] so neither extreme runs away.
		bootFactorCache = Math.min(8, Math.max(1, cold / 1000));
	}
	return Math.round(baseMs * bootFactorCache);
}

// --- kernels must not outlive their test: the watchdog assertions are timing-sensitive,
// --- and a pile of idle ipykernel processes from earlier tests starves the CPU enough to
// --- push inter-beat gaps past the silence window, flaking "output keeps the watchdog fed"
// --- into a false kill. Each test therefore runs against a quiet machine; afterAll remains
// --- only as a safety net for engines created outside a test body. ---
afterEach(async () => {
	await Promise.allSettled(engines.splice(0).map((m) => m.kill().catch(() => {})));
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

afterAll(async () => {
	await Promise.allSettled(engines.splice(0).map((m) => m.kill()));
	for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	if (isolatedHelpersDir !== undefined) rmSync(isolatedHelpersDir, { recursive: true, force: true });
});

describe("host × python-kernel integration", () => {
	test("variables and functions survive across cells", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const m = engine({ cwd: d });

		const r1 = await m.execute("x = 10");
		expect(r1.status).toBe("ok");
		const r2 = await m.execute("def double(n): return n * 2");
		expect(r2.status).toBe("ok");
		const r3 = await m.execute("print('x is', x, 'double is', double(x))");
		expect(r3.status).toBe("ok");
		expect(r3.stdout).toContain("x is 10");
		expect(r3.stdout).toContain("20");
	});

	/**
	 * The kernel is TOLD which conversation it is in, and the telling is one env hop: create() sets
	 * PAN_SESSION_STEM from conversationName(sessionFile), the bridge spawns ipykernel with the host's env,
	 * and the guest reads it. Pinned here because nothing else in this suite proves that hop exists, and
	 * the keep tier depends on it: it is what lets a capture be filed under its own session without the
	 * kernel guessing at "newest .jsonl by mtime" -- the guess that named the wrong session, with two Pi
	 * instances live, on 2026-10-13.
	 */
	test("the host's session key reaches the guest's os.environ", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const m = engine({ cwd: d, env: { PAN_SESSION_STEM: "2026-01-01T00-00-00-000Z_deadbeef" } });
		const r = await m.execute("import os; print('STEM=[' + str(os.environ.get('PAN_SESSION_STEM')) + ']')");
		expect(r.status).toBe("ok");
		expect(r.stdout).toContain("STEM=[2026-01-01T00-00-00-000Z_deadbeef]");
	});

	test(
		"a deleted session cwd does not prevent the kernel from booting (cwd fallback)",
		{ timeout: 60_000 },
		async () => {
			const d = tempDir();
			const m = engine({ cwd: d });
			// the resume case the fallback exists for: the project dir is gone by boot time
			rmSync(d, { recursive: true, force: true });
			const r = await m.execute(`import os
print(os.getcwd() != ${JSON.stringify(d)})`);
			expect(r.status).toBe("ok");
			expect(r.stdout).toContain("True");
		},
	);

	test("a raising cell reports a real traceback and does not kill the namespace", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const m = engine({ cwd: d });

		await m.execute("x = 7");
		const bad = await m.execute("1 / 0");
		expect(bad.status).toBe("error");
		expect(bad.error?.name).toBe("ZeroDivisionError");
		expect((bad.error?.stack ?? []).join("\n")).toContain("ZeroDivisionError");

		const ok = await m.execute("y = x + 1");
		expect(ok.status).toBe("ok");
		const print = await m.execute("print(y)");
		expect(print.stdout).toContain("8");
	});

	test("only printed output and the final result return", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const m = engine({ cwd: d });

		const assign = await m.execute("z = 100");
		expect(assign.status).toBe("ok");
		expect(assign.stdout).toBe("");
		expect(assign.result).toBeUndefined();

		const print = await m.execute("print('saw', z)");
		expect(print.stdout).toContain("saw 100");
		const result = await m.execute("z * 2");
		expect(result.result).toBeDefined();
		expect(result.result).toContain("200");
	});

	test(
		"a big unbound result is bounded on its own budget, and the marker names the true total",
		{ timeout: 60_000 },
		async () => {
			const d = tempDir();
			const m = engine({ cwd: d });
			// the exact probe measured 2026-10-15: this cell echoed 11,399 chars, and a trailing `;` did not help
			// A str result arrives as its repr, so a 300-line string is ONE line of \n escapes and the
			// line budget cannot fire on it — the char budget does. chr(10) rather than a backslash
			// escape because this test already failed once on its own escaping.
			const big = await m.execute("chr(10).join('line %03d of a deliberately long value' % i for i in range(300))");
			expect(big.status).toBe("ok");
			expect(big.result).toBeDefined();
			expect(big.result!.length).toBeLessThan(6_000);
			expect(big.result).toContain("result bounded");
			expect(big.result).toMatch(/chars total, cut at \d+ chars/);
			expect(big.result).toContain("assign it");
			// the line budget needs a result that is genuinely multi-line, which repr() of a str never is
			const many = await m.execute(
				["class Many:", "    def __repr__(self): return chr(10).join('line %03d' % i for i in range(300))", "Many()"].join("\n"),
			);
			expect(many.status).toBe("ok");
			expect(many.result).toMatch(/showed \d+ of 300 lines/);
			expect(many.result!.split("\n").length).toBeLessThanOrEqual(41);
			// the kernel is the archive: bind the value and it is whole in the next cell
			const bound = await m.execute("v = chr(10).join('line %03d' % i for i in range(300))\nv.count(chr(10))");
			expect(bound.result).toContain("299");
		},
	);

	test(
		"no pi-repl discovery intrinsics are injected; the workspace is standard Python",
		{ timeout: 60_000 },
		async () => {
			const d = tempDir();
			// hermetic helpers dir: nothing preloaded
			const m = engine({ cwd: d, env: { PI_HELPERS_DIR: tempDir() } });

			// The custom ls() intrinsic is gone: 'ls' is not in the namespace, and no
			// pi/helper-specific symbol was injected — discovery is ordinary Python.
			const ls = await m.execute("print('ls' in globals())");
			expect(ls.status).toBe("ok");
			expect(ls.stdout).toContain("False");

			// Standard introspection stays available (the builtin help() stands in for
			// the old helper-usage helper).
			const intro = await m.execute("print(callable(help), len(globals()) >= 0)");
			expect(intro.status).toBe("ok");
			expect(intro.stdout).toContain("True");
		},
	);

	test(
		"a custom helper file loads into the kernel and appears under plain Python globals()",
		{ timeout: 60_000 },
		async () => {
			const d = tempDir();
			const helpers = tempDir();
			writeFileSync(join(helpers, "double.py"), "def double(n):\n    return n * 2\n");
			const m = engine({ cwd: d, env: { PI_HELPERS_DIR: helpers } });

			const r = await m.execute("print(double(21))");
			expect(r.status).toBe("ok");
			expect(r.stdout).toContain("42");

			const ns = await m.execute("print([k for k in globals() if k == 'double'])");
			expect(ns.status).toBe("ok");
			expect(ns.stdout).toContain("double");
			for (const stale of ["shell", "edit", "read", "write", "bash"]) {
				expect(ns.stdout).not.toContain(stale);
			}
		},
	);

	test("a project helper shadows the same-named global helper inside the kernel", { timeout: 60_000 }, async () => {
		// project .pi/helpers/web.py wins over global web.py — by VALUE in the live kernel,
		// proving the prompt list and the preload agree on the merged set.
		const global = tempDir();
		writeFileSync(join(global, "web.py"), "def web():\n    return 'GLOBAL'\n");
		const proj = tempDir();
		mkdirSync(join(proj, ".pi", "helpers"), { recursive: true });
		writeFileSync(join(proj, ".pi", "helpers", "web.py"), "def web():\n    return 'PROJECT'\n");

		const m = engine({ cwd: proj, env: { PI_HELPERS_GLOBAL_DIR: global } });
		const r = await m.execute("print(web())");
		expect(r.status).toBe("ok");
		expect(r.stdout).toContain("PROJECT");
		expect(r.stdout).not.toContain("GLOBAL");
	});

	test("global helpers still load when the project has none, from a deep cwd", { timeout: 60_000 }, async () => {
		const global = tempDir();
		writeFileSync(join(global, "grid.py"), "def grid():\n    return 'G'\n");
		const proj = tempDir();
		mkdirSync(join(proj, ".git"), { recursive: true });
		mkdirSync(join(proj, ".pi", "helpers"), { recursive: true });
		writeFileSync(join(proj, ".pi", "helpers", "core.py"), "def core():\n    return 'C'\n");
		// deep cwd WITHOUT a local .pi/helpers: project helper at root + global helper both reach the kernel
		const deep = join(proj, "src", "tools");
		mkdirSync(deep, { recursive: true });

		const m = engine({ cwd: deep, env: { PI_HELPERS_GLOBAL_DIR: global } });
		const r = await m.execute("print(core(), grid())");
		expect(r.status).toBe("ok");
		expect(r.stdout).toContain("C G");
	});

	test(
		"a broken helper fails alone: the others still load, and the boot report names it",
		{ timeout: 60_000 },
		async () => {
			const d = tempDir();
			const helpers = tempDir();
			writeFileSync(join(helpers, "scraper.py"), "def scraper(\n"); // SyntaxError
			writeFileSync(join(helpers, "double.py"), "def double(n):\n    return n * 2\n");
			const m = engine({ cwd: d, env: { PI_HELPERS_DIR: helpers } });

			const r = await m.execute("print('has double:', 'double' in globals())");
			expect(r.status).toBe("ok");
			expect(r.stdout).toContain("has double: True"); // the sibling helper survived

			const report = m.takeHelperReport();
			expect(report).not.toBeNull();
			expect(report!.length).toBe(2); // alphabetical: double loads, scraper fails
			const double = report!.find((h) => h.name === "double");
			const scraper = report!.find((h) => h.name === "scraper");
			expect(double?.ok).toBe(true);
			expect(scraper?.ok).toBe(false);
			// CPython 3.13 raises _IncompleteInputError (a SyntaxError subclass, so the ename no
			// longer contains "SyntaxError") for unclosed brackets; older interpreters raise plain
			// SyntaxError. The point is the helper failed to parse and the failure is named.
			expect(scraper?.error).toMatch(/(_IncompleteInputError|^SyntaxError|incomplete input)/);

			// the report is handed out exactly once per boot
			expect(m.takeHelperReport()).toBeNull();
		},
	);

	test(
		"an all-good boot reports every helper loaded and stays quiet on the second take",
		{ timeout: 60_000 },
		async () => {
			const d = tempDir();
			const helpers = tempDir();
			writeFileSync(join(helpers, "web.py"), "def web():\n    return 'W'\n");
			writeFileSync(join(helpers, "core.py"), "def core():\n    return 'C'\n");
			const m = engine({ cwd: d, env: { PI_HELPERS_DIR: helpers } });

			await m.execute("1 + 1"); // settle the boot, then take the report
			const report = m.takeHelperReport();
			expect(report).not.toBeNull();
			expect(report!.filter((h) => h.ok).map((h) => h.name)).toEqual(["core", "web"]);
			expect(report!.some((h) => !h.ok)).toBe(false);
			expect(m.takeHelperReport()).toBeNull();
		},
	);

	test(
		"the bootstrap runs BEFORE the helper preload, and a helper reads and then wins on its name",
		{ timeout: 60_000 },
		async () => {
			// Key 221 step 2's invariant, as a fact about the running kernel rather than a comment.
			// The helper file reads `boot_marker` at module level: if the preload ran first this is a
			// NameError and the helper fails to load. Reading it and then rebinding it proves both halves
			// of the invariant -- the bootstrap lands first, and the helper gets the last word.
			const d = tempDir();
			const helpers = tempDir();
			writeFileSync(
				join(helpers, "reader.py"),
				"boot_marker = boot_marker + '+HELPER'\ndef marker():\n    return boot_marker\n",
			);
			const m = engine({
				cwd: d,
				env: { PI_HELPERS_DIR: helpers, PI_REPL_BOOTSTRAP: "boot_marker = 'BOOT'" },
			});

			const r = await m.execute("print(marker())");
			expect(r.status).toBe("ok");
			expect(r.stdout.trim()).toBe("BOOT+HELPER");

			// a bootstrap that SUCCEEDS adds no entry to the helper report: the report stays a list of
			// helpers, and only a failure earns a line
			const report = m.takeHelperReport();
			expect(report!.some((h) => h.name === "bootstrap")).toBe(false);
		},
	);

	test(
		"a bootstrap that raises takes nothing with it: the helpers load, and the report names it",
		{ timeout: 60_000 },
		async () => {
			const d = tempDir();
			const helpers = tempDir();
			writeFileSync(join(helpers, "double.py"), "def double(n):\n    return n * 2\n");
			const m = engine({
				cwd: d,
				env: { PI_HELPERS_DIR: helpers, PI_REPL_BOOTSTRAP: "raise RuntimeError('no bootstrap today')" },
			});

			const r = await m.execute("print(double(21))");
			expect(r.status).toBe("ok");
			expect(r.stdout.trim()).toBe("42"); // the session works on the helpers alone

			const report = m.takeHelperReport();
			const boot = report!.find((h) => h.name === "bootstrap");
			expect(boot?.ok).toBe(false);
			expect(boot?.error).toContain("no bootstrap today");
			expect(report!.find((h) => h.name === "double")?.ok).toBe(true);
		},
	);

	test(
		"what the bootstrap binds is not snapshotted: the package comes back on every boot",
		{ timeout: 60_000 },
		async () => {
			// Same rule that keeps the helper names out of the namespace file. Without it the bootstrap's
			// verbs eat the same byte cap my real bindings share, and `saved` stops being a list of state.
			const d = tempDir();
			const snap = { path: join(d, "ns.snapshot"), debounceMs: 200 };
			const m = engine({ cwd: d, snapshot: snap, env: { PI_REPL_BOOTSTRAP: "boot_only = 1" } });

			await m.execute("mine = 3");
			const saved = await m.snapshotState();
			expect(saved?.saved).toContain("mine");
			expect(saved?.saved).not.toContain("boot_only");

			// and the name is still live in the kernel -- the exclusion is from the snapshot, not from the run
			const r = await m.execute("print(boot_only)");
			expect(r.stdout.trim()).toBe("1");
		},
	);

	test(
		"a fresh engine serves the first cell before the quiet-gap restore; the restore then lands",
		{ timeout: 90_000 },
		async () => {
			const d = tempDir();
			const snap = { path: join(d, "ns.snapshot"), debounceMs: 200 };
			const m1 = engine({ cwd: d, snapshot: snap });
			await m1.execute("saved = {'a': 42, 'big': list(range(200_000))}");
			await m1.snapshotState();
			await m1.kill();

			const m2 = engine({ cwd: d, snapshot: snap });
			// recovery is a background quiet-gap job: the first cell is served on the freshly
			// booted kernel and must NOT wait for the restore (the restore is armed only to fire
			// when the kernel is idle, so it can never be ahead of this cell)
			const first = await m2.execute("print('early', 'saved' in globals())");
			expect(first.status).toBe("ok");
			expect(first.stdout).toContain("early");
			expect(first.stdout).toContain("False"); // not revived yet — and the cell didn't block on it

			// the restore lands in the quiet gap and the name goes live
			const deadline = Date.now() + 30_000;
			let seen = false;
			while (Date.now() < deadline && !seen) {
				await new Promise((resolve) => setTimeout(resolve, 250));
				const r = await m2.execute("print('saved' in globals())");
				seen = r.stdout.includes("True");
			}
			expect(seen).toBe(true);
			const check = await m2.execute("print(saved['a'])");
			expect(check.status).toBe("ok");
			expect(check.stdout).toContain("42");
		},
	);

	test("a variable set in one engine survives restart via the snapshot file", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const snap = { path: join(d, "ns.snapshot"), debounceMs: 200 };
		const m1 = engine({ cwd: d, snapshot: snap });

		const r1 = await m1.execute("saved = {'a': 42, 'b': 'hello'}");
		expect(r1.status).toBe("ok");

		// wait for the debounced auto-snapshot to fire
		await new Promise((resolve) => setTimeout(resolve, 800));
		await m1.snapshotState();

		const m2 = engine({ cwd: d, snapshot: snap });
		const restore = await m2.restoreState();
		expect(restore?.restored).toContain("saved");

		const r2 = await m2.execute("print(saved['a'], saved['b'])");
		expect(r2.status).toBe("ok");
		expect(r2.stdout).toContain("42");
		expect(r2.stdout).toContain("hello");
	});

	test(
		"bindings skipped at save time are named in the resume result, not dropped silently",
		{ timeout: 60_000 },
		async () => {
			const d = tempDir();
			// tiny caps: the huge binding exceeds the per-entry cap and is skipped AT SAVE time
			const snap = { path: join(d, "ns.snapshot"), debounceMs: 200, maxBytes: 1000 };
			const m1 = engine({ cwd: d, snapshot: snap });

			const r1 = await m1.execute("import os\nhuge = os.urandom(5000)\nkept = {'k': 1}");
			expect(r1.status).toBe("ok");
			const saved = await m1.snapshotState();
			expect(saved?.saved).toContain("kept");
			expect(saved?.failed.find((f) => f.name === "huge")?.reason).toContain("cap");

			const m2 = engine({ cwd: d, snapshot: snap });
			const restore = await m2.restoreState();
			expect(restore?.restored).toContain("kept");
			// the save-time skip surfaces in the restore result (and thus the resume notice),
			// which previously only named failures that happened again during restore
			expect(restore?.failed.some((f) => f.name === "huge")).toBe(true);
			const r2 = await m2.execute("print('huge' in globals(), kept['k'])");
			expect(r2.status).toBe("ok");
			expect(r2.stdout).toContain("False");
			expect(r2.stdout).toContain("1");
		},
	);

	test("same-name mutations survive a crash via the periodic refresh", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const snap = { path: join(d, "ns.snapshot"), debounceMs: 50, periodMs: 200 };
		const m1 = engine({ cwd: d, snapshot: snap });

		const r1 = await m1.execute("data = {'k': 1}");
		expect(r1.status).toBe("ok");
		// name-change snapshot lands
		await new Promise((resolve) => setTimeout(resolve, 500));

		// in-place mutation: names unchanged, so only the staleness clock can re-arm
		const r2 = await m1.execute("data['k'] = 42");
		expect(r2.status).toBe("ok");
		// the period elapses; the first cell after it sees the stale clock and refreshes
		await new Promise((resolve) => setTimeout(resolve, 700));
		const r3 = await m1.execute("1 + 1");
		expect(r3.status).toBe("ok");
		await new Promise((resolve) => setTimeout(resolve, 500));
		await m1.kill(); // crash path: no dispose flush — only the forced refresh can save it

		const m2 = engine({ cwd: d, snapshot: snap });
		const restore = await m2.restoreState();
		expect(restore?.restored).toContain("data");
		const r4 = await m2.execute("print(data['k'])");
		expect(r4.status).toBe("ok");
		expect(r4.stdout).toContain("42");
	});

	test("snapshot files are version 4 with zlib-compressed cloudpickle payloads", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const snap = { path: join(d, "ns.snapshot"), debounceMs: 200 };
		const m1 = engine({ cwd: d, snapshot: snap });
		await m1.execute("payload_v = {'a': 1}");
		await m1.snapshotState();
		const file = JSON.parse(readFileSync(snap.path, "utf8")) as {
			version: number;
			entries: { name: string; kind: string; payload: string }[];
		};
		// v4 = cloudpickle by value (functions/classes need no source capture); v1-v3 still restore
		expect(file.version).toBe(4);
		const entry = file.entries.find((e) => e.name === "payload_v");
		expect(entry).toBeDefined();
		// the payload must be a zlib stream (a raw pickle would fail to decompress)
		expect(inflateSync(Buffer.from(entry!.payload, "base64")).length).toBeGreaterThan(0);
	});

	test("a version 2 snapshot file (plain pickles) still restores", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const snap = { path: join(d, "ns.snapshot"), debounceMs: 200 };
		const m1 = engine({ cwd: d, snapshot: snap });
		await m1.execute("legacy = {'v': 7}");
		await m1.snapshotState();
		// downgrade the file to the pre-compression format: unwrap each value payload to the raw pickle
		const file = JSON.parse(readFileSync(snap.path, "utf8")) as {
			version: number;
			entries: { name: string; kind: string; payload: string }[];
			failed: unknown[];
		};
		expect(file.version).toBe(4);
		for (const e of file.entries) {
			if (e.kind === "value") {
				const raw = inflateSync(Buffer.from(e.payload, "base64"));
				e.payload = Buffer.from(raw).toString("base64");
			}
		}
		file.version = 2;
		writeFileSync(snap.path, JSON.stringify(file));

		const m2 = engine({ cwd: d, snapshot: snap });
		const restore = await m2.restoreState();
		expect(restore?.restored).toContain("legacy");
		const r = await m2.execute("print(legacy['v'])");
		expect(r.status).toBe("ok");
		expect(r.stdout).toContain("7");
	});

	test("a /fork'd conversation inherits the parent's namespace and restores it", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const sessionsRoot = mkdtempSync(join(tmpdir(), "pi-repl-fork-int-"));
		tempDirs.push(sessionsRoot);
		const slugDir = join(sessionsRoot, "proj-a");
		mkdirSync(slugDir, { recursive: true });
		const parentFile = join(slugDir, "parent.jsonl");
		const forkFile = join(slugDir, "forked.jsonl");
		const stateRoot = join(d, "state");

		// parent session: real engine, real snapshot
		const parentSnap = resolveStateDir(stateRoot, parentFile).snapshotPath;
		const m1 = engine({ cwd: d, snapshot: { path: parentSnap, debounceMs: 200 } });
		await m1.execute("inherited = {'fork': 'yes', 'n': 42}");
		await m1.snapshotState();
		await m1.kill();

		// the fork: pi-style header naming the parent, then the inherit pass
		writeFileSync(parentFile, '{"type":"session","version":3,"id":"parent"}\n');
		writeFileSync(forkFile, JSON.stringify({ type: "session", version: 3, id: "forked", parentSession: parentFile }));
		const forkSnap = resolveStateDir(stateRoot, forkFile).snapshotPath;
		expect(existsSync(forkSnap)).toBe(false);
		inheritForkSnapshot(stateRoot, forkFile, forkSnap);

		// the fork's engine restores like any resume: same revive, same notice path
		const m2 = engine({ cwd: d, snapshot: { path: forkSnap, debounceMs: 200 } });
		const restore = await m2.restoreState();
		expect(restore?.restored).toContain("inherited");
		const r = await m2.execute("print(inherited['fork'], inherited['n'])");
		expect(r.status).toBe("ok");
		expect(r.stdout).toContain("yes");
		expect(r.stdout).toContain("42");
	});

	test(
		"a /fork'd conversation carries the reset marker on its first cell, like any resume",
		{ timeout: 90_000 },
		async () => {
			const d = tempDir();
			const sessionsRoot = mkdtempSync(join(tmpdir(), "pi-repl-fork-lc-"));
			tempDirs.push(sessionsRoot);
			const slugDir = join(sessionsRoot, "proj-a");
			mkdirSync(slugDir, { recursive: true });
			const parentFile = join(slugDir, "parent.jsonl");
			const forkFile = join(slugDir, "forked.jsonl");
			const stateRoot = join(d, "state");

			const parentSnap = resolveStateDir(stateRoot, parentFile).snapshotPath;
			const m1 = engine({ cwd: d, snapshot: { path: parentSnap, debounceMs: 200 } });
			await m1.execute("forked_data = {'from': 'parent'}");
			await m1.snapshotState();
			await m1.kill();

			writeFileSync(parentFile, '{"type":"session","version":3,"id":"parent"}\n');
			writeFileSync(forkFile, JSON.stringify({ type: "session", version: 3, id: "forked", parentSession: parentFile }));
			const forkSnap = resolveStateDir(stateRoot, forkFile).snapshotPath;
			expect(inheritForkSnapshot(stateRoot, forkFile, forkSnap)).toBe(true);

			// the lifecycle path, exactly as index.ts drives it
			const lifecycle = new EngineLifecycle<EngineManager>({
create: () =>
					new EngineManager(withHelperIsolation({ cwd: d, snapshot: { path: forkSnap, debounceMs: 100 }, forkInherited: true }) as never),
				dispose: async (e) => e.kill(),
			});
			const { engine: m2 } = await lifecycle.acquire("startup", "fork-conv");

			// the restore lands in the quiet gap and the marker follows it
			const deadline = Date.now() + 30_000;
			let revived = false;
			while (Date.now() < deadline && !revived) {
				await new Promise((resolve) => setTimeout(resolve, 250));
				const r = await m2.execute("print('forked_data' in globals())");
				revived = r.stdout.includes("True");
			}
			expect(revived).toBe(true);
			expect(m2.inheritedFromFork).toBe(true);

			const reset = lifecycle.takeResetNotice();
			expect(reset?.notice).toContain("<repl_engine_reset>");
			expect(reset?.notice).toContain("forked_data");
			expect(formatForkToast(reset?.restore ?? null)).toContain("fork started");
			expect(formatForkToast(reset?.restore ?? null)).toContain("1 name inherited");

			await lifecycle.shutdown();
		},
	);

	test(
		"a snapshot whose revive wedges is skipped in the background and the session still starts",
		{ timeout: 240_000 },
		async () => {
			const d = tempDir();
			const snap = { path: join(d, "ns.snapshot"), debounceMs: 200 };
			const m1 = engine({ cwd: d, snapshot: snap });
			// __setstate__ sleeps forever, so unpickling this value during restore wedges the kernel
			const r1 = await m1.execute(
				"class W:\n    def __setstate__(self, state):\n        import time\n        time.sleep(60)\n    def __init__(self):\n        self.x = 1\nw = W()",
			);
			expect(r1.status).toBe("ok");
			await new Promise((resolve) => setTimeout(resolve, 800));
			await m1.snapshotState();

			// the boot deadline bounds kernel start + helpers preload; the restore cell has its own
			// engine-level watchdog (same env var), and the lifecycle skips reviving after the boot
			// deadline trips. Both get a short deadline so the wedge is detected fast. On a slow
			// machine (Termux) even kernel START can outlive the default deadline, so the deadline
			// scales with the interpreter's measured cold-boot cost.
			const bootDeadline = slowFactor(8_000);
			const lc = new EngineLifecycle<EngineManager>({
				create: (skip) =>
					engine({
						cwd: d,
						snapshot: snap,
						skipRestore: skip,
						env: { PI_REPL_BOOT_TIMEOUT_MS: String(Math.round(bootDeadline * 0.375)) },
					}),
				async dispose(m) {
					await m.dispose();
				},
				async discard(m) {
					await m.kill();
				},
				bootTimeoutMs: bootDeadline,
			});
			const started = Date.now();
			const { engine: m2, restore } = await lc.acquire("cell");
			// recovery is async: acquire returns after BOOT, not after the wedged restore settles
			expect(Date.now() - started).toBeLessThan(bootDeadline + 7_000);
			expect(restore).toBe(null);

			// the poisoned revive is detected in the background: the reaper kills the wedged kernel
			// and the engine marks the restore skipped; the announcement follows once that settles
			const noticeDeadline = Date.now() + slowFactor(30_000);
			let notice: ReturnType<typeof lc.takeResetNotice> | undefined;
			while (Date.now() < noticeDeadline && !notice) {
				notice = lc.takeResetNotice();
				if (!notice) await new Promise((resolve) => setTimeout(resolve, 200));
			}
			expect(notice?.notice).toContain("wedged");
			expect(notice?.notice).toContain("skipped");
			expect(notice?.restore).toBe(null);
			expect(notice?.wedged).toBe(true);

			// the replacement kernel serves cells and never re-touches the poisoned snapshot
			const r2 = await m2.execute("2 + 2");
			expect(r2.status).toBe("ok");
			expect(r2.result).toContain("4");
			// the wedge was skipped once, not retried: the namespace stays empty but alive
			const r3 = await m2.execute("print('w' in globals())");
			expect(r3.status).toBe("ok");
			expect(r3.stdout).toContain("False");
		},
	);

	test(
		"a cell-defined function and class survive restart (cloudpickle serializes them by value)",
		{ timeout: 90_000 },
		async () => {
			const d = tempDir();
			const snap = { path: join(d, "ns.snapshot"), debounceMs: 200 };
			const m1 = engine({ cwd: d, snapshot: snap });
			const r1 = await m1.execute(
				"def greet(name):\n    return f'hi {name}'\nclass Box:\n    def __init__(self, v):\n        self.v = v\nitem = 41",
			);
			expect(r1.status).toBe("ok");
			await m1.snapshotState();
			await m1.kill();
			const m2 = engine({ cwd: d, snapshot: snap });
			const restore = await m2.restoreState();
			expect(restore?.restored).toContain("greet");
			expect(restore?.restored).toContain("Box");
			expect(restore?.restored).toContain("item");
			const r2 = await m2.execute("print(greet('tester'))");
			expect(r2.status).toBe("ok");
			expect(r2.stdout).toContain("hi tester");
			const r3 = await m2.execute("print(Box(7).v)");
			expect(r3.stdout).toContain("7");
		},
	);

	test("snapshot excludes helper metadata and flags completeness", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const helpers = tempDir();
		writeFileSync(
			join(helpers, "web.py"),
			'helper_description = """web(query) — stub."""\ndef web(query):\n    return query\n',
		);
		const snap = { path: join(d, "ns.snapshot"), debounceMs: 200 };
		const m = engine({ cwd: d, env: { PI_HELPERS_DIR: helpers }, snapshot: snap });

		await m.execute("data = {'count': 42}");
		const result = await m.snapshotState();
		expect(result?.saved).toContain("data");
		expect(result?.saved).not.toContain("helper_description");
		expect(result?.saved).not.toContain("web"); // helpers are kernel-side, not user state
	});

	test("a pending snapshot never lands in front of a queued user cell", { timeout: 90_000 }, async () => {
		const d = tempDir();
		const snap = { path: join(d, "ns.snapshot"), debounceMs: 150 };
		const m = engine({ cwd: d, snapshot: snap });

		await m.execute("x = 1");
		// A name change arms the debounced snapshot; the pickle is heavy (seconds
		// for a multi-million-element namespace), so queue position decides latency.
		await m.execute("big = list(range(3_000_000))");

		// The debounce expires inside these cells. The snapshot must wait for a
		// quiet gap instead of pickling ahead of the trivial third cell.
		const r2 = await m.execute("import time; time.sleep(0.3); print('mid')");
		const start = Date.now();
		const r3 = await m.execute("print('here')");
		expect(r2.status).toBe("ok");
		expect(r2.stdout).toContain("mid");
		expect(r3.status).toBe("ok");
		expect(r3.stdout).toContain("here");
		// Old behaviour left the trivial cell waiting behind a ~2s pickle.
		expect(Date.now() - start).toBeLessThan(1_000);

		// Once the kernel goes quiet the snapshot still lands.
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		expect(existsSync(snap.path)).toBe(true);
	});

	test("restore reports failed values without crashing the kernel", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const snap = { path: join(d, "ns.snapshot"), debounceMs: 200 };
		const m1 = engine({ cwd: d, snapshot: snap });
		await m1.execute("good = {'ok': True}");
		await new Promise((resolve) => setTimeout(resolve, 800));
		await m1.snapshotState();
		await m1.kill();

		// inject a corrupt entry into the snapshot file, then revive from it
		const file = JSON.parse(readFileSync(snap.path, "utf8")) as {
			entries: { name: string; kind: "value" | "def"; payload: string }[];
		};
		file.entries.push({ name: "junk", kind: "value", payload: "not-valid-pickle-base64!!!" });
		writeFileSync(snap.path, JSON.stringify(file));

		const m2 = engine({ cwd: d, snapshot: snap });
		const restore = await m2.restoreState();
		expect(restore?.restored).toContain("good");
		expect(restore?.failed.some((f) => f.name === "junk")).toBe(true);

		const r = await m2.execute("print('still alive', good['ok'])");
		expect(r.status).toBe("ok");
		expect(r.stdout).toContain("True");
	});

	test(
		"output channel beyond the cap is truncated with a marker, not dropped silently",
		{ timeout: 60_000 },
		async () => {
			const d = tempDir();
			const m = engine({ cwd: d });

			// Many short lines (100 chars each) keep the total small per line so only the CHANNEL cap applies.
			const r = await m.execute("print('\\n'.join('x' * 100 for _ in range(200_000)))", { maxOutputChars: 4096 });
			expect(r.status).toBe("ok");
			expect(r.stdout.length).toBeGreaterThan(4000);
			expect(r.stdout).toContain("output truncated at 4096 chars");
		},
	);

	test("a single oversized line is capped per line, not allowed to own the output", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const m = engine({ cwd: d });

		// One giant line (10M chars) must be capped to a per-line length instead of eating the whole budget.
		const r = await m.execute("print('x' * 10_000_000)", { maxOutputChars: 65536 });
		expect(r.status).toBe("ok");
		expect(r.stdout).toContain("some lines exceeded 4096 chars");
		expect(r.stdout.length).toBeLessThan(4300);
	});

	/**
	 * The cell stream tee. Proven end to end rather than at the unit seam because every layer between the
	 * kernel and my context could be the one that lies: ipykernel dup2s a watchfd over fd 1/2 per cell
	 * (iostream.py:619-628) so children and C writes reach the bridge as stream frames that no in-kernel
	 * `sys.stdout` proxy would ever see, the bridge holds those frames before any cap exists, and the
	 * engine trims what I am SHOWN only because the bridge can name the whole thing.
	 */
	describe("cell stream tee: a complete copy is what earns a bounded view", () => {
		const STEM = "2026-01-01T00-00-00-000Z_teetest";
		const teeEnv = (capDir: string, extra: Record<string, string> = {}) => ({
			PI_REPL_CAPTURE_DIR: capDir,
			PAN_SESSION_STEM: STEM,
			...extra,
		});
		const numbers = (dir: string) => readdirSync(dir).map((f) => Number(f.slice(5, 11)));

		test("a cell over the view budget: the file holds every line and the view names the file", { timeout: 60_000 }, async () => {
			const d = tempDir();
			const capDir = tempDir();
			const m = engine({ cwd: d, env: teeEnv(capDir, { PAN_VIEW_LINES: "20" }) });

			// a silent cell gets no file, and neither does any housekeeping op (names, snapshot): the tee
			// buckets only what `emit_stream` carried, so a tier of empty files never accumulates
			const quiet = await m.execute("x = 1");
			expect(quiet.status).toBe("ok");
			expect(quiet.capture).toBeUndefined();
			expect(existsSync(join(capDir, STEM))).toBe(false);

			const r = await m.execute("for i in range(500): print(f'line {i}')");
			expect(r.status).toBe("ok");
			const dir = join(capDir, STEM);
			const files = readdirSync(dir);
			expect(files.length).toBe(1);
			expect(files[0]).toMatch(/^cell-\d{6}\.txt$/);
			const file = join(dir, files[0]);
			const whole = readFileSync(file, "utf8");
			// the tee stores the frames, not a normalised copy: 500 printed lines, final newline included
			expect(whole.endsWith("line 499\n")).toBe(true);
			expect(whole.split("\n").length).toBe(501);

			// the pointer the engine aims its view at, and the totals it states: the tee's, not the head's
			expect(r.capture?.path).toBe(file);
			expect(r.capture?.stdout?.lines).toBe(500);
			expect(r.stdout.split("\n").length).toBe(22); // 20 shown + marker + the peek hint
			expect(r.stdout).toContain("500 lines, ");
			expect(r.stdout).toContain(`full text: ${file}]`);
			expect(r.stdout).toContain(`peek('${file}', start=21)`);
			expect(r.stdout).not.toContain("line 499");
		});

		test("no capture dir means no pointer and the old cap byte for byte, with no path invented", { timeout: 60_000 }, async () => {
			const d = tempDir();
			const m = engine({ cwd: d, env: { PAN_SESSION_STEM: STEM, PAN_VIEW_LINES: "20" } });
			const r = await m.execute("for i in range(500): print(f'line {i}')");
			expect(r.capture).toBeUndefined();
			expect(r.stdout).toContain("line 499"); // nothing was withheld: the negative control
			expect(r.stdout).not.toContain("full text:");
			expect(r.stdout).not.toContain("peek(");
		});

		/**
		 * The join the whole naming scheme buys: `cell-<n>.txt` and `In[<n>]` are the same cell, so a
		 * refusal, a history row and its output copy line up without anybody guessing. ipykernel publishes
		 * the number BEFORE IPython advances its counter (kernelbase.py:868-869, and ipkernel.py:309-318
		 * makes the kernel's counter the shell's), and IPython takes the number then increments
		 * (interactiveshell.py: `execution_count = ... = self.execution_count`, then `+= 1` when
		 * store_history) — so a cell that prints its own counter prints n+1. The witness is the history
		 * database's own line number, which is what `%history`, `_i<n>` and my `redo(n=)` address.
		 */
		test("the copy is named by the number the history database gives that cell", { timeout: 60_000 }, async () => {
			const d = tempDir();
			const capDir = tempDir();
			const m = engine({ cwd: d, env: teeEnv(capDir) });

			const a = await m.execute("print('TEE-MARKER-A')\nfor i in range(3): print(f'a{i}')");
			expect(a.status).toBe("ok");
			// the pattern is built at runtime: a searcher whose own source contains the marker would match
			// itself, and a test that matches itself proves nothing (this one learned that the hard way)
			// hm.search has no session filter and ~/.ipython/profile_default/history.sqlite is box-global:
			// every kernel on this box writes there, mine included. Unfiltered, this returned [1336, 2] and
			// 1336 was a cell in my own live session whose source happened to quote the marker.
			const b = await m.execute(
				"pat = '*' + 'TEE' + '-MARKER-A' + '*'\n"
					+ "hm = get_ipython().history_manager\n"
					+ "print(sorted(n for (s, n, src) in hm.search(pat) if s == hm.session_number))",
			);
			expect(b.status).toBe("ok");

			const dir = join(capDir, STEM);
			const ns = numbers(dir).sort((x, y) => x - y);
			expect(ns.length).toBe(2); // only the cells that spoke: no file for the boot ops
			const nA = ns[0];
			expect(b.stdout.trim()).toBe(`[${nA}]`);
			expect(readFileSync(join(dir, `cell-${String(nA).padStart(6, "0")}.txt`), "utf8")).toContain("a2\n");
		});

		test("one file per cell holds both channels, and states each channel's own totals", { timeout: 60_000 }, async () => {
			const d = tempDir();
			const capDir = tempDir();
			const m = engine({ cwd: d, env: teeEnv(capDir) });
			const r = await m.execute("import sys\nprint('out-1')\nprint('err-1', file=sys.stderr)\nprint('out-2')");
			expect(r.status).toBe("ok");
			expect(r.stdout).toContain("out-1");
			expect(r.stderr).toContain("err-1");
			const files = readdirSync(join(capDir, STEM));
			expect(files.length).toBe(1);
			const whole = readFileSync(join(capDir, STEM, files[0]), "utf8");
			expect(whole).toContain("out-1\nout-2\n");
			expect(whole).toContain("[stderr]\nerr-1\n");
			expect(r.capture?.stdout?.lines).toBe(2);
			expect(r.capture?.stderr?.lines).toBe(1);
		});

		test("the tee's own byte bound cuts a runaway cell, inside the file and in the marker", { timeout: 60_000 }, async () => {
			const d = tempDir();
			const capDir = tempDir();
			const MAX = "2000";
			const m = engine({ cwd: d, env: teeEnv(capDir, { PI_REPL_CAPTURE_MAX_BYTES: MAX, PAN_VIEW_LINES: "10" }) });
			// the knob has to reach the bridge process, and the kernel inherits that env: if this reads
			// None the tee is silently running at 32 MiB and the rest of the test would prove nothing
			const probe = await m.execute("import os\nprint(os.environ.get('PI_REPL_CAPTURE_MAX_BYTES'))");
			expect(probe.stdout.trim()).toBe(MAX);

			const r = await m.execute("for i in range(200): print('y' * 100)");
			expect(r.status).toBe("ok");
			const dir = join(capDir, STEM);
			const ns = numbers(dir).sort((x, y) => x - y);
			expect(ns.length).toBe(2);
			const file = join(dir, `cell-${String(ns[1]).padStart(6, "0")}.txt`);
			const whole = readFileSync(file, "utf8");
			expect(whole.length).toBeLessThan(3000);
			expect(whole).toContain(`the capture stopped at ${MAX} bytes`);
			expect(r.capture?.stdout?.cut).toBe(true);
			// the marker's numbers are then the tee's, so it has to say the copy itself is capped
			expect(r.stdout).toContain("note: the copy hit its own byte bound");
		});
	});

	test("listNamespaceNames lists user state and excludes helpers", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const helpers = tempDir();
		writeFileSync(join(helpers, "double.py"), "def double(n):\n    return n * 2\n");
		const m = engine({ cwd: d, env: { PI_HELPERS_DIR: helpers } });

		await m.execute("alpha = 1; beta = 2");
		const names = await m.listNamespaceNames();
		expect(names).toContain("alpha");
		expect(names).toContain("beta");
		expect(names).not.toContain("double");
	});

	test("a cell that exceeds the silence window is reported as an error", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const m = engine({ cwd: d, env: { PI_REPL_TIMEOUT_MS: "400" } });

		const r = await m.execute("import time; time.sleep(1.5); print('late')");
		expect(r.status).toBe("error");
		expect(r.error?.name).toBe("Timeout");
		expect(r.error?.message.toLowerCase()).toContain("did not finish");
	});

	test("the silence watchdog allows a cell that keeps producing output", { timeout: 60_000 }, async () => {
		const d = tempDir();
		// --- 25ms beats against a 1.6s window (64x margin): the cell outlives the window, so a
		// --- watchdog that ignored output would still kill it, but a transient host stall would
		// --- have to exceed 1.5s to falsely kill a healthy cell. The kill path itself is pinned
		// --- by the exceeds-window test above; this is the positive control. ---
		const m = engine({ cwd: d, env: { PI_REPL_TIMEOUT_MS: "1600" } });

		const r = await m.execute(
			"import time\nfor _ in range(80):\n    print('beat')\n    time.sleep(0.025)\nprint('done')",
		);
		expect(r.status).toBe("ok");
		expect(r.stdout).toContain("done");
	});

	test("an aborted cell interrupts the kernel and keeps the namespace alive", { timeout: 90_000 }, async () => {
		const d = tempDir();
		const m = engine({ cwd: d });

		await m.execute("notes = {'keep': True}");

		const ac = new AbortController();
		const start = Date.now();
		const p = m.execute("import time; time.sleep(60)", { signal: ac.signal });
		await new Promise((resolve) => setTimeout(resolve, 1200));
		ac.abort();
		const r1 = await p;
		expect(r1.status).toBe("aborted");
		expect(Date.now() - start).toBeLessThan(10_000);

		// the kernel was interrupted, not killed: fresh state survives
		const r2 = await m.execute("print('alive', notes['keep'])");
		expect(r2.status).toBe("ok");
		expect(r2.stdout).toContain("alive");
		expect(r2.stdout).toContain("True");
	});

	test("a dead kernel settles the next cell with a rebuild from the last snapshot", { timeout: 90_000 }, async () => {
		const d = tempDir();
		const snap = { path: join(d, "ns.snapshot"), debounceMs: 200 };
		const m = engine({ cwd: d, snapshot: snap });

		await m.execute("notes = {'keep': True}");
		await new Promise((resolve) => setTimeout(resolve, 800));
		await m.snapshotState();

		await m.kill();
		const m2 = engine({ cwd: d, snapshot: snap });
		const restore = await m2.restoreState();
		expect(restore?.restored).toContain("notes");
		const r = await m2.execute("print('rebuilt', notes['keep'])");
		expect(r.status).toBe("ok");
		expect(r.stdout).toContain("rebuilt");
		expect(r.stdout).toContain("True");
	});

	test(
		"a silence-watchdog cell that swallows KeyboardInterrupt is killed and the next cell rebuilds",
		{ timeout: 90_000 },
		async () => {
			const d = tempDir();
			const m = engine({ cwd: d, env: { PI_REPL_TIMEOUT_MS: "800" } });

			await m.execute("kept = {'boot': True}");
			const start = Date.now();
			// the cell never answers (KeyboardInterrupt is caught and ignored), so the silence
			// watchdog must escalate from interrupt to a kill instead of leaving the queue wedged.
			await expect(
				m.execute(
					"import time\nwhile True:\n    try:\n        time.sleep(0.02)\n    except KeyboardInterrupt:\n        continue",
				),
			).rejects.toThrow();
			expect(Date.now() - start).toBeLessThan(40_000);

			// the engine rebuilt around the dead kernel rather than hanging the next cell
			const r = await m.execute("2 + 2");
			expect(r.status).toBe("ok");
			expect(r.result).toContain("4");
		},
	);

	test("cells keep cell identity, and no result object is pinned", { timeout: 60_000 }, async () => {
		// --- store_history is TRUE and DisplayHook.do_full_cache is FALSE, and the two halves are the
		// --- point. execution_count is what names a compiled cell (compiler.cache -> "In[<n>]"), so with
		// --- history off every cell of a session shares one name, the cached source is overwritten every
		// --- cell, and a traceback cannot say which cell a frame came from: both frames read "Cell In[1]".
		// --- The retention the old flag was credited with is DisplayHook.update_user_ns (_oh / _<n>, plus
		// --- three slots held on the hook instance), which history off bounded only by accident:
		// --- prompt_count never moves, so _oh kept one colliding slot. The numbers, and the bare-20 MB
		// --- probe that shows the pin was never the flag's to prevent: docs/ARCHITECTURE.md,
		// --- "History is on; the object cache is off".
		const d = tempDir();
		const m = engine({ cwd: d });

		await m.execute("x = 40");
		for (let i = 0; i < 8; i++) {
			const r = await m.execute(`result_${i} = x + ${i}
result_${i}`);
			expect(r.status).toBe("ok");
			expect(r.result).toContain(String(40 + i));
		}

		// history on: every cell keeps its own source under its own number.
		// cache off: no result object accumulates in the Out dict.
		const probe = await m.execute(
			"print(len(get_ipython().user_ns['In']) > 8, len(get_ipython().user_ns.get('_oh', {})) <= 1)",
		);
		expect(probe.status).toBe("ok");
		expect(probe.stdout.trim()).toBe("True True");

		// the identity claim: a frame defined in one cell and raised in another names two different cells
		await m.execute("def boom():\n    return 1/0\nboom");
		const bad = await m.execute("boom()");
		expect(bad.status).toBe("error");
		const cells = new Set([...(bad.error?.stack ?? []).join("\n").matchAll(/In\[(\d+)\]/g)].map((x) => x[1]));
		expect(cells.size).toBeGreaterThanOrEqual(2);
	});

	test("an unexpectedly-dead kernel is discovered and the next cell rebuilds", { timeout: 90_000 }, async () => {
		const d = tempDir();
		const m = engine({ cwd: d });

		await m.execute("import os");
		await expect(m.execute("os._exit(9)")).rejects.toThrow();

		// isRunning reflects the death, so the engine drops the zombie and rebuilds
		expect(m.isRunning).toBe(false);
		const r = await m.execute("3 + 4");
		expect(r.status).toBe("ok");
		expect(r.result).toContain("7");
	});

	// --- the display card channel (Grist Key 138) -------------------------------------------------
	// A card is one JSON object a kernel function publishes on the kernel's own display channel under
	// application/vnd.pi-repl.card+json. The bridge picks it up from iopub and attaches it to the result
	// of the cell that published it; the TUI renders it. It used to be a file, and the file is what
	// caused the bug the file was meant to prevent — see the second test below, which is that bug.

	test("a kernel function's card reaches the host on the cell that made it", { timeout: 60_000 }, async () => {
		const d = tempDir();
		const m = engine({ cwd: d });
		const r = await m.execute(
			"display({'application/vnd.pi-repl.card+json': {'kind':'diffs','items':[{'path':'a.txt','added':2,'removed':1,'dryRun':False,'diff':'-x +y'}]}}, raw=True)\n1 + 1",
		);
		expect(r.status).toBe("ok");
		expect(r.result).toContain("2");
		expect(r.card).toEqual({ kind: "diffs", items: [{ path: "a.txt", added: 2, removed: 1, dryRun: false, diff: "-x +y" }] });
	});

	test("a card is scoped to its own cell: the next cell carries none", { timeout: 60_000 }, async () => {
		// The file channel got this by reading and unlinking between cells — implicit, and order-dependent.
		// run_cell filters iopub by the cell's msg_id, so the pairing is structural: nothing to clear.
		const d = tempDir();
		const m = engine({ cwd: d });
		const withCard = await m.execute(
			"display({'application/vnd.pi-repl.card+json': {'kind':'diffs','items':[{'path':'a.txt','added':1,'removed':0,'dryRun':False,'diff':'+y'}]}}, raw=True)",
		);
		expect(withCard.card).toBeDefined();
		const without = await m.execute("2 + 2");
		expect(without.result).toContain("4");
		expect(without.card).toBeUndefined();
	});

	test("the card channel survives a snapshot restore (Key 138's own bug)", { timeout: 90_000 }, async () => {
		// The channel used to be a file, and a file needs a path, and the path reached the kernel as a
		// global injected at boot — `PAN_CARD_PATH`. Namespace state is snapshotted, so a kernel revived
		// after a resume, a /fork, or a wedged-kernel rebuild kept writing cards to the DEAD bridge's
		// path, and every card in that session vanished silently forever (`_take_card` treats a missing
		// file as normal). Measured at the time: card in a fresh kernel, card undefined after restoreState.
		// The display channel has no path to go stale, so a restored kernel renders like a fresh one.
		const d = tempDir();
		const snap = { path: join(d, "ns.snapshot"), debounceMs: 200 };
		const m1 = engine({ cwd: d, snapshot: snap });
		await m1.execute("kept = {'resumed': True}");
		await m1.snapshotState();
		await m1.kill();

		const m2 = engine({ cwd: d, snapshot: snap });
		const restore = await m2.restoreState();
		expect(restore?.restored).toContain("kept");
		// the injected global is gone from the namespace entirely, which is also why the /fork'd toast
		// now counts the names it actually inherited
		expect(restore?.restored).not.toContain("PAN_CARD_PATH");
		const r = await m2.execute(
			"display({'application/vnd.pi-repl.card+json': {'kind':'diffs','items':[{'path':'b.txt','added':1,'removed':1,'dryRun':False,'diff':'-p +q'}]}}, raw=True)\nprint(kept['resumed'])",
		);
		expect(r.stdout).toContain("True");
		expect(r.card).toEqual({ kind: "diffs", items: [{ path: "b.txt", added: 1, removed: 1, dryRun: false, diff: "-p +q" }] });
	});

	test("a card that is not a JSON object is dropped, and the cell is untouched", { timeout: 60_000 }, async () => {
		// Fail-open at the boundary: a card is whatever a kernel function chose to publish, so the bridge
		// passes on objects only and the host's validator decides the rest. A bad card must never become a
		// cell error, and must never swallow the cell's real output.
		const d = tempDir();
		const m = engine({ cwd: d });
		const r = await m.execute(
			"display({'application/vnd.pi-repl.card+json': 'not an object'}, raw=True)\nprint('still here')",
		);
		expect(r.status).toBe("ok");
		expect(r.stdout).toContain("still here");
		expect(r.card).toBeUndefined();
	});

	// The "cost when nothing is published" property is a wire-level claim, not an engine-level one: the
	// bridge omits the `card` key entirely (op_exec), while the engine always carries it as undefined.
	// Nothing here can see the difference, so nothing here pretends to pin it.
});
