# pi-repl-py

A [pi](https://pi.dev) extension that gives the agent a single `execute` tool backed by a
**persistent Python evaluator**: a real `ipython` kernel that keeps variables, functions, imports,
and data alive across every call and turn.

There is no interactive shell. The agent sends batches of Python code to a workspace that stays
alive for the session. Only the output comes back to the conversation. This keeps state in Python
without requiring an interactive prompt.

```
✓ repl · data = load_json("records.json")       · done
✓ repl · avg = sum(v["score"] for v in data)/len(data)
✓ repl · print("mean score:", round(avg, 2))    · mean score: 41.7
```

`data` is still there in cell three. Nothing was re-read, nothing re-derived from output, because
the kernel stayed alive.

## Quick start

```bash
# from a clone, one-time setup
just setup            # npm install + a project-local .venv with ipykernel

# run a session
pi --repl
```

A plain `pi` session is untouched unless you ask for it: `--repl`, `PI_REPL_FORCE=1`, or
`"defaultOn": true` in `pi-repl.json` (below) starts every session in the REPL.

You can also switch mid-session. `/repl on` activates the REPL; `/repl off` puts your normal
tools back (the kernel keeps running, so your Python namespace is still there when you
switch back). The flag only decides where a session starts; the command handles the rest.

## What repl mode does to the tool surface

`/repl on` collapses **Pi's own built-in tools** — `bash`, `write`, `grep`, `find`, `ls`,
`powershell` — because a Python kernel genuinely replaces them (argv lists beat a quoting
layer; `open()` plus a checked anchor beats a silent no-op). Two built-ins deliberately **stay**,
and the reason each one stays is the test of the rule:

- **`read`** is the only channel for a non-text modality. A cell can `open(p, "rb").read()`, but bytes
  are not an image — Pi's `read` is what hands a jpeg to the model's vision encoder. Dropping it did
  not replace a job the kernel does better, it deleted a capability the kernel cannot provide.
- **`edit`** lives alongside the kernel's `patch()` until `patch()` reaches parity (several anchors,
  one file, one atomic write, one diff).

Everything **another extension**
registers stays active: context tools, question tools, live-status tools. Repl mode has no opinion
about tools it did not replace, so nothing an extension relies on vanishes silently.

Two consequences worth knowing:

- The axis is **names, not provenance**. If another extension wraps `bash`/`write`/`grep`, those
  wrapped copies are pruned too — the kernel replaces the job, not the author.
- The `/repl on` toast **names what it dropped and what it kept**, so a tool that is missing later
  is a name you already saw rather than a mystery.

To drop more than the built-ins, name the tools in `pi-repl.json` — only where the kernel has a
genuinely better route to the same job.

## Settings: `<agent dir>/pi-repl.json`

```json
{
  "defaultOn": true,
  "drop": ["sessions", "remote"]
}
```

| key | meaning |
|---|---|
| `defaultOn` | start every session in the REPL. `--repl` and `/repl on` still work; `PI_REPL_FORCE=0` starts a stock session without editing files |
| `drop` | extension tools the REPL should also collapse. A name that is not registered is a no-op; `execute` can never be dropped |

Precedence at startup: `PI_REPL_FORCE=1` on, `PI_REPL_FORCE=0` off, then `--repl`, then
`defaultOn`. `/repl on` / `/repl off` overrides everything for the rest of the session. A file that
exists but cannot be parsed is reported on stderr and the defaults apply — a silently ignored config
is a knob that stops working without saying so.

## Installing as a pi package

Install the package from npm or directly from GitHub:

```bash
pi install npm:pi-repl-py
# or
pi install github:k3-2o/pi-repl-py
```

The install runs a `postinstall` that creates the Python venv the evaluator needs, at a stable
per-user path (`~/.pi/agent/pi-repl/venv`). If `python3` or the network is missing, it prints a
clear notice. How the interpreter is resolved is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Termux / Android

On **Termux (Android)**, the `postinstall` venv build can fail because `ipykernel` depends on
`psutil`, and PyPI does not provide a compatible Android wheel. The [Termux / Android setup guide](docs/termux.md) shows how to build `psutil` from source and finish the installation.

## What you get

- **A persistent namespace.** Variables, functions, imports, and data survive across cells and
  turns; snapshots preserve them across a best-effort restart.
- **A real `ipython` kernel**, not a hand-rolled `exec` loop.
- **Shell and file IO as plain Python.** Use `!cmd` or `%%bash` for shell commands. Use
  `subprocess.run(...)` when you need the result in a variable, and use `open()` or `pathlib`
  for files. There is no extra wrapper API to learn.
- **Error survival.** A cell that throws reports the traceback and the kernel keeps going.
- **Explicit recovery.** If it restarts, pi-repl reports which state it restored and which state it lost.
- **A `repl` tool, for the evaluator itself.** Three verbs, one tool entry: `status` (read-only — is the
  kernel alive, when was the namespace last snapshotted, what helpers are on disk versus what the prompt
  advertises, and what the outbound request actually measured), `reload` (re-exec the helper sources in the
  live kernel and report the drift), and `restart` (a new kernel; `fresh: true` boots an empty namespace and
  keeps the flushed snapshot as the undo). These are the three things a cell cannot do to itself.

## Helpers

A **helper** is a `.py` file that gets exec'd into every kernel, so whatever it defines
(like functions, classes, constants, imports, or a module that manages a tricky piece of
complexity) is available in the workspace. Drop a file in a `.pi/helpers/` directory in
your project (or `~/.pi/agent/pi-repl/helpers/` for every project) and restart the session;
e.g. `helpers/double.py` defining `def double(x)` becomes callable as `double(...)`. Global
helpers ship **empty** (shell and file IO are already plain Python), so a fresh install
preloads nothing until you add one. Project helpers shadow same-named global ones. Each
helper's `helper_description` is shown to the model verbatim; the full contract lives in
[docs/helpers.md](docs/helpers.md).

The extension keeps its runtime under one folder in your home directory:

```
~/.pi/agent/pi-repl/
  venv/         the Python interpreter + ipykernel
  helpers/      global helpers (created empty on install; every *.py loads)
  state/        per-session namespace snapshots
```

Project helpers live in `<project>/.pi/helpers/` instead; both tiers are scanned with the
project one first. No config file.

A helper is exec'd into the kernel at boot, and the `helper_description` block is rebuilt into the
system prompt at the start of each agent run. So an *edited* file is not live until something re-execs
it, and a *renamed* file (`web.py` → `_web.py`) is not un-loaded until the kernel is rebuilt. Ask for
either with the `repl` tool: `repl reload` re-exec's the sources currently on disk in the live kernel and
reports drift against the advertised text; `repl restart` gets a genuinely new kernel. `repl status`
names the drift without changing anything. (There is no `/reload` command — the only command this
extension registers is `/repl`.)

## Configuration

There is deliberately no configuration file. Everything is arranged under
`~/.pi/agent/pi-repl/`: the venv, the fixed helpers dir, and the session state.
The Python interpreter is auto-resolved (the venv, else `$PYTHON`/`python3`).

## More

- Why this design: [docs/design.md](docs/design.md)
- How it works, the venv, and the kernel: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- How to write and load helpers: [docs/helpers.md](docs/helpers.md)
- Working examples you can copy: [example/](example/) — helpers under `example/helper/` and skills under `example/skills/`
- Termux / Android installation: [docs/termux.md](docs/termux.md)

## It is not

- A sandbox. The kernel runs with your permissions; the toolbox trusts you.
- A subagent framework. There is no `repl.run` API; spawn a process with `subprocess.run`.
- A pi tool-rack. It is one `execute` tool with functions inside.

## License

MIT. See [LICENSE](LICENSE).