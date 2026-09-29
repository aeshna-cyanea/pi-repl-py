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

export function replToast(toggle: ReplToggle): string {
	return toggle === "on"
		? "repl on — execute is now the active tool; the default tools are inactive until /repl off"
		: "repl off — default tools restored; the kernel stays warm with its namespace";
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
