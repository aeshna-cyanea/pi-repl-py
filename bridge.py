#!/usr/bin/env python3
"""pi-repl bridge: owns ipykernel and the Jupyter protocol; talks to the TS host over one stdio pipe.

Protocol (JSON lines; host -> bridge on stdin, bridge -> host on stdout):
  in:  {"op":"boot","helpers":[{"name":str,"source":str}]}             first message, before anything
       {"op":"exec","id":str,"code":str}                               run a cell (streams + one result)
       {"op":"snapshot","id":str,"path":str,"max_bytes":int}           snapshot the namespace to path
       {"op":"restore","id":str,"path":str}                            revive path into the namespace
       {"op":"listNames","id":str}                                     current public names
       {"op":"interrupt"}                                              KeyboardInterrupt in the kernel
       {"op":"shutdown","id":str}                                      graceful teardown, then exit 0
  out: {"type":"ready","helpers":[{"name":str,"ok":bool,"error":str?}]}      kernel up, helpers loaded
       {"type":"stream","id":str,"name":"stdout"|"stderr","text":str}        cell output, streamed
       {"type":"result","id":str,"status":"ok"|"error"|"aborted",            cell settled
              "result":str?,"error":{...}?,"card":obj?}

The `card` is a display side-channel (Key 138): a kernel function — patch() today — that wants the
human to see its artifact as something other than a text blob publishes one JSON object on the kernel's
own display channel under CARD_MIME, and the bridge keeps the last one it saw for this cell and attaches
it to the result. Three properties decide the channel. Not stdout, because stdout is byte-for-byte my
own output and anything injected there is a marker that can collide with real output. Not a file either:
a file needs a path, a path needs a name in the kernel namespace, and namespace state is snapshotted — a
restored kernel then writes cards to a dead bridge's path, silently, forever (Key 138's own bug). And
display_data is already this bridge's out-of-band slot: snapshot/restore/names ride it below, and
run_cell already filters iopub by the cell's msg_id, so a card belongs to exactly one cell by
construction rather than by read-and-clear ordering. Cost when no helper published one: zero. An older
bridge ignores the message and the helper prints instead, which is the same degradation as before.
       {"type":"reply","id":str,"..."}                                       snapshot/restore/names/shutdown
       {"type":"error","id":str?,"message":str}                              protocol-level failure
       {"type":"dying","message":str?}                                       best-effort before exit(1)

The bridge is single-threaded over the kernel (one op at a time); the host serializes ops anyway.
A stdin reader thread only relays lines; all kernel I/O stays on the main thread. When the kernel
dies (os._exit, SIGKILL, crash) the bridge exits: the host treats bridge exit as kernel death and
rebuilds from the last snapshot. stdin EOF (host gone) shuts the kernel down cleanly.
"""
import json
import os
import queue
import sys
import threading
import time

from jupyter_client import KernelManager
from jupyter_client.kernelspec import NoSuchKernel

SNAPSHOT_MIME = "application/vnd.pi-repl.snapshot+json"
RESTORE_MIME = "application/vnd.pi-repl.restore+json"
NAMES_MIME = "application/vnd.pi-repl.names+json"
SURFACE_MIME = "application/vnd.pi-repl.surface+json"
CARD_MIME = "application/vnd.pi-repl.card+json"
READY_TIMEOUT_MS = 30_000

# --- kernel-side programs. These run inside ipykernel, so they stay strings (now plain Python). ---

def skip_set_literal(helper_names):
    skip = list(helper_names) + ["helper_description", "In", "Out", "get_ipython", "exit", "quit", "open"]
    return json.dumps(skip)


def snapshot_code(helper_names, max_bytes):
    # v4: cloudpickle serializes functions and classes by value — no source-capture machinery.
    # Entries are zlib-compressed cloudpickle streams; one unpicklable binding costs itself only.
    #
    # `__repl_boot` is the list of names the injected bootstrap line bound (Key 221 step 2), written by
    # op_boot under an underscore name so the `startswith('_')` rule below never snapshots the record
    # itself. The package's verbs are not user state -- they come back from `panlib` on every boot -- and
    # pickling them spends the same cap my real bindings share. Measured 2026-10-17: 122 names, ~45 bytes
    # each, against a 128 MB cap and a 138 KB snapshot, and cloudpickle resolves them BY REFERENCE (a
    # restored `patch` is `panlib.text.patchkit.patch`, identity intact), so this is cap honesty and a
    # quieter `saved` list, not the fix for a live two-instances hazard.
    return ("import cloudpickle as _cp, base64 as _b64, json as _js, zlib as _zl\n"
            + "__repl_skip = set(" + skip_set_literal(helper_names) + ") | set(globals().get('__repl_boot', ()))\n"
            + "__repl_max = " + str(max_bytes) + "\n"
            + """__repl_e = []
__repl_f = []
__repl_total = 0
for _k, _v in list(globals().items()):
    if _k.startswith('_') or _k in __repl_skip:
        continue
    try:
        __repl_p = _b64.b64encode(_zl.compress(_cp.dumps(_v), 1)).decode()
        __repl_b = len(__repl_p)
        if __repl_b > __repl_max:
            __repl_f.append({'name': _k, 'reason': 'exceeds per-entry snapshot cap'})
        elif __repl_total + __repl_b > __repl_max:
            __repl_f.append({'name': _k, 'reason': 'exceeds total snapshot cap'})
        else:
            __repl_e.append({'name': _k, 'kind': 'value', 'payload': __repl_p})
            __repl_total += __repl_b
    except Exception as _e:
        __repl_f.append({'name': _k, 'reason': str(_e)})
"""
            + "get_ipython().display_pub.publish({" + json.dumps(SNAPSHOT_MIME) + ": _js.dumps({'version': 4, 'entries': __repl_e, 'failed': __repl_f})})\n")


def _restore_body(name, kind, payload, version):
    n = json.dumps(name)
    pl = json.dumps(payload)
    if version >= 4:
        body = "globals()[" + n + "] = _cp.loads(_zl.decompress(_b64.b64decode(" + pl + ")))"
    elif version == 3 and kind == "def":
        # re-execute captured source and register it in linecache under the code
        # so a later snapshot can capture it again
        body = (
            "__repl_src = _b64.b64decode(" + pl + ").decode()\n"
            + "    exec(__repl_src, globals())\n"
            + "    __repl_obj = globals().get(" + n + ")\n"
            + "    if __repl_obj is not None:\n"
            + "        __repl_fname = getattr(getattr(__repl_obj, '__code__', None), 'co_filename', None)\n"
            + "        if __repl_fname is None:\n"
            + "            __repl_init = getattr(__repl_obj, '__init__', None)\n"
            + "            __repl_fname = getattr(getattr(__repl_init, '__code__', None), 'co_filename', None)\n"
            + "        if __repl_fname:\n"
            + "            _lc.cache[__repl_fname] = (len(__repl_src.splitlines()), None, __repl_src.splitlines(True), __repl_fname)"
        )
    else:
        inner = "_b64.b64decode(" + pl + ")"
        if version == 3:
            inner = "_zl.decompress(" + inner + ")"
        body = "globals()[" + n + "] = _pk.loads(" + inner + ")"
    return ("try:\n    " + body + "\n    __repl_r['restored'].append(" + n + ")\n"
            + "except Exception as _e:\n    __repl_r['failed'].append({'name': " + n + ", 'reason': str(_e)})\n")


def restore_code(entries, version):
    if version >= 4:
        head = "import cloudpickle as _cp, base64 as _b64, json as _js, zlib as _zl\n"
    elif version == 3:
        head = "import pickle as _pk, base64 as _b64, json as _js, zlib as _zl, linecache as _lc\n"
    else:
        head = "import pickle as _pk, base64 as _b64, json as _js\n"
    per = "".join(_restore_body(e["name"], e.get("kind", "value"), e["payload"], version) for e in entries)
    return (head
            + "__repl_r = {'restored': [], 'failed': []}\n"
            + per
            + "get_ipython().display_pub.publish({" + json.dumps(RESTORE_MIME) + ": _js.dumps(__repl_r)})\n")


def names_code(helper_names):
    return ("import json as _js\n"
            + "__repl_skip = set(" + skip_set_literal(helper_names) + ")\n"
            + "__repl_n = sorted(n for n in globals() if not n.startswith('_') and n not in __repl_skip)\n"
            + "get_ipython().display_pub.publish({" + json.dumps(NAMES_MIME) + ": _js.dumps(__repl_n)})\n")


def surface_code():
    # Do the flat bindings in THIS kernel agree with the block the host is about to advertise? The policy is
    # panlib's (`binding_divergence`: unbound / wrong kind / stale signature / stale class / pre-reload
    # generation, and how generation is counted rather than itemised); this program is one line of call and a
    # publish, because a second copy of the rule would drift from the first. Key 221 step 4, 2026-10-20.
    #
    # A failure publishes an `error`, never an empty list: "I could not look" and "nothing diverges" are
    # different answers, and the host renders the first as silence only because it cannot say more.
    return ("import json as _js\n"
            + "try:\n"
            + "    import panlib.surface as _ps\n"
            + "    __repl_o = {'divergences': _ps.binding_divergence(get_ipython().user_ns)}\n"
            + "except Exception as _e:\n"
            + "    __repl_o = {'error': '%s: %s' % (type(_e).__name__, _e)}\n"
            + "get_ipython().display_pub.publish({" + json.dumps(SURFACE_MIME) + ": _js.dumps(__repl_o)})\n")


class Bridge:
    def __init__(self):
        self.km = None
        self.kc = None
        self.helper_names = []
        self.requests = queue.Queue()
        self.op_id = None          # id of the exec currently streaming, for stream routing
        self.op_payload_mime = None  # private MIME awaited for the current internal cell
        # snapshot policy + name-diff gate: the bridge schedules snapshots itself in quiet gaps,
        # so a pickle can never land in front of a user cell (the bridge IS the queue)
        self.policy = None         # {"path": str, "max_bytes": int, "period_ms": int} | None
        self.last_names = None     # names at the last persisted write; None = never written
        self.last_persisted_at = 0.0
        self.last_bytes = 0
        self.pending_check = False # a cell just completed; the gate owes a name diff
        self.deferred_restore = None  # background revive: runs at the first quiet gap

    # ----- IO -----

    def emit(self, msg):
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()

    def _stdin_reader(self):
        # BufferedReader.read(n) blocks until n bytes arrive; line iteration returns per line
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                self.requests.put(json.loads(line))
            except Exception as e:
                self.emit({"type": "error", "message": "bad request line: %s" % e})
                self.requests.put({"op": "shutdown", "id": "bad-line"})
        self.requests.put({"op": "__eof__"})

    # ----- kernel lifecycle -----

    def start_kernel(self):
        km = KernelManager(kernel_name="python3")
        try:
            km.start_kernel()
        except NoSuchKernel:
            km = KernelManager(kernel_name="python3", kernel_cmd=[
                sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"])
            km.start_kernel()
        kc = km.client()
        kc.start_channels()
        try:
            kc.wait_for_ready(timeout=READY_TIMEOUT_MS / 1000)
        except Exception:
            km.shutdown_kernel(now=True)
            raise
        self.km, self.kc = km, kc

    def stop_kernel(self):
        try:
            self.kc.stop_channels()
        except Exception:
            pass
        try:
            self.km.shutdown_kernel(now=True)
        except Exception:
            pass

    # ----- cells -----

    def run_cell(self, code, emit_stream, payload_mime=None, emit_id=None):
        """Run one cell; settle on shell reply AND iopub idle (a reply alone can beat big output).
        Returns {status, result?, error?, payload?, card?}. Raises when the kernel died.

        `card` is the last display card published during THIS cell: iopub is already filtered by the
        cell's msg_id below, so the pairing is structural and needs no bookkeeping of its own.
        """
        kc = self.kc
        msg_id = kc.execute(code, silent=False, store_history=False,
                            user_expressions={}, allow_stdin=False, stop_on_error=True)
        self.op_id = msg_id
        self.op_payload_mime = payload_mime
        result = None
        error = None
        payload = None
        card = None
        quiet_for = 0.0
        try:
            while True:
                # pending interrupts/shutdowns act within one poll cadence
                self._drain_control_queue()
                try:
                    msg = kc.get_iopub_msg(timeout=0.25)
                except Exception:
                    # timeout: poll the heartbeat instead of timing out the whole bridge
                    quiet_for += 0.25
                    if quiet_for >= 2.0:
                        if not self.kernel_alive():
                            self.emit({"type": "dying", "message": "kernel heartbeat lost"})
                            sys.exit(1)
                        quiet_for = 0.0
                    continue
                if msg.get("parent_header", {}).get("msg_id") != msg_id:
                    continue
                quiet_for = 0.0
                ctype = msg["msg_type"]
                content = msg["content"]
                if ctype == "stream":
                    if emit_stream:
                        self.emit({"type": "stream", "id": emit_id or msg_id, "name": "stderr" if content.get("name") == "stderr" else "stdout", "text": content.get("text") or ""})
                elif ctype == "execute_result":
                    data = content.get("data") or {}
                    if "text/plain" in data:
                        result = data["text/plain"]
                    payload = self._take_payload(content)
                elif ctype == "display_data":
                    payload = self._take_payload(content)
                    found = self._card_from(content)
                    if found is not None:
                        card = found
                elif ctype == "error":
                    error = {
                        "name": content.get("ename") or "Error",
                        "message": content.get("evalue") or "",
                        "stack": content.get("traceback") or [],
                    }
                elif ctype == "status" and content.get("execution_state") == "idle":
                    break
        except Exception as e:
            if not self.kernel_alive():
                self.emit({"type": "dying", "message": "kernel died mid-cell"})
                sys.exit(1)
            raise
        status = "ok"
        reply = None
        for _ in range(20):
            try:
                candidate = kc.get_shell_msg(timeout=10)
            except Exception:
                break
            if candidate.get("parent_header", {}).get("msg_id") == msg_id:
                reply = candidate
                break
            # stale reply from an earlier op (a late kernel_info, or an "incomplete
            # input" error flushed by this request): drain it, keep looking
        if reply:
            status = reply.get("content", {}).get("status", "ok")
        if status != "aborted" and error is not None:
            # iopub error wins over an "ok" reply (ipykernel: compile-phase failures reply ok)
            status = "error"
        if status == "error" and error is None:
            c = reply.get("content", {})
            error = {"name": c.get("ename") or "Error", "message": c.get("evalue") or "cell failed", "stack": []}
        if status == "aborted" and error is None:
            error = {"name": "KeyboardInterrupt", "message": "cell interrupted", "stack": []}
        self.op_id = None
        self.op_payload_mime = None
        return {"status": status, "result": result, "error": error, "payload": payload, "card": card}

    def _take_payload(self, content):
        data = content.get("data") or {}
        mime = self.op_payload_mime
        if mime is not None and mime in data:
            return data[mime]
        return None

    def _drain_control_queue(self):
        # control-plane ops may jump the queue mid-cell; anything else is left in order
        while True:
            try:
                op = self.requests.get_nowait()
            except queue.Empty:
                break
            if op["op"] == "interrupt":
                self.interrupt()
            elif op["op"] in ("shutdown", "__eof__"):
                self.stop_kernel()
                sys.exit(0)
            else:
                self.requests.put(op)
                break

    def interrupt(self):
        # BlockingKernelClient has no interrupt() in jupyter_client 8.x; the old host sent
        # interrupt_request on the control channel directly — do the same
        msg = self.kc.session.msg("interrupt_request", content={})
        self.kc.control_channel.send(msg)

    def kernel_alive(self):
        try:
            return self.km.is_alive()
        except Exception:
            return False

    # ----- ops -----

    FORCED_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024
    QUIET_WINDOW_S = 0.15

    def _names(self):
        res = self.run_cell(names_code(self.helper_names), emit_stream=False, payload_mime=NAMES_MIME)
        return json.loads(res["payload"]) if res["payload"] else []

    def _snapshot_due(self, names):
        changed = self.last_names is None or names != self.last_names
        period = (self.policy or {}).get("period_ms") or 0
        stale = (period > 0 and self.last_persisted_at > 0
                 and (time.time() - self.last_persisted_at) * 1000 >= period
                 and self.last_bytes <= self.FORCED_SNAPSHOT_MAX_BYTES)
        return changed or stale

    def quiet_seconds(self):
        """How long the serve loop may block waiting for ops before the gap counts as quiet.
        None = nothing is due; block indefinitely."""
        if self.deferred_restore is not None:
            return self.QUIET_WINDOW_S
        if self.pending_check and self.policy:
            return self.QUIET_WINDOW_S
        return None

    def quiet_tick(self):
        """The queue stayed empty for the quiet window: run the deferred revive, then the
        owed snapshot. The gate advances only on a persisted write, so a failed write
        retries at the next gap."""
        if self.deferred_restore is not None:
            op, self.deferred_restore = self.deferred_restore, None
            self.op_restore(op)
            return
        if not (self.pending_check and self.policy):
            return
        self.pending_check = False
        names = self._names()
        if not self._snapshot_due(names):
            return
        self._write_snapshot(self.policy["path"], self.policy["max_bytes"], names)

    @staticmethod
    def _card_from(content):
        """Pull a display card out of an iopub message, or None.

        Untrusted by definition: a card is whatever a kernel function chose to publish, so the bridge
        only ever passes on a JSON object and lets the host's validator decide what it means. A card
        that is not an object is dropped here, because dropping is what this channel does to anything
        it does not understand — the cell that published it stays untouched either way.
        """
        value = (content.get("data") or {}).get(CARD_MIME)
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError:
                return None
        return value if isinstance(value, dict) else None

    # The two cells that fence the bootstrap. Both write under an underscore name, which is how the
    # snapshot's own `startswith('_')` rule keeps them out of the namespace it persists.
    BASELINE_CODE = "globals()['__repl_base'] = set(globals())"
    BOOT_NAMES_CODE = "globals()['__repl_boot'] = sorted(set(globals()) - globals()['__repl_base'])"

    def op_boot(self, boot):
        self.helper_names = [h["name"] for h in boot.get("helpers") or []]
        self.policy = boot.get("snapshot")
        self.start_kernel()
        # **The bootstrap runs before the helper preload, and that order is the invariant** (Key 221
        # step 2, pan/notes/panlib-layout/no-helpers.md). The helpers land later and win on any name they
        # share with the bootstrap, so the bootstrap can only ever ADD names -- which is what makes the
        # diff between the two surfaces something I can read instead of a silent overwrite. Measured on
        # this box before the change: of 122 names the bootstrap binds, exactly one (`client`) is replaced
        # by a helper, and it lands on the helper's version, which is what already runs today.
        #
        # A bootstrap that fails must not take the session with it: the helpers still load and the ready
        # event says what happened. Upstream learned the other half of this in 1808497 -- a boot step with
        # no deadline hangs every cell after it -- but a run_cell that raises returns an error, it does not
        # hang, so the bound here is the one the lifecycle already puts on the whole boot.
        bootstrap = (boot.get("bootstrap") or "").strip()
        bres = None
        if bootstrap:
            self.run_cell(self.BASELINE_CODE, emit_stream=False)
            res = self.run_cell(bootstrap, emit_stream=False)
            self.run_cell(self.BOOT_NAMES_CODE, emit_stream=False)
            bres = {"ok": res["status"] == "ok", "line": bootstrap}
            if not bres["ok"]:
                err = res["error"] or {}
                bres["error"] = (err.get("name") + ": " + err.get("message", "")).strip() or "failed to run"
                print(f"[pi-repl] bootstrap failed, helpers loading anyway: {bres['error']}", file=sys.stderr)
        report = []
        for h in boot.get("helpers") or []:
            res = self.run_cell(h["source"], emit_stream=False)
            if res["status"] == "ok":
                report.append({"name": h["name"], "ok": True})
            else:
                err = res["error"] or {}
                report.append({"name": h["name"], "ok": False,
                               "error": (err.get("name") + ": " + err.get("message", "")).strip() or "failed to load"})
        self.emit({"type": "ready", "helpers": report, "bootstrap": bres})

    def op_exec(self, op):
        res = self.run_cell(op["code"], emit_stream=True, emit_id=op["id"])
        out = {"type": "result", "id": op["id"], "status": res["status"]}
        if res["result"] is not None:
            out["result"] = res["result"]
        if res["error"] is not None:
            out["error"] = res["error"]
        if res.get("card") is not None:
            out["card"] = res["card"]
        self.emit(out)

    def _write_snapshot(self, path, max_bytes, names=None):
        import cloudpickle  # noqa: F401 — fail loudly here, not at bridge boot
        res = self.run_cell(snapshot_code(self.helper_names, max_bytes), emit_stream=False,
                            payload_mime=SNAPSHOT_MIME)
        payload = res["payload"]
        if payload is None:
            return {"saved": [], "failed": [], "complete": False, "bytes": 0}
        body = json.loads(payload)
        entries, failed = body.get("entries", []), body.get("failed", [])
        # atomic write: temp + rename, so a crash can't corrupt the last good snapshot
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"version": 4, "entries": entries, "failed": failed}, fh)
        os.replace(tmp, path)
        # only a persisted write advances the gate
        self.last_names = names if names is not None else [e["name"] for e in entries]
        self.last_persisted_at = time.time()
        self.last_bytes = sum(len(e["payload"]) for e in entries)
        return {"saved": [e["name"] for e in entries], "failed": failed,
                "complete": True, "bytes": self.last_bytes}

    def op_snapshot(self, op):
        try:
            import cloudpickle  # noqa: F401 — fail loudly here, not at bridge boot
        except ImportError as e:
            self.emit({"type": "reply", "id": op["id"], "error":
                       "cloudpickle is missing from the evaluator venv: %s" % e})
            return
        out = self._write_snapshot(op["path"], op["max_bytes"])
        self.emit({"type": "reply", "id": op["id"], **out})

    def op_restore(self, op):
        try:
            with open(op["path"], encoding="utf-8") as fh:
                body = json.load(fh)
        except Exception as e:
            self.emit({"type": "reply", "id": op["id"], "error": "snapshot unreadable: %s" % e})
            return
        version = body.get("version")
        if version is not None and version >= 2:
            entries = body.get("entries") or []
            failed_at_save = body.get("failed") or []
        else:
            # v1 files (pre-source-capture) restore via plain pickles
            entries = [{"name": n, "kind": "value", "payload": p} for n, p in (body.get("vars") or {}).items()]
            failed_at_save = []
        res = self.run_cell(restore_code(entries, version or 4), emit_stream=False, payload_mime=RESTORE_MIME)
        restored, failed = [], []
        if res["payload"] is not None:
            body2 = json.loads(res["payload"])
            restored, failed = body2.get("restored", []), body2.get("failed", [])
        # merge save-time skips (oversized bindings) so the resume notice names every loss
        seen = {f["name"] for f in failed}
        for f in failed_at_save:
            if f["name"] not in seen:
                failed.append(f)
                seen.add(f["name"])
        self.emit({"type": "reply", "id": op["id"], "restored": restored, "failed": failed})

    def op_names(self, op):
        res = self.run_cell(names_code(self.helper_names), emit_stream=False, payload_mime=NAMES_MIME)
        names = json.loads(res["payload"]) if res["payload"] is not None else []
        self.emit({"type": "reply", "id": op["id"], "names": names})

    def op_surface(self, op):
        # No payload means the cell produced nothing (wedged, or the publish never ran): answer with an
        # error, not with an empty divergence list, so the host cannot read a fault as a clean bill.
        res = self.run_cell(surface_code(), emit_stream=False, payload_mime=SURFACE_MIME)
        if res["payload"] is None:
            self.emit({"type": "reply", "id": op["id"], "error": "the surface probe published nothing"})
            return
        body = json.loads(res["payload"])
        self.emit(dict({"type": "reply", "id": op["id"]}, **body))

    # ----- main loop -----

    def serve(self):
        threading.Thread(target=self._stdin_reader, daemon=True).start()
        boot = self.requests.get()
        if boot.get("op") == "__eof__":
            return
        try:
            self.op_boot(boot)
        except Exception as e:
            self.emit({"type": "error", "message": "boot failed: %s" % e})
            sys.exit(1)
        while True:
            try:
                op = self.requests.get(timeout=self.quiet_seconds())
            except queue.Empty:
                self.quiet_tick()
                continue
            o = op.get("op")
            if o == "__eof__":
                self.stop_kernel()
                sys.exit(0)
            try:
                if o == "exec":
                    self.op_exec(op)
                    self.pending_check = True
                elif o == "snapshot":
                    self.op_snapshot(op)
                elif o == "restore":
                    if op.get("defer"):
                        # background revive: run at the first quiet gap, never ahead of a cell;
                        # the reply (same id) settles the host's restoreResult promise
                        self.deferred_restore = op
                    else:
                        self.op_restore(op)
                elif o == "listNames":
                    self.op_names(op)
                elif o == "surface":
                    self.op_surface(op)
                elif o == "interrupt":
                    self.interrupt()
                elif o == "shutdown":
                    self.stop_kernel()
                    sys.exit(0)
                else:
                    self.emit({"type": "error", "id": op.get("id"), "message": "unknown op: %s" % o})
            except Exception as e:
                self.emit({"type": "error", "id": op.get("id"), "message": "%s" % e})


def main():
    try:
        Bridge().serve()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
