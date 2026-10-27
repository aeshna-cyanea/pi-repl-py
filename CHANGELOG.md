## [Unreleased]

### Added

- The `repl` tool: three verbs over the evaluator itself, one tool entry. `status` is read-only and
  answers questions the kernel cannot answer about its own host — is the engine alive, when was the
  namespace last snapshotted and how big is it, which helpers are on disk versus which the system prompt
  is currently advertising (and the diff between the two), and what the outbound request actually measured
  in bytes. `reload` re-exec's the helper sources currently on disk in the live kernel — preferring a
  loaded `helpers_reload()` when the helper set owns one — and reports drift against the advertised text.
  `restart` tears the kernel down and boots a new one: it always flushes the namespace to the snapshot
  first, and `fresh: true` boots EMPTY instead of reviving that snapshot, keeping the flushed file as a
  hardlink undo. It refuses while a cell is in flight, because tearing down mid-cell snapshots a namespace
  in the middle of a write. Why these three: they are the things a cell cannot do to itself.
- `EngineLifecycle.restart`, `RevivableEngine.snapshotState`, and a `before_provider_request` byte meter
  feeding `status`. Helper entries now carry their path, byte size and mtime, and the advertised block has
  one home (`formatHelpersBlock`) instead of being re-derived in two places.

- The **cell stream tee**: each executed cell's complete stdout+stderr written by the bridge to
  `<captureDir>/<session>/cell-<n>.txt`, plus a `viewLines` bound (default 120) on what the model is
  shown, with a marker naming the file and the line to resume from. Opt-in (`captureDir` in
  `pi-repl.json`, `""` by default): with it off the channel cap is unchanged byte for byte and the
  marker says the copy does not exist, because a pointer at data we do not have is a lie, not a
  nicety. Files carry the kernel's own cell number, so `cell-<n>.txt` and `In[<n>]` name one cell; the
  tee is bounded per cell (`PI_REPL_CAPTURE_MAX_BYTES`) with the cut written into the copy and repeated
  in the marker; and the bridge reports at boot whether the tee will actually write, which `repl status`
  shows next to what `pi-repl.json` asked for, since a wish and a witness are different things.

### Changed

- Cell history is back ON, and the result-object cache is OFF. `store_history: false` (0.6.12) was
  credited with stopping IPython from pinning result objects; measured on ipykernel/IPython 9.17 it
  stops nothing — the pin is `DisplayHook`'s `_oh`/`_<n>` cache plus three slots (`_`, `__`, `___`)
  held on the hook *instance*, and three bare 20 MB results cost the same 59,540 kB with the flag on
  or off. What the flag did cost was cell identity: with it off `execution_count` never increments,
  `compiler.cache` names every cell of the session `In[1]`, and a traceback can no longer say which
  cell a frame came from — a `boom()` defined in one cell and raised in another renders both frames as
  `Cell In[1]`, where with history on they render as `In[210]` and `In[206]`. So: every execute now
  goes out with `store_history: true` — mandatory, no env knob, because the daemon's refusal recovery
  files a refused cell at the prompt number this call spends and cannot work without it — and the bridge boots the
  kernel with `DisplayHook.do_full_cache = False`, which is the knob that actually bounds memory — the
  big-result pin becomes reclaimable from a cell (measured 58 MB freed, against 39 MB under the old
  settings and nothing freed with the full cache on). Cost of history, 200-cell run: +1.5 ms per cell
  mean, ~1 MB of RSS, and one plaintext `history.sqlite` row per cell. The mechanism and every number
  are in `docs/ARCHITECTURE.md` under "History is on; the object cache is off".
- A cell's `result` is bounded on its own budget (`DEFAULT_MAX_RESULT_LINES = 40`,
  `DEFAULT_MAX_RESULT_CHARS = 4000`) instead of riding the 46 KB output channel. A result is the echo of
  a value nobody asked to see — if you wanted it, you bound it — and unlike stdout it needs no full copy
  kept on disk, because the persistent kernel is the archive: assign the value and it is whole in the next
  cell. The marker names the true totals of the input, so a bounded echo cannot understate what it cut, and
  it names the repair. Measured before changing it: an unbounded result echo spent 11,399 chars on a cell
  whose last expression was a long string, and **IPython's trailing semicolon does not suppress the echo
  here** — `'x';` and `'x'` behave identically through this bridge, so `;` is not a mitigation. One quirk
  the tests now pin: `text/plain` for a `str` is `repr(value)`, so a multi-line string arrives as a single
  line and the char budget, not the line budget, is what bounds it.

- The display card (Key 138) rides the kernel's own display channel — one JSON object published under
  `application/vnd.pi-repl.card+json` during a cell — instead of a file in `$TMPDIR`. The file needed a
  path, the path reached the kernel as a global injected at boot (`PAN_CARD_PATH`), and namespace state is
  snapshotted: a kernel revived after a resume, a `/fork`, or a wedged-kernel rebuild kept writing cards to
  the dead bridge's path, and every card in that session vanished silently forever. The new channel has no
  path to go stale, needs no boot-time state, costs nothing when nothing is published (the file cost one
  stat per cell), and is already this bridge's out-of-band slot — snapshot, restore and names ride it — so
  per-cell pairing comes from the iopub `msg_id` filter rather than from read-and-clear ordering. Two side
  effects: `/fork`'s toast now counts the names it actually inherited (the injected global was one of them),
  and no card file is ever left in `$TMPDIR`.
- README and docs/helpers.md no longer tell the reader to run `/reload`: no such command exists. The only
  command this extension registers is `/repl`; the helper verbs are the `repl` tool.
- The evaluator venv is built with `--system-site-packages` (fork-local; upstream builds an isolated
  venv). A personal REPL on a desktop box gains nothing from isolation, and it costs a second package
  surface: every library a helper wants has to be installed into this venv as well as into the box.
  Purely additive — the venv's own `site-packages` still precede the system's on `sys.path`, so no
  package already installed in the venv changes version. One line in `scripts/setup-venv.mjs`; the
  per-box undo is `include-system-site-packages = false` in `~/.pi/agent/pi-repl/venv/pyvenv.cfg`.
  Only a *rebuilt* venv picks the flag up — `postinstall` repairs an existing one in place.

## [0.9.0] - 2026-09-29

### Added

- `/repl on` and `/repl off`: switch the persistent Python REPL on and off mid-session. The
  `--repl` flag now only sets the starting mode. `/repl off` restores the tools that were
  active before repl took over (the built-ins if nothing was captured); the kernel is left
  running, so the namespace survives the round trip. Switching appends a tool delta to the
  transcript instead of rewriting the prompt, which on the newest Anthropic models keeps the
  cached prefix intact across the switch; other providers re-read the prefix once.

## [0.8.0] - 2026-09-04

### Changed

- The host no longer speaks the Jupyter wire protocol: one stdio pipe to `bridge.py` replaces the
  hand-rolled ZMTP 3.0 client, HMAC framing, and settle protocol (~1,100 lines deleted). The
  bridge owns `jupyter_client` + ipykernel; the host sends one JSON line per op and routes by id.
- Kernel death is pipe EOF plus an exit code — no socket-liveness guessing. The bridge also exits
  when the kernel dies, so the engine's rebuild path is driven by one truthful signal.
- Snapshot payloads never cross into the host: the bridge writes `namespace.snapshot` itself
  (atomic temp+rename) and replies with names and counts only.
- Snapshot cadence (name-diff gate, debounce, periodic refresh with the heavy-namespace
  stand-down) and the background revive's quiet-gap deferral moved into the bridge — a pickling
  snapshot or revive can never be sent ahead of a queued user cell by construction.
- Host deadlines collapse to three: boot (also bounds a wedged background revive), abort grace,
  and the optional silence watchdog.

### Added

- Snapshot format v4: cloudpickle serializes functions and classes by value, zlib-compressed.
  v1-v3 files remain restorable. The install venv gains `cloudpickle` (postinstall repairs
  existing venvs in place).

### Removed

- `src/engine/zmtp.ts` and `src/engine/session.ts` (the wire protocol, HMAC signing, and the
  settle-on-two-messages host machinery — the settle guarantee moved into the bridge).

## [0.7.1] - 2026-09-04

### Changed

- tightened contract

## [0.7.0] - 2026-09-04

### Added

- The helper roster follows the session's working directory, so the model is told exactly what the kernel booted with; failures surface as a marker on the first cell, and all-good boots stay silent.
- Each helper preloads in its own cell, so one broken file can no longer abort the rest.
- The prompt side honors PI_HELPERS_DIR / PI_HELPERS_GLOBAL_DIR exactly like the kernel loader.
- A /fork'd conversation inherits its parent's namespace: the parent's last snapshot is copied into the fork on first start, restored, and announced with a dedicated fork toast.
- Periodic snapshot refresh (`snapshot.periodMs`, default 2 minutes, 0 disables) bounds the loss window for same-name mutations; namespaces whose last snapshot exceeded 8 MiB stand down.
- Value payloads are zlib-compressed (version 3 snapshot format); v1 and v2 snapshots remain restorable.

### Changed

- The model-facing execute prompt: edits anchor the exact lines before replacing, prior state is framed as amortizing over re-deriving, and the truncation marker names its exact size.

### Fixed

- Kernel replies are HMAC-verified before routing; unsigned or forged traffic is now dropped.
- A failed snapshot no longer disables all future snapshots: the name-diff gate advances only on a persisted write.
- Bindings skipped at save time (oversized) are named in the resume notice alongside restore-time failures.
- Pending replies are type-gated, so a wrong-type message on the same parent id cannot settle a probe.
- Kernel recovery from a deleted cwd is covered by a test.

### Removed

- The prose paragraph from the static tool guidelines (restored to the pre-feature wording); comments from prompt.ts and tool-meta.ts.

## [0.6.14] - 2026-09-01

### Changed

- Snapshot recovery runs in the background and never delays the first tool call; the
  `<repl_engine_reset>` notice lands on the first cell after the restore completes.
- Mid-session rebuilds restore the last snapshot before the triggering cell.
- A restore that never completes is killed after `PI_REPL_BOOT_TIMEOUT_MS` (default 90s)
  and marked skipped, reported as "wedged while reviving; skipped".

### Fixed

- Sessions can no longer bleed into each other: the engine is bound to its conversation,
  and a different conversation's acquire tears the old one down instead of reusing it.
- State dirs are keyed `<project-slug>__<conversation>`; legacy dirs migrate on the owning
  conversation's next start, and the orphan sweep recognizes both formats, so deleting a
  conversation removes its snapshots.

## [0.6.13] - 2026-09-01

### Fixed

- A kernel boot that wedges (for example after an npm update swaps the venv under a live kernel, or a snapshot value that never finishes unpickling) no longer hangs the first cell forever: the boot is bounded by `PI_REPL_BOOT_TIMEOUT_MS` (default 90s), the wedged kernel is killed, and the session retries once with the snapshot deliberately skipped, announcing exactly that.
- Pure-traceback error cells no longer render a bogus "no output" line beneath the traceback in the expanded tool view, and the expanded panel always ends with a blank cushion row instead of text flush against the edge.

### Changed

- The prompt's edit guideline drops "a small unique anchor"; anchored replacements are the documented-brittle edit mode in notebook harnesses.

## [0.6.12] - 2026-08-27

### Changed

- Cells run with `store_history` off, so IPython's `In`/`Out` retention can no longer pin result objects and grow long sessions (same workload: 400+ MB to 180 MB, flat).
- Snapshot dirs now die with their conversations: a state dir whose conversation file exists in no project session root is swept on the next start, so deleting a conversation deletes its snapshots.
- A kernel rebuild or resumed session fires a terse PI notification instead of only the in-cell reset marker; the model still gets the named revive/loss block.

## [0.6.11] - 2026-08-27

### Changed

- Resumed conversations announce their restore on the first cell: revived and lost names are named, so the agent re-verifies instead of walking into a namespace it may not have.
- Snapshots now capture cell-defined functions and classes by source and re-execute them on restore; entries are capped per binding and in total, writes are atomic, and old session snapshot directories are pruned.
- Expanded cells render highlighted code from a cache instead of re-highlighting every frame; per-cell wrap caches are bounded against resize churn.

## [0.6.10] - 2026-08-26

### Changed

- The execute tool contract now frames the workspace as a Jupyter notebook with a shared environment: names persist for the notebook's life, reuse over recompute, and reverify after resets.

## [0.6.9] - 2026-08-25

### Changed

- Tightened the execute tool contract: one narrow-the-output rule, reference what the shell already holds instead of re-fetching, helper bullets nested under a header.
- Expanding a cell shows the full output (bounded by the 45K cap) instead of a 50-line head/tail window.
- Cell headers preview Python file idioms (write/read/mkdir/delete/append/rename) for pathlib/open/shutil/os calls.
- Rendering is incremental: fast plain wrap, streamed output re-wraps only the delta, dirty-counter cache keys — no more hitches streaming, expanding, or typing over big cells.
- The debounced snapshot waits for kernel quiet instead of queuing ahead of the next cell, so heavy namespaces no longer stall it.

### Removed

- The preview layer's TypeScript/Bun/tools detectors from the earlier foundation — they only previewed code this Python evaluator can't run.

# Changelog

## [0.6.8] - 2026-08-21

### Added

- Helpers can live in a project's `.pi/helpers/` directory, discovered by walking up from the working directory to the git root; the global `~/.pi/agent/pi-repl/helpers/` still applies to every project, and a project helper shadows a same-named global one.

## [0.6.7] - 2026-08-21

### Changed

- Rebuilt the execute tool prompt in pi's native shape: a single mechanical description, one-line snippet, flat guideline bullets.
- Output cap lowered to 45K so an accidental large dump is truncated early, with a marker, instead of carrying into context.

### Fixed

- Aborting a running cell no longer kills and restarts the kernel when the cell is slow to raise KeyboardInterrupt (for example C-bound work that only yields at a checkpoint): the kernel is given time to settle, and only a cell that genuinely never stops is killed as a last-resort cap.
- Helper lines render as single bullets instead of a doubled list marker in the tool prompt.

## [0.6.3] - 2026-08-21

### Changed

- Reworked the execute print guidance to frame output as a context cost the model carries forward.

## [0.6.2] - 2026-08-21

### Fixed

- An unresponsive or dead kernel no longer hangs the execution queue: a cell that swallows KeyboardInterrupt is killed after a grace window, and an unexpected kernel exit is detected so the next cell rebuilds.
- Wrapped code lines keep their source indentation on continuation rows.
- Bare Python identifiers now get a syntax color instead of rendering flat.
- Running-state spinner switched to a dot scroller at 120ms.

## [0.6.1] - 2026-08-20

### Changed

- Tightened the execute tool prompt: actionable voice and reduced section count.

## [0.6.0] - 2026-08-20

### Added

- Get-up-to-speed acclimation and output-format guidance to the execute tool prompt.
- Snapshot only fires when the namespace name-set changed, so unchanged cells skip the full pickling cost.

### Changed
- Rebuilt the execute tool prompt around result-proven output (fewer, denser sections).
- Restored shell/subprocess/timeout as its own section.

## [0.5.0] - 2026-08-19

### Added

- Ctrl+O expands a live cell stream as soon as the call starts (the tool body is established at call time, mirroring the host's bash tool) instead of waiting for the result.

### Changed

- Execute tool prompt retooled around working in the workspace and proving work by returned result.
- Web helper reads return a bounded preview/window by default; dropped the redundant markdown alias.
- Added define-once-reuse guidance and aligned the opener with the result-proven framing.

## [0.4.0] - 2026-08-18

### Added

- Skills are advertised in repl mode instead of being dropped by pi's read-gated prompt.

### Changed

- Reworked the execute tool description and snippet.

## [0.3.0] - 2026-08-17

### Added

- Kernel now always runs in the install venv (`~/.pi/agent/pi-repl/venv`), so project venvs without ipykernel can no longer shadow it.

### Fixed

- Startup no longer blocks render on the kernel revive; the engine warms up in the background.
- Kernel fallback to the host cwd when the requested session directory no longer exists, instead of dying with a missing-cwd error.

### Removed

- The `[pi-repl-restore]` startup popup; the namespace still revives silently in the background.

## [0.2.8] - 2026-08-17

### Changed

- Tightened the execute tool prompt to frame helpers as preloaded objects the model calls directly, avoiding `import` of a similarly-named package.
- Added a third-party-packages section to the helpers documentation (install into the repl venv).
- Added a helper-creation example skill (design-first, iterate with the user before writing code).
- Added an example `example/` link in the README.

## [0.2.7] - 2026-08-14

### Changed

- Capped per-line output as well as per-channel, so a single oversized line cannot consume the whole output budget.
- Tightened execute prompt guidance around targeted search, surgical edits, and minimal output.

## [0.2.6] - 2026-08-13

### Changed

- Tightened execute prompt guidance for targeted searches, surgical edits, and repository-safe changes.

## [0.2.5] - 2026-08-13

### Changed

- Clarified the README, architecture, design, helper, and Termux documentation.
- Added a provider-backed web helper example.

## [0.2.4] - 2026-08-13

### Added

- Documented the Termux/Android installation path, including the patched `psutil` build required when no compatible PyPI wheel is available.

## [0.2.3] - 2026-08-12

### Changed

- Reworked the REPL prompt around persistent workspace use, iterative execution, timeout discipline, and recovery after engine resets.

## [0.2.2] - 2026-08-12

### Fixed

- Installation now verifies that `ipykernel` is importable, repairs incomplete environments, and fails clearly when the evaluator cannot be built.

## [0.2.1] - 2026-08-12

### Changed

- Clarified that helpers may provide functions, classes, constants, imports, or reusable complex operations.
- Renamed `docs/how-to-functions.md` to `docs/helpers.md`.

## [0.2.0] - 2026-08-12

### Added

- Added timeout guidance for shell commands that may hang.

### Changed

- Simplified the REPL around native Python and a persistent `ipykernel` workspace.
- Reworked helper loading, prompt guidance, and installation configuration.
- Removed the shipped shell/edit helpers in favor of native Python workflows.

### Fixed

- Improved kernel startup, timeout, abort, snapshot, restore, output-limit, and recovery behavior.

## [0.1.1] - 2026-08-09

### Added

- Added helper discovery, evaluator environment setup, and `--repl` activation.

### Changed

- Reframed execution as a persistent notebook-style Python workspace.

### Fixed

- Improved timeout handling, process cleanup, output limits, and kernel recovery.

---

See docs/ARCHITECTURE.md for the design and `docs/` for how-to material.

