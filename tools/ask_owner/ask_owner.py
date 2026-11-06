#!/usr/bin/env python3
"""ask_iddo.py - register a question that waits for the owner, so Agent Desktop's "waiting for you" bar shows it.   (2026-10-13)

Every agent runs this whenever it ends a turn needing an answer from the owner (a decision, a go/no-go, a missing fact):
    python "<path>/ask_owner.py" add --agent "Security" --question "May I restart the NAS app?" \
        [--context "2-4 sentences of background so he can answer without opening your chat"] [--quick "Yes|No"] [--merav]
It prints the question id. When the question is answered (or no longer needed) the agent runs:
    ask_iddo.py resolve ID           (Agent Desktop also resolves it itself when the owner answers from the queue)
    ask_iddo.py list [--agent NAME]  (open questions)
    ask_iddo.py verify ID [--json] [--max-age-hours N]   (exit 0 + prints the answer ONLY if the owner's click in Agent Desktop sealed it; see below)
    ask_iddo.py show ID              (the record + "sealed by the owner (UI)" / "unsealed" / "INVALID seal: why")
    ask_iddo.py confirm ID           (answer once: pops a window, his click is delivered into the ASKING agent's chat; run in background)
One open question per agent is normal; ask one at a time. Files: <workspace>/shared_state/open_questions/id>.json
(answered ones move to answered\\). --agent must be the agent's folder name as shown in Agent Desktop (e.g. "Security",
"Software Engineering Agent"); a close name is fine, it is matched case-insensitively on the folder name or its first word.
SEALED ANSWERS (2026-11-01): when the owner answers in Agent Desktop's "waiting for you" bar (or an inline ask card), Agent Desktop signs his click (Ed25519) and
stores the seal in the record. `verify ID` checks it with the public key only and exits 0 printing the answer: a verified seal counts as the owner's own words for
pre-approval. `resolve` (any agent) NEVER seals: it marks the record resolved_by "agent-cli" and verify then fails ("unsealed"). Doc: shared_docs\\sealed_answers_2026-11-01.md"""
import argparse, datetime as dt, json, os, re, sys, uuid

import sys as _sys, pathlib as _pl
_sys.path.insert(0, str(_pl.Path(__file__).resolve().parent.parent if __import__('os').path.basename(str(_pl.Path(__file__).resolve().parent))=='tasks' else _pl.Path(__file__).resolve().parent))
import workspace_config as _wc
ROOT = os.environ.get("OPEN_QUESTIONS_DIR", os.path.join(str(_wc.workspace_root()), "shared_state", "open_questions"))


def _now():
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def add(agent, question, context="", quick=(), merav=False, default="", by_hours=None, klass="", task=""):
    question = " ".join(str(question).split())
    if not agent.strip() or not question: raise SystemExit("agent and question are required")
    os.makedirs(ROOT, exist_ok=True)
    for f in os.listdir(ROOT):                          # same agent + same text = refresh, not a duplicate
        if f.endswith(".json"):
            try: d = json.load(open(os.path.join(ROOT, f), encoding="utf-8"))
            except (OSError, ValueError): continue
            if d.get("agent", "").lower() == agent.lower() and d.get("question") == question:
                return d["id"]
    qid = dt.datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
    d = {"id": qid, "agent": agent.strip(), "question": question[:600], "context": str(context).strip()[:1500],
         "quick": [q.strip() for q in quick if q.strip()][:4], "merav": bool(merav), "created": _now()}
    if task: d["task"] = str(task).strip()[:120]      # linked task id: closing that task (tasks.py --close) resolves this ask automatically
    if default:                                          # autopilot (2026-10-23): a recommended default + deadline; reversible ones auto-apply
        d["default"] = str(default).strip()[:300]
        d["class"] = klass if klass in ("reversible", "irreversible") else "irreversible"
        d["deadline"] = (dt.datetime.now().astimezone() + dt.timedelta(hours=float(by_hours if by_hours is not None else 24))).isoformat(timespec="seconds")
    tmp = os.path.join(ROOT, qid + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f: json.dump(d, f, ensure_ascii=False, indent=1)
    os.replace(tmp, os.path.join(ROOT, qid + ".json"))
    return qid


def resolve(qid):
    src = os.path.join(ROOT, qid + ".json")
    if not os.path.isfile(src): return False
    try:                                                 # an agent's resolve is recorded as such and can never carry a seal of its own
        d = json.load(open(src, encoding="utf-8")); d.setdefault("resolved_by", "agent-cli"); d.setdefault("resolved_at", _now())
        tmp = src + ".res.tmp"
        with open(tmp, "w", encoding="utf-8", newline="\n") as f: json.dump(d, f, ensure_ascii=False, indent=1)
        os.replace(tmp, src)
    except (OSError, ValueError): pass
    os.makedirs(os.path.join(ROOT, "answered"), exist_ok=True)
    os.replace(src, os.path.join(ROOT, "answered", qid + ".json"))
    return True


def apply_defaults(dry=False):
    """Resolve open REVERSIBLE questions whose deadline passed: the default becomes the answer ("FYI: went with ...")."""
    now, out = dt.datetime.now().astimezone(), []
    for d in listing():
        if d.get("default") and d.get("class") == "reversible" and d.get("deadline") and dt.datetime.fromisoformat(d["deadline"]) <= now:
            out.append({"id": d["id"], "agent": d["agent"], "default": d["default"]})
            if not dry:
                d.update(answer=d["default"], auto_applied=True, answered=_now())
                src = os.path.join(ROOT, d["id"] + ".json")
                with open(src, "w", encoding="utf-8", newline="\n") as f: json.dump(d, f, ensure_ascii=False, indent=1)
                resolve(d["id"])
    return out


def listing(agent=None, answered=False):
    out = []
    base = os.path.join(ROOT, "answered") if answered else ROOT
    if os.path.isdir(base):
        for f in sorted(os.listdir(base)):
            if f.endswith(".json"):
                try: d = json.load(open(os.path.join(base, f), encoding="utf-8"))
                except (OSError, ValueError): continue
                if not agent or d.get("agent", "").lower() == agent.lower(): out.append(d)
    return out


def find(qid):
    """The record of an open or answered question, or None."""
    if not re.fullmatch(r"[\w-]+", str(qid)): return None
    for p in (os.path.join(ROOT, qid + ".json"), os.path.join(ROOT, "answered", qid + ".json")):
        try:
            d = json.load(open(p, encoding="utf-8-sig"))
            if isinstance(d, dict) and d.get("id") == qid: return d
        except (OSError, ValueError): continue
    return None


def seal_status(d, pub_dir=None):
    import sealed_verify
    if "resolved_by" in d and not d.get("seal"): return "unsealed (resolved by an agent)"
    return sealed_verify.status(d, pub_dir=pub_dir)


def verify(qid, as_json=False, max_age_hours=None, pub_dir=None, expect_agent=None, expect_question=None):
    """Exit 0 and print the answer only if the owner's UI seal is valid for this exact id and the question as it is now."""
    import sealed_verify
    d = find(qid)
    if d is None: print("NOT VERIFIED: no such question", file=sys.stderr); return 2
    ok, why, seal = sealed_verify.check(d, max_age_s=None if max_age_hours is None else max_age_hours * 3600, pub_dir=pub_dir)
    if not ok: print("NOT VERIFIED: " + why, file=sys.stderr); return 1
    if expect_agent and expect_agent.strip().lower() != str(d.get("agent", "")).strip().lower(): print("NOT VERIFIED: the sealed question was asked by %r, not %r" % (d.get("agent"), expect_agent), file=sys.stderr); return 1
    if expect_question and expect_question.strip().lower() not in str(d.get("question", "")).lower(): print("NOT VERIFIED: the sealed question does not contain %r" % expect_question, file=sys.stderr); return 1
    # the id alone proves nothing: the owner said this to THAT question. Show it on stderr so the caller compares it with its own action.
    print("sealed question (%s): %s" % (d.get("agent"), d["question"]) + ((" | context: " + str(d["context"])[:300]) if d.get("context") else ""), file=sys.stderr)
    if as_json: print(json.dumps({"id": d["id"], "agent": d.get("agent"), "question": d["question"], "answer": seal["answer"], "via": seal["via"], "ts": seal["ts"], "kid": seal["kid"]}, ensure_ascii=False))
    else: print(seal["answer"])
    return 0


def main(argv=None):
    for st in (sys.stdout, sys.stderr):                  # Hebrew/emoji answers must print on a cp1252 console too
        try: st.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError): pass
    ap = argparse.ArgumentParser(prog="ask_iddo.py"); sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add"); a.add_argument("--agent", required=True); a.add_argument("--question", required=True)
    a.add_argument("--context", default=""); a.add_argument("--quick", default=""); a.add_argument("--merav", action="store_true")
    a.add_argument("--default", default="", help="recommended answer; applied at the deadline if --class reversible")
    a.add_argument("--by", type=float, default=None, help="hours until the deadline (default 24)")
    a.add_argument("--class", dest="klass", default="", choices=["", "reversible", "irreversible"])
    a.add_argument("--task", default="", help="task id this question belongs to; closing the task resolves the question")
    r = sub.add_parser("resolve"); r.add_argument("id")
    v = sub.add_parser("verify", help="exit 0 + print the answer only if the owner's UI click sealed it"); v.add_argument("id"); v.add_argument("--json", action="store_true"); v.add_argument("--max-age-hours", type=float, default=None)
    v.add_argument("--expect-agent", default=None, help="fail unless the sealed question was asked by this agent"); v.add_argument("--expect-question", default=None, help="fail unless the sealed question text contains this (case-insensitive)")
    v.add_argument("--pub-dir", default=None, help="TEST ONLY: folder with another pub.json")
    sh = sub.add_parser("show", help="print a question record with its seal status"); sh.add_argument("id"); sh.add_argument("--pub-dir", default=None)
    sub.add_parser("apply-defaults").add_argument("--dry-run", action="store_true")
    l = sub.add_parser("list"); l.add_argument("--agent"); l.add_argument("--answered", action="store_true", help="list answered questions (with seal status) instead of open ones"); l.add_argument("--pub-dir", default=None)
    c = sub.add_parser("confirm", help="pop a window; the owner's click answers once, wherever he talks (see ask_confirm.py)"); c.add_argument("id"); c.add_argument("--timeout", type=float, default=600)
    n = ap.parse_args(argv)
    if getattr(n, "pub_dir", None) and os.environ.get("ASK_IDDO_TEST") != "1":
        print("--pub-dir is test-only (set ASK_IDDO_TEST=1)", file=sys.stderr); return 2
    if n.cmd == "add": print(add(n.agent, n.question, n.context, n.quick.split("|") if n.quick else (), n.merav, n.default, n.by, n.klass, n.task))
    elif n.cmd == "apply-defaults": print(json.dumps(apply_defaults(n.dry_run), ensure_ascii=False))
    elif n.cmd == "confirm":
        import ask_confirm; return ask_confirm.main([n.id, "--timeout", str(n.timeout)])
    elif n.cmd == "verify": return verify(n.id, n.json, n.max_age_hours, n.pub_dir, n.expect_agent, n.expect_question)
    elif n.cmd == "show":
        d = find(n.id)
        if d is None: print("no such question"); return 1
        print("seal: " + seal_status(d, n.pub_dir)); print(json.dumps({k: v for k, v in d.items() if k != "seal"}, ensure_ascii=False, indent=1)); return 0
    elif n.cmd == "resolve":
        ok = resolve(n.id); print("resolved" if ok else "no such open question"); return 0 if ok else 1
    else:
        rows = listing(n.agent, answered=n.answered)
        for d in rows: d["seal_status"] = seal_status(d, n.pub_dir) if n.answered else "open"
        print(json.dumps(rows, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())


def resolve_for_task(task_id, agent=""):
    """Resolve every open ask linked to task_id (add --task). Returns the ids resolved. Never seals."""
    out = []
    try: names = os.listdir(ROOT)
    except OSError: return out
    for f in names:
        if not f.endswith(".json"): continue
        try: d = json.load(open(os.path.join(ROOT, f), encoding="utf-8"))
        except (OSError, ValueError): continue
        if d.get("task") == task_id and (not agent or d.get("agent", "").lower() == agent.lower()):
            if resolve(d["id"]): out.append(d["id"])
    return out
