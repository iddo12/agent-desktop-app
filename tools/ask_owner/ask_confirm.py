#!/usr/bin/env python3
"""ask_confirm.py - "answer once" from OUTSIDE Agent Desktop (2026-10-31, Security).

    python ask_iddo.py confirm <id> [--timeout 600]        (or: python ask_confirm.py <id>)

Pops a small always-on-top window with the open question and its quick buttons. The OWNER's click on that window writes a signed request into
Agent Desktop's answer-once inbox; Agent Desktop verifies it and types the answer into the ASKING agent's own chat as a genuine user message,
then resolves the question. So he answers ONCE, wherever he is talking, and the asking agent accepts it (a relayed "Iddo said yes" it rightly refuses).
The command waits for the window and prints DELIVERED / NOT DELIVERED: <why> / CANCELLED / EXPIRED. Run it in the background (it blocks until he clicks).

Why an agent cannot fake it: the answer is not an argument, only a click on the window (the process that holds the signing key) produces a request;
the key sits in %LOCALAPPDATA%\\AgentDesktop\\answer-once (override AGENT_DESKTOP_ANSWER_ONCE_DIR), outside the workspace; Agent Desktop
re-checks signature, nonce, age, that the question is still open and unchanged, and that the answer is one of the question's own quick answers.
Threat model in 5 lines: Agent Desktop src\\answerOnce.js (top comment). Never print or log the key."""
import argparse, hashlib, hmac, json, os, secrets, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def state_dir():
    d = os.environ.get("AGENT_DESKTOP_ANSWER_ONCE_DIR")
    if d: return d
    if sys.platform == "win32":
        return os.path.join(os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local"), "AgentDesktop", "answer-once")
    return os.path.join(os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state"), "agent-desktop", "answer-once")


def read_key(d):
    p = os.path.join(d, "key")
    good = lambda k: k if len(k) == 64 and all(c in "0123456789abcdef" for c in k) else None
    try:
        k = good(open(p, encoding="utf-8").read().strip())
        if k: return k
    except OSError: pass
    os.makedirs(d, exist_ok=True)
    k = secrets.token_hex(32)
    try:
        with open(p, "x", encoding="utf-8") as f: f.write(k + "\n")
        return k
    except FileExistsError:
        try:
            k2 = good(open(p, encoding="utf-8").read().strip())
            if k2: return k2
        except OSError: pass
        with open(p, "w", encoding="utf-8") as f: f.write(k + "\n")      # a malformed key file is replaced, never used
        return k


def qhash(ask):
    """Binds question text, asking agent and quick answers (same as src/answerOnce.js qhash)."""
    quick = "\x1f".join(ask.get("quick") or [])
    return hashlib.sha256("\x1e".join([str(ask["question"]), str(ask.get("agent", "")), quick]).encode("utf-8")).hexdigest()[:16]


def sign(key, req):
    msg = "\x1f".join(["v1", req["id"], req["answer"], req["qhash"], req["nonce"], str(req["ts"])]).encode("utf-8")
    return hmac.new(key.encode("utf-8"), msg, hashlib.sha256).hexdigest()


def make_request(key, ask, answer, nonce=None, ts=None):
    req = {"v": 1, "id": ask["id"], "answer": answer, "qhash": qhash(ask), "nonce": nonce or secrets.token_hex(16),
           "ts": int(ts if ts is not None else time.time() * 1000)}
    req["mac"] = sign(key, req)
    return req


def write_request(d, req):
    inbox = os.path.join(d, "inbox"); os.makedirs(inbox, exist_ok=True)
    tmp = os.path.join(inbox, req["nonce"] + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f: json.dump(req, f)
    os.replace(tmp, os.path.join(inbox, req["nonce"] + ".json"))


def wait_result(d, nonce, timeout):
    p = os.path.join(d, "results", nonce + ".json"); end = time.time() + timeout
    while time.time() < end:
        try:
            r = json.load(open(p, encoding="utf-8")); return r
        except (OSError, ValueError): time.sleep(0.5)
    return None


def load_ask(qid):
    import ask_iddo
    try: return json.load(open(os.path.join(ask_iddo.ROOT, qid + ".json"), encoding="utf-8"))
    except (OSError, ValueError): return None


def show_window(ask, timeout, d):
    """Returns (chosen_answer or None). Writes the request itself on click, then waits for Agent Desktop's verdict in the same window."""
    import tkinter as tk
    nonce = secrets.token_hex(16); key = read_key(d); out = {"answer": None, "result": None}
    root = tk.Tk(); root.title("Answer once - " + ask.get("agent", "agent")); root.attributes("-topmost", True); root.resizable(False, False)
    pad = {"padx": 14, "pady": 6}
    tk.Label(root, text="Question from " + ask.get("agent", "?"), font=("Segoe UI", 10, "bold"), anchor="w").pack(fill="x", **pad)
    tk.Label(root, text=ask["question"], font=("Segoe UI", 11), wraplength=460, justify="left", anchor="w").pack(fill="x", **pad)
    ctx = (ask.get("context") or "").strip()
    if ctx: tk.Label(root, text=ctx[:400] + ("..." if len(ctx) > 400 else ""), font=("Segoe UI", 9), fg="#555", wraplength=460, justify="left", anchor="w").pack(fill="x", **pad)
    status = tk.Label(root, text="Your click is typed into " + ask.get("agent", "the agent") + "'s chat as your own message.", font=("Segoe UI", 9), fg="#555", wraplength=460, justify="left")
    status.pack(fill="x", **pad)
    row = tk.Frame(root); row.pack(**pad); btns = []

    def done(): root.after(2500, root.destroy)

    def poll(end):
        r = wait_result_once(d, nonce)
        if r is not None:
            out["result"] = r; status.config(text=("Delivered to " + ask.get("agent", "the agent") + ".") if r.get("ok") else ("Not delivered: " + str(r.get("error"))), fg="#2e7d32" if r.get("ok") else "#b3261e"); return done()
        if time.time() > end:
            out["result"] = {"ok": False, "error": "Agent Desktop did not pick it up (is it running?)"}; status.config(text="Agent Desktop did not pick it up. Is it running?", fg="#b3261e"); return done()
        root.after(500, lambda: poll(end))

    def click(label):
        for b in btns: b.config(state="disabled")
        req = make_request(key, ask, label, nonce=nonce); write_request(d, req); out["answer"] = label
        status.config(text="Sending: " + label + " ...", fg="#1d6fd6"); poll(time.time() + 60)

    for label in ask["quick"]:
        b = tk.Button(row, text=label, width=14, font=("Segoe UI", 10, "bold"), state="disabled", command=lambda l=label: click(l)); b.pack(side="left", padx=6); btns.append(b)
    nb = tk.Button(row, text="Not now", width=10, font=("Segoe UI", 10), command=root.destroy); nb.pack(side="left", padx=6)
    root.after(700, lambda: [b.config(state="normal") for b in btns])      # a click made while it pops up cannot answer by accident
    root.after(int(timeout * 1000), lambda: out["answer"] is None and root.destroy())
    try:
        import winsound; winsound.MessageBeep()
    except Exception: pass
    root.update_idletasks(); w, h = root.winfo_reqwidth(), root.winfo_reqheight()
    root.geometry("+%d+%d" % ((root.winfo_screenwidth() - w) // 2, (root.winfo_screenheight() - h) // 3)); root.focus_force()
    root.mainloop()
    return out


def wait_result_once(d, nonce):
    try: return json.load(open(os.path.join(d, "results", nonce + ".json"), encoding="utf-8"))
    except (OSError, ValueError): return None


def main(argv=None):
    ap = argparse.ArgumentParser(prog="ask_confirm.py"); ap.add_argument("id"); ap.add_argument("--timeout", type=float, default=600)
    n = ap.parse_args(argv)
    ask = load_ask(n.id)
    if not ask: print("NOT DELIVERED: no such open question (already answered?)"); return 1
    if not ask.get("quick"): print("NOT DELIVERED: this question has no quick answers; the owner answers it in Agent Desktop's waiting bar"); return 1
    d = state_dir()
    out = show_window(ask, n.timeout, d)
    if out["answer"] is None: print("CANCELLED (no click)"); return 2
    r = out["result"]
    if r and r.get("ok"): print("DELIVERED: " + out["answer"] + " -> " + ask.get("agent", "")); return 0
    print("NOT DELIVERED: " + str((r or {}).get("error") or "the window was closed before Agent Desktop answered (it may still arrive: check ask_iddo.py list)")); return 1


if __name__ == "__main__":
    sys.exit(main())
