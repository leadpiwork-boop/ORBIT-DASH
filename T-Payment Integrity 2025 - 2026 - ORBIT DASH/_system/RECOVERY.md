# ORBIT Dashboard - Local Version Control & Recovery Guide

This folder uses **`orbit_vcs.py`**, a Python-based local snapshot system
(Python 3.12, already installed - no external tools, no Git, no cloud).
Every snapshot lives in `.versions\` and can be restored in seconds.

## Quick reference

```powershell
cd "C:\Users\AL70683\OneDrive - Elevance Health\IGNITE PROJECTS\ORBIT\ORBIT DASH"
```

### See history / pending changes
```powershell
python orbit_vcs.py log        # list all snapshots (newest first)
python orbit_vcs.py status     # files changed since latest snapshot
python orbit_vcs.py show 0003_20261001_120000   # files inside a snapshot
```

### Save a snapshot (after any major change)
```powershell
.\Commit_ORBIT.ps1 -Message "Monthly Performance enhancements"
# or directly:
python orbit_vcs.py commit "your message"
```

Commit after: branding updates, KPI logic changes, Monthly Performance
enhancements, Daily Detail enhancements, tooltip updates, etc.

### Recover after a rollback / bad change

**Everything (full rollback to latest snapshot):**
```powershell
.\Restore_ORBIT.ps1
# or:
python orbit_vcs.py restore
```

**One file only:**
```powershell
python orbit_vcs.py restore -- ORBIT.html
python orbit_vcs.py restore -- orbit-app.js orbit.css
```

**An older snapshot (not the latest):**
```powershell
python orbit_vcs.py log                                  # find the id
python orbit_vcs.py restore 0002_20260930_1758           # all files from it
python orbit_vcs.py restore 0002_20260930_1758 ORBIT.html  # one file from it
```

Or via the wrapper: `.\Restore_ORBIT.ps1 -SnapshotId 0002_20260930_1758 -Files ORBIT.html`

## What is tracked

| Tracked (snapshotted)                          | Ignored (regenerated / backups)  |
|------------------------------------------------|----------------------------------|
| `ORBIT.html`, `orbit-app.js`, `orbit.css`      | `prod_raw.csv`, `qa_raw.csv`     |
| `orbit_vcs.py`, refresh/commit/restore scripts | `assoc_raw.csv`, `orbit-data.js` |
| `chart.umd.min.js`, `assets\` (logos)          | `BACKUP\`, `.versions\` itself   |

## Belt-and-suspenders

- `Refresh_ORBIT.ps1` STEP 0 still writes a timestamped copy to `BACKUP\` on every run.
- `.versions\` snapshots are the primary recovery path; `BACKUP\` is secondary.
- Both folders live in OneDrive, so snapshots survive even a local wipe.
- Ignored data files are regenerated anytime via `Refresh_ORBIT.bat`.
