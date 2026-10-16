#!/usr/bin/env python3
"""ORBIT Dashboard - local snapshot version control.

Stores timestamped snapshots of tracked files in .versions/ so any
rollback (e.g. OneDrive sync conflicts) can be undone in seconds.

Usage:
    python orbit_vcs.py commit "message"      snapshot all tracked files
    python orbit_vcs.py log                   list snapshots
    python orbit_vcs.py status                show changed files vs latest
    python orbit_vcs.py restore [id] [files]  restore all or specific files
    python orbit_vcs.py show <id>             list files in a snapshot
"""
import hashlib
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

# The VCS script lives inside _system/ but tracks files in the DASH root (parent).
# STORE and BACKUP remain inside _system/ so they never appear to end users.
ROOT  = Path(__file__).resolve().parent.parent   # ORBIT DASH\ root
SYS   = Path(__file__).resolve().parent          # ORBIT DASH\_system\
STORE = SYS / ".versions"
LOG_FILE = STORE / "log.json"

# Regenerated data + backend folders are never tracked
IGNORE = {
    "prod_raw.csv", "qa_raw.csv", "assoc_raw.csv", "orbit-data.js",
    "orbit_vcs.py",
}
IGNORE_DIRS = {"_system", ".git"}


def tracked_files():
    files = []
    for p in ROOT.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(ROOT)
        if rel.parts[0] in IGNORE_DIRS or p.name in IGNORE:
            continue
        files.append(rel)
    return sorted(files)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def load_log():
    if LOG_FILE.exists():
        return json.loads(LOG_FILE.read_text(encoding="utf-8"))
    return []


def save_log(log):
    STORE.mkdir(exist_ok=True)
    LOG_FILE.write_text(json.dumps(log, indent=2), encoding="utf-8")


def cmd_commit(message):
    files = tracked_files()
    log = load_log()
    snap_id = f"{len(log) + 1:04d}_{datetime.now():%Y%m%d_%H%M%S}"
    dest = STORE / snap_id

    manifest = {}
    for rel in files:
        src = ROOT / rel
        tgt = dest / rel
        tgt.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, tgt)
        manifest[str(rel)] = sha256(src)

    (dest / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8")
    log.append({"id": snap_id, "message": message,
                "time": datetime.now().isoformat(timespec="seconds"),
                "files": len(files)})
    save_log(log)
    print(f"Snapshot {snap_id} saved ({len(files)} files): {message}")


def cmd_log():
    log = load_log()
    if not log:
        print("No snapshots yet.")
        return
    for e in reversed(log):
        print(f"  {e['id']}  {e['time']}  ({e['files']} files)  {e['message']}")


def latest_manifest():
    log = load_log()
    if not log:
        return None, {}
    snap = STORE / log[-1]["id"] / "manifest.json"
    return log[-1]["id"], json.loads(snap.read_text(encoding="utf-8"))


def cmd_status():
    snap_id, manifest = latest_manifest()
    if not snap_id:
        print("No snapshots yet - nothing to compare against.")
        return
    print(f"Comparing working files vs snapshot {snap_id}:")
    changed = missing = 0
    current = {str(p): p for p in tracked_files()}
    for rel in sorted(set(manifest) | set(current)):
        if rel not in current:
            print(f"  DELETED   {rel}")
            missing += 1
        elif rel not in manifest:
            print(f"  NEW       {rel}")
            changed += 1
        elif sha256(ROOT / rel) != manifest[rel]:
            print(f"  MODIFIED  {rel}")
            changed += 1
    if not changed and not missing:
        print("  (clean - no changes)")


def cmd_restore(args):
    log = load_log()
    if not log:
        print("No snapshots to restore from.")
        return
    args = [a for a in args if a != "--"]
    snap_id, files = log[-1]["id"], args
    if args and (STORE / args[0]).is_dir():
        snap_id, files = args[0], args[1:]
    snap_dir = STORE / snap_id
    manifest = json.loads((snap_dir / "manifest.json").read_text(encoding="utf-8"))

    targets = [Path(f) for f in files] if files else [Path(r) for r in manifest]
    for rel in targets:
        src = snap_dir / rel
        if not src.exists():
            print(f"  ! {rel} not in snapshot {snap_id}, skipped")
            continue
        dest = ROOT / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        print(f"  restored  {rel}")
    print(f"Done - restored from snapshot {snap_id}")


def cmd_show(snap_id):
    snap = STORE / snap_id / "manifest.json"
    if not snap.exists():
        print(f"Snapshot {snap_id} not found.")
        return
    manifest = json.loads(snap.read_text(encoding="utf-8"))
    for rel in sorted(manifest):
        print(f"  {rel}")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "commit":
        if not args:
            print('Usage: python orbit_vcs.py commit "message"')
            return
        cmd_commit(" ".join(args))
    elif cmd == "log":
        cmd_log()
    elif cmd == "status":
        cmd_status()
    elif cmd == "restore":
        cmd_restore(args)
    elif cmd == "show":
        cmd_show(args[0]) if args else print("Usage: show <id>")
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
