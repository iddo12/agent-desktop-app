#!/usr/bin/env python3
r"""sealed_verify.py - verify an Agent Desktop "sealed answer" (2026-11-01, Security). Public key only: this file holds no secret and cannot make a seal.

Agent Desktop signs the owner's click on a "waiting for you" answer (Ed25519, key wrapped with Windows DPAPI inside Agent Desktop's state folder)
and stores the seal in the question record. `ask_iddo.py verify <id>` calls verify_record() here. Rules (same as agent-desktop src/sealedAnswers.js):
the seal must be for THIS id, signed by the published Agent Desktop key, bound to the question text + asking agent + quick answers as they are NOW
(an edited question fails), the record's answer must equal the sealed one, and its time must not be in the future or before the question existed.
Public key: <state dir>\pub.json, state dir = %LOCALAPPDATA%\AgentDesktop\sealed-answers (override AGENT_DESKTOP_SEALED_DIR).
Plain limit: a hostile process running as the same Windows user could use DPAPI too; this stops agent claims and `resolve`, not that. Details: shared_docs\sealed_answers_2026-11-01.md"""
import base64, datetime as dt, hashlib, json, os, re, sys, time

# ---- Ed25519 verify (RFC 8032 section 6, pure Python; fine for a handful of verifications) ----
_p = 2**255 - 19
_q = 2**252 + 27742317777372353535851937790883648493
_d = -121665 * pow(121666, _p - 2, _p) % _p
_I = pow(2, (_p - 1) // 4, _p)


def _recover_x(y, sign):
    if y >= _p: return None
    x2 = (y * y - 1) * pow(_d * y * y + 1, _p - 2, _p) % _p
    if x2 == 0: return None if sign else 0
    x = pow(x2, (_p + 3) // 8, _p)
    if (x * x - x2) % _p != 0: x = x * _I % _p
    if (x * x - x2) % _p != 0: return None
    if (x & 1) != sign: x = _p - x
    return x


_gy = 4 * pow(5, _p - 2, _p) % _p
_G = (_recover_x(_gy, 0), _gy, 1, _recover_x(_gy, 0) * _gy % _p)


def _add(P, Q):
    A, B = (P[1] - P[0]) * (Q[1] - Q[0]) % _p, (P[1] + P[0]) * (Q[1] + Q[0]) % _p
    C, D = 2 * P[3] * Q[3] * _d % _p, 2 * P[2] * Q[2] % _p
    E, F, G, H = B - A, D - C, D + C, B + A
    return (E * F % _p, G * H % _p, F * G % _p, E * H % _p)


def _mul(s, P):
    Q = (0, 1, 1, 0)
    while s > 0:
        if s & 1: Q = _add(Q, P)
        P = _add(P, P); s >>= 1
    return Q


def _eq(P, Q):
    return (P[0] * Q[2] - Q[0] * P[2]) % _p == 0 and (P[1] * Q[2] - Q[1] * P[2]) % _p == 0


def _decode(s):
    if len(s) != 32: return None
    y = int.from_bytes(s, "little"); sign = y >> 255; y &= (1 << 255) - 1
    x = _recover_x(y, sign)
    return None if x is None else (x, y, 1, x * y % _p)


def ed25519_verify(pub, msg, sig):
    if len(pub) != 32 or len(sig) != 64: return False
    A = _decode(pub); R = _decode(sig[:32])
    if A is None or R is None: return False
    s = int.from_bytes(sig[32:], "little")
    if s >= _q: return False
    h = int.from_bytes(hashlib.sha512(sig[:32] + pub + msg).digest(), "little") % _q
    return _eq(_mul(s, _G), _add(R, _mul(h, A)))


# ---- seal rules ----
ID_RX = re.compile(r"\d{8}-\d{6}-[0-9a-f]{4}"); NONCE_RX = re.compile(r"[0-9a-f]{32}")
FUTURE_SKEW_MS = PREDATE_SKEW_MS = 2 * 60 * 1000


def state_dir(override=None):
    """The public key's folder. The environment is NOT consulted (an agent could point it at its own key); tests pass `override` (--pub-dir)."""
    if override: return override
    if sys.platform == "win32":
        return os.path.join(os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local"), "AgentDesktop", "sealed-answers")
    return os.path.join(os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state"), "agent-desktop", "sealed-answers")


def load_pub(d=None):
    try:
        p = json.load(open(os.path.join(d or state_dir(), "pub.json"), encoding="utf-8"))
        return p if isinstance(p, dict) else None
    except (OSError, ValueError): return None


def qhash(ask):
    """v2 (same as src/sealedAnswers.js): canonical JSON of question, agent, quick, context, merav flag and created; full SHA-256."""
    q = ask.get("quick") or []
    doc = ["qh2", str(ask["question"]), "" if ask.get("agent") is None else str(ask["agent"]), [str(x) for x in q],
           "" if ask.get("context") is None else str(ask["context"]), bool(ask.get("merav")), "" if ask.get("created") is None else str(ask["created"])]
    return hashlib.sha256(json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def message(s):
    return "\x1f".join(["sealed-answer-v1", s["id"], s["answer"], s["qhash"], s["via"], str(s["ts"]), s["nonce"], s["kid"]]).encode("utf-8")


def _parse_ts(v):
    try: return dt.datetime.fromisoformat(str(v)).timestamp() * 1000
    except (ValueError, TypeError, OverflowError, OSError): return None


def check(ask, pub=None, now_ms=None, max_age_s=None, pub_dir=None):
    """Returns (ok, reason_or_None, seal). ask = the question record (open or answered)."""
    seal = ask.get("seal") if isinstance(ask, dict) else None
    if not isinstance(seal, dict): return False, "unsealed (no seal in the record)", None
    now_ms = time.time() * 1000 if now_ms is None else now_ms
    pub = pub if pub is not None else load_pub(pub_dir)
    try:
        if seal.get("v") != 1: return False, "unknown seal version", seal
        if not ID_RX.fullmatch(str(ask.get("id", ""))) or seal.get("id") != ask.get("id"): return False, "seal is for another question id", seal
        if not isinstance(seal.get("answer"), str) or not seal["answer"] or len(seal["answer"]) > 600: return False, "bad answer", seal
        if seal.get("via") not in ("button", "typed"): return False, "bad via", seal
        if not NONCE_RX.fullmatch(str(seal.get("nonce", ""))): return False, "bad nonce", seal
        if isinstance(seal.get("ts"), bool) or not isinstance(seal.get("ts"), (int, float)): return False, "bad time", seal
        if not pub or not re.match(r"^[0-9a-f]{64}$", str(pub.get("pub", ""))): return False, "Agent Desktop's public key is not available (pub.json)", seal
        if seal.get("kid") != pub.get("kid") or hashlib.sha256(bytes.fromhex(pub["pub"])).hexdigest()[:16] != pub.get("kid"):
            return False, "seal key is not the published Agent Desktop key", seal
        if seal.get("qhash") != qhash(ask): return False, "the question, its agent or its quick answers changed after the answer", seal
        if ask.get("answer") is not None and ask["answer"] != seal["answer"]: return False, "record answer differs from the sealed answer", seal
        if not ed25519_verify(bytes.fromhex(pub["pub"]), message(seal), base64.b64decode(str(seal.get("sig", "")), validate=True)): return False, "signature does not verify", seal
    except Exception as e:                          # a malformed record must never crash list/show
        return False, "malformed seal (%s)" % e.__class__.__name__, seal
    if seal["ts"] > now_ms + FUTURE_SKEW_MS: return False, "seal is dated in the future", seal
    try: created = _parse_ts(ask.get("created"))
    except Exception: created = None
    if created is not None and seal["ts"] < created - PREDATE_SKEW_MS: return False, "seal is older than the question", seal
    if max_age_s is not None and now_ms - seal["ts"] > max_age_s * 1000: return False, "seal is older than the allowed age", seal
    return True, None, seal


def status(ask, pub=None, pub_dir=None):
    """One-line label for list/show."""
    ok, why, seal = check(ask, pub, pub_dir=pub_dir)
    if ok: return "sealed by the owner (UI)"
    return "unsealed" if seal is None else "INVALID seal: " + why
