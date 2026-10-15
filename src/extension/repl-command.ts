/** Pure /repl command logic: parse, complete, announce. index.ts binds pi's API around it. */

export type ReplToggle = "on" | "off";

/** The subcommand word, or undefined when the args don't name one (usage case). */
export function parseReplToggle(args: string): ReplToggle | undefined {
	const sub = args.trim().toLowerCase();
	return sub === "on" || sub === "off" ? sub : undefined;
}

/** Complete on/off; null when nothing matches, so pi falls back to default completion. */
export function replArgumentCompletions(prefix: string): { value: string; label: string }[] | null {
	const subs: ReplToggle[] = ["on", "off"];
	const filtered = subs.filter((s) => s.startsWith(prefix));
	return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
}

/** Usage line; nudges toward the subcommand that would actually change something. */
export function replUsageMessage(replMode: boolean): string {
	return `Usage: /repl ${replMode ? "off" : "on"} — repl is currently ${replMode ? "on" : "off"}`;
}

/**
 * Pi's own built-in tool names: the surface a Python kernel genuinely replaces (argv lists and
 * open()/str.replace() beat a quoting layer and a no-op-on-a-typo anchor). Everything else an
 * extension registers stays active in repl mode, because repl mode has no opinion about it.
 *
 * Two names LEFT this list on 2026-10-14, and each one's reason for leaving is a test of the
 * criterion itself, so it is written here rather than in a commit message:
 *  - **`read` is the only channel for a non-text modality.** A cell can `open(p, "rb").read()`, but
 *    bytes are not an image: Pi's `read` is what hands a jpeg/png to the model's vision encoder
 *    (`downgradeUnsupportedImages()` gates on `model.input`, and the image block reaches the model
 *    only through Pi's own tool). Dropping `read` did not replace a job the kernel does better — it
 *    deleted a capability the kernel cannot provide at all, which fails this list's own test.
 *  - **`edit` stays alongside the kernel's `patch()` until `patch()` reaches parity** — several
 *    anchors, one file, one atomic write, one diff is still open upstream (Key 168). Pruning Pi's
 *    tool while the replacement is half-built is how a half-built surface becomes the only surface.
 *
 * Deliberately NOT in this list: `codemode` and `tool_search` (built-in *extensions*, not built-in
 * tools — codemode is a composition surface, not a file/shell tool), and `execute` itself.
 *
 * The axis is NAMES, not provenance: pi-ssh-remote wraps read/bash/edit/write, so those four carry
 * sourceInfo "npm:pi-ssh-remote" on a box that has it installed, and pruning by source would keep
 * the wrapped (and more expensive) copies. Pi exports no constant for this set to extensions —
 * DEFAULT_TOOL_NAMES (dist/core/settings-manager.js) is only the four defaults, while grep/find/ls/
 * powershell live in allToolNames — so this list is ours to keep in step. The test pins both halves:
 * the names the kernel replaces, **and** `read`/`edit` as absent, so a future refactor (or a Pi
 * rename) cannot silently put the modality channel back on the pruning list.
 */
export const BUILTIN_TOOL_NAMES: readonly string[] = ["bash", "write", "grep", "find", "ls", "powershell"];

export const EXECUTE_TOOL = "execute";

/**
 * The loadout /repl on should install: execute, plus every active tool that is neither one of Pi's
 * built-ins nor named in the operator's extra drop list. `drop` can never remove execute — the
 * kernel is the point of the mode.
 */
export function prunedLoadout(active: readonly string[], drop: readonly string[] = []): string[] {
	const skip = new Set<string>([...BUILTIN_TOOL_NAMES, ...drop]);
	return [EXECUTE_TOOL, ...active.filter((name) => name !== EXECUTE_TOOL && !skip.has(name))];
}

/** The names the prune took away, in the order they were active. The toast is built from this, so a
 *  tool another extension lost is named out loud instead of vanishing from the prompt. */
export function droppedToolNames(active: readonly string[], next: readonly string[]): string[] {
	const kept = new Set(next);
	return active.filter((name) => !kept.has(name));
}

/**
 * Announce the transition *with what it changed*. `changed` is what was dropped (on) or restored
 * (off); `kept` is what survived the prune. A silent collapse is how another extension's tool goes
 * missing for a whole session without anyone being able to say which one.
 */
export function replToast(toggle: ReplToggle, changed: readonly string[] = [], kept: readonly string[] = []): string {
	if (toggle === "on") {
		const head = "repl on — execute is the active tool; Pi's built-in tools are inactive until /repl off";
		if (changed.length === 0) return `${head}; nothing else was dropped`;
		return `${head}\n  dropped: ${changed.join(" ")}\n  kept:    ${kept.join(" ")}`;
	}
	const head = "repl off — default tools restored; the kernel stays warm with its namespace";
	return changed.length > 0 ? `${head}\n  restored: ${changed.join(" ")}` : head;
}

/**
 * What /repl off should restore. The loadout captured at /repl on wins (other extensions'
 * active tools come back too); the built-ins are the fallback when nothing was captured or
 * the capture is empty — both capture points guard against this, but the fallback must also
 * survive it: restoring [] would leave the model with no tools at all.
 */
const FALLBACK_TOOLS = ["read", "bash", "edit", "write"];
export function restoredTools(stockTools: string[] | undefined): string[] {
	return stockTools?.length ? stockTools : FALLBACK_TOOLS;
}
