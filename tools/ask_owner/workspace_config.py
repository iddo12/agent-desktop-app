"""workspace_config - ONE place that says where this workspace lives (owner standing order 2026-10-14: nothing hard-coded).

Use it from any shared tool instead of writing a drive letter or a person's name:

    import sys, pathlib
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))   # the shared_tools folder
    import workspace_config as wc
    wc.workspace_root()            # Path: the folder that contains one sub-folder per agent
    wc.scratch_root()              # Path: big/throwaway files (renders, builds, intermediates)
    wc.get("owner.name")           # text or None;  wc.get("premiere.bridge_dir") etc.

Resolution order for every key (first hit wins):
  1. environment variable  WS_<KEY>  (dots become underscores, upper case), e.g. WS_WORK_ROOT, WS_OWNER_NAME
  2. the config file       <shared_tools>/workspace_config.json   (override the file with env WS_CONFIG_FILE)
  3. automatic default     workspace_root = the folder above shared_tools; scratch_root = <workspace_root>/_scratch
Nothing here names a drive, a user or a company. A missing value is None, never an exception.

Config file format (flat JSON, dotted keys or nested objects both work):
    { "workspace_root": "...", "scratch_root": "...", "extra_source_roots": ["..."],
      "owner": {"name": "...", "email": "..."}, "premiere": {"bridge_dir": "..."} }

CLI:  python workspace_config.py            print every resolved key and where it came from
      python workspace_config.py KEY        print one value (empty + exit 1 if unset)
Tests: python workspace_config.py --selftest
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG_NAME = "workspace_config.json"

# keys that hold a folder (Path) / a list of folders; everything else is plain text
PATH_KEYS = {"workspace_root", "scratch_root", "premiere.bridge_dir", "wordpress.ssh_key", "wordpress.backup_dir"}
LIST_KEYS = {"extra_source_roots"}
KNOWN_KEYS = ["workspace_root", "scratch_root", "extra_source_roots", "owner.name", "owner.email",
              "premiere.bridge_dir", "wordpress.ssh_host", "wordpress.ssh_key", "wordpress.default_author_id",
              "wordpress.backup_dir"]


def _env_name(key: str) -> str:
    return "WS_" + key.replace(".", "_").upper()


def _config_file() -> Path:
    return Path(os.environ.get("WS_CONFIG_FILE") or (HERE / CONFIG_NAME))


def _load_file() -> dict:
    p = _config_file()
    try:
        txt = p.read_text(encoding="utf-8-sig")
        d = json.loads(txt)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _flatten(d: dict, prefix: str = "") -> dict:
    out = {}
    for k, v in d.items():
        key = prefix + str(k)
        if isinstance(v, dict):
            out.update(_flatten(v, key + "."))
        else:
            out[key] = v
    return out


def _coerce(key: str, v):
    if v is None or v == "":
        return None
    if key in LIST_KEYS:
        if isinstance(v, str):
            v = [x for x in v.split(os.pathsep) if x.strip()]
        return [Path(x) for x in v] if v else None
    if key in PATH_KEYS:
        return Path(str(v))
    return v if isinstance(v, str) else str(v)


def source(key: str):
    """-> (value, where) where is 'env' | 'file' | 'auto' | 'unset'."""
    env = os.environ.get(_env_name(key))
    if env:
        return _coerce(key, env), "env"
    flat = _flatten(_load_file())
    if key in flat and _coerce(key, flat[key]) is not None:
        return _coerce(key, flat[key]), "file"
    if key == "workspace_root":
        return HERE.parent, "auto"
    if key == "scratch_root":
        return workspace_root() / "_scratch", "auto"
    return None, "unset"


def get(key: str, default=None):
    v, _ = source(key)
    return default if v is None else v


def workspace_root() -> Path:
    return get("workspace_root")


def scratch_root() -> Path:
    return get("scratch_root")


def extra_source_roots() -> list:
    return get("extra_source_roots", []) or []


def agent_dir(name: str) -> Path:
    """<workspace_root>/<agent folder name>"""
    return workspace_root() / name


def _selftest() -> int:
    ok = True

    def check(cond, msg):
        nonlocal ok
        print(("ok   " if cond else "FAIL ") + msg)
        ok = ok and bool(cond)

    saved = {k: os.environ.pop(k) for k in list(os.environ) if k.startswith("WS_")}
    try:
        with tempfile.TemporaryDirectory() as td:
            os.environ["WS_CONFIG_FILE"] = str(Path(td) / "none.json")
            check(workspace_root() == HERE.parent, "auto workspace_root = folder above shared_tools")
            check(scratch_root() == HERE.parent / "_scratch", "auto scratch_root")
            check(get("owner.name") is None, "unset key is None")
            cfg = Path(td) / "c.json"
            cfg.write_text(json.dumps({"workspace_root": str(Path(td) / "w"), "owner": {"name": "Alex"},
                                       "extra_source_roots": [str(Path(td) / "x")]}), encoding="utf-8-sig")
            os.environ["WS_CONFIG_FILE"] = str(cfg)
            check(workspace_root() == Path(td) / "w", "file overrides auto")
            check(get("owner.name") == "Alex", "nested key from file")
            check(extra_source_roots() == [Path(td) / "x"], "list key from file")
            os.environ["WS_OWNER_NAME"] = "Sam"
            check(get("owner.name") == "Sam", "env overrides file")
            os.environ["WS_EXTRA_SOURCE_ROOTS"] = os.pathsep.join(["a", "b"])
            check(extra_source_roots() == [Path("a"), Path("b")], "list from env (path separator)")
            cfg.write_text("{broken", encoding="utf-8")
            os.environ.pop("WS_OWNER_NAME")
            check(get("owner.name") is None, "broken file never raises")
        import re
        src = (HERE / "workspace_config.py").read_text(encoding="utf-8")
        lines = [ln for ln in src.splitlines() if "re.findall" not in ln]
        bad = re.findall(r"[A-Za-z]:[\\/][A-Za-z]", chr(10).join(lines))
        check(not bad, "no drive-path literal in this module")
    finally:
        for k in list(os.environ):
            if k.startswith("WS_"):
                os.environ.pop(k)
        os.environ.update(saved)
    print("PASS" if ok else "FAILED")
    return 0 if ok else 1


def main(argv) -> int:
    if len(argv) > 1 and argv[1] == "--selftest":
        return _selftest()
    if len(argv) > 1:
        v, _ = source(argv[1])
        if v is None:
            return 1
        print(os.pathsep.join(map(str, v)) if isinstance(v, list) else v)
        return 0
    print("config file:", _config_file(), "(exists)" if _config_file().exists() else "(none)")
    for k in KNOWN_KEYS:
        v, w = source(k)
        print(f"  {k:28s} [{w:5s}] {os.pathsep.join(map(str, v)) if isinstance(v, list) else v}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
