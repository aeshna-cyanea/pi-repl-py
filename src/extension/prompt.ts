import { VIEW_CHARS_ENV, VIEW_LINES_ENV } from "../engine/index.js";

/** Which output contract this session is in: bounded with a pointer, or truncated with nothing left. */
export interface TeeFacts {
	dir: string;
	/** What the harness will actually trim at, resolved by `resolveViewLines` — not a config echo. */
	viewLines: number;
	/** What the kernel's own view verbs default to. Present only when it is worth naming. */
	kernelLines?: number;
	/** The char half of the same pair — one bound in lines, one in chars, both resolved once. */
	viewChars: number;
	kernelChars?: number;
}

/**
	The tool description, and it states ONE contract because there is one mode.

	**The tee is not optional** (autumn, 2026-11-18: *"lets remove the opt out ofc. we arent really
	designing this for anyone else atm"*), so the second branch is gone rather than merely defaulted
	away: `if (!tee)` used to say *"Output is truncated to N chars with an explicit marker"*, which
	promised that the withheld text was gone. That stopped being true when the tee became the default,
	and keeping the sentence would have been a machine-generated promise nothing can keep.

	The marker is the instrument, not decoration: it names the copy for a cell whose output was cut, and
	it says so in that cell's own result when the copy itself was cut by the byte bound or never written.
	So the sentence below owes the reader both halves -- the bound, and where the exception surfaces.
	What the config can still disagree with is the bridge, and `repl status` is what reports that.
*/
export function executeToolDescription(tee: TeeFacts): string {
	const head =
		"Execute Python in a Jupyter notebook. Your workspace is one persistent live session: every " +
		"cell runs in the same namespace, so variables, functions, classes, imports, and data defined " +
		"in one cell stay available to every later cell.";
	// Zero bytes when the two halves agree, one clause when they do not: a split bound is legal (an operator may
	// want a tighter transcript than the helpers' default) and silent is the one shape it must never take.
	const notes: string[] = [];
	if (tee.kernelLines !== undefined && tee.kernelLines !== tee.viewLines)
		notes.push(`the harness trims at ${tee.viewLines} lines while the kernel's own view verbs (peek/show/cap/run) default to ${tee.kernelLines}: the agent environment set ${VIEW_LINES_ENV} and pi-repl.json set viewLines`);
	if (tee.kernelChars !== undefined && tee.kernelChars !== tee.viewChars)
		notes.push(`the harness trims at ${tee.viewChars} chars while the kernel's own view verbs default to ${tee.kernelChars}: the agent environment set ${VIEW_CHARS_ENV} and pi-repl.json set viewChars`);
	const split = notes.length ? `; NOTE the two halves disagree — ${notes.join("; and ")}; a Pi restart makes them agree` : "";
	return `${head} Output is bounded to ${tee.viewLines} lines and ${tee.viewChars} chars; the complete stream of every cell is kept at ${tee.dir}/<session>/cell-<n>.txt, and the marker names that file — or says the copy was cut or never written${split}`;
}
export const executePromptSnippet = "Execute Python in a Jupyter notebook (read, write, run, search, and more)";

export function buildPromptGuidelines(): string[] {
	return [
		"Write idiomatic Python.",
		"REPL-driven development: the live session's namespace is the single source of truth; reuse and extend existing objects rather than recreating or recomputing them.",
		"Exploratory data analysis: look before acting (head, shape, slice, sample); print the minimal view that answers the question.",
		"Quit thinking and look: read the exact lines/values before changing anything.",
		"Minimal diff: change one thing at a time; if you didn't verify it, it ain't fixed.",
		"Idempotent cells: safe to re-run.",
		"If output begins with <repl_engine_reset>, the runtime rebuilt from a snapshot; trust but verify surviving state.",
		"Be concise.",
	];
}
