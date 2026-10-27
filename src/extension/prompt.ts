import { DEFAULT_MAX_OUTPUT_CHARS } from "../engine/index.js";

/** Which output contract this session is in: bounded with a pointer, or truncated with nothing left. */
export interface TeeFacts {
	dir: string;
	viewLines: number;
}

/**
	The tool description. It changes with the tee because the honest sentence about bounded output is
	different in each mode: with a complete copy, output is BOUNDED and the marker names where the whole
	thing lives; without one, output is TRUNCATED and the withheld text is gone. The config is what the
	operator asked for, not what the bridge confirmed -- `repl status` reports that disagreement, and a
	cell whose copy the bridge refused says so in its own marker.
*/
export function executeToolDescription(tee?: TeeFacts): string {
	const head =
		"Execute Python in a Jupyter notebook. Your workspace is one persistent live session: every " +
		"cell runs in the same namespace, so variables, functions, classes, imports, and data defined " +
		"in one cell stay available to every later cell.";
	return tee
		? `${head} Output is bounded to ${tee.viewLines} lines; the complete stream of every cell is kept at ${tee.dir}/<session>/cell-<n>.txt, and the marker names that file`

		: `${head} Output is truncated to ${DEFAULT_MAX_OUTPUT_CHARS} chars with an explicit marker`;
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
