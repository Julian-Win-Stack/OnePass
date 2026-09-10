#!/usr/bin/env python3
"""Pick the N longest Terminal-Bench 2.0 tasks, from the dataset's own metadata.

Eviction only fires on a session that gets long, and most Terminal-Bench tasks do not. The
dataset ships two length signals per task in ``task.toml``: ``[agent] timeout_sec``, the wall
clock the agent is allowed, and ``[metadata] expert_time_estimate_min``, a human's estimate of
the work. The agent timeout is the binding one — a task capped at 900s cannot produce a long
session however hard it is — so tasks are ranked by it, with the expert estimate as the
tie-break and the task name as a final deterministic tie-break.

The result is committed as ``tasks.txt`` so a run is reproducible without re-deriving it. Rerun
this only to regenerate that file:

    python3 select_tasks.py --n 20 --out tasks.txt

Reads the same registry Harbor reads, so the commit it inspects is the commit Harbor runs.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tomllib
import urllib.request
from pathlib import Path

REGISTRY_URL = "https://raw.githubusercontent.com/laude-institute/harbor/main/registry.json"
DATASET_NAME = "terminal-bench"
DATASET_VERSION = "2.0"


def resolve_dataset(registry_url: str) -> tuple[str, str, list[str]]:
    """Return (git_url, git_commit_id, task_names) for the pinned dataset."""
    with urllib.request.urlopen(registry_url, timeout=60) as response:
        registry = json.load(response)
    for entry in registry:
        if entry.get("name") == DATASET_NAME and entry.get("version") == DATASET_VERSION:
            tasks = entry["tasks"]
            urls = {t["git_url"] for t in tasks}
            commits = {t["git_commit_id"] for t in tasks}
            if len(urls) != 1 or len(commits) != 1:
                raise SystemExit(
                    f"{DATASET_NAME}@{DATASET_VERSION} spans several repos or commits: "
                    f"{sorted(urls)} {sorted(commits)}"
                )
            return urls.pop(), commits.pop(), [t["path"] for t in tasks]
    raise SystemExit(f"{DATASET_NAME}@{DATASET_VERSION} is not in {registry_url}")


def ensure_clone(git_url: str, commit: str, cache_dir: Path) -> Path:
    repo = cache_dir / "terminal-bench-2"
    if not (repo / ".git").exists():
        repo.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "clone", "--quiet", git_url, str(repo)], check=True)
    have = subprocess.run(
        ["git", "-C", str(repo), "cat-file", "-e", f"{commit}^{{commit}}"],
        capture_output=True,
    )
    if have.returncode != 0:
        subprocess.run(["git", "-C", str(repo), "fetch", "--quiet", "origin", commit], check=True)
    return repo


def read_task_metadata(repo: Path, commit: str, name: str) -> dict:
    blob = subprocess.run(
        ["git", "-C", str(repo), "show", f"{commit}:{name}/task.toml"],
        capture_output=True,
        check=True,
    ).stdout
    config = tomllib.loads(blob.decode())
    metadata = config.get("metadata", {})
    return {
        "name": name,
        "agent_timeout_sec": float(config.get("agent", {}).get("timeout_sec") or 0.0),
        "expert_time_min": float(metadata.get("expert_time_estimate_min") or 0.0),
        "junior_time_min": float(metadata.get("junior_time_estimate_min") or 0.0),
        "difficulty": metadata.get("difficulty") or "unknown",
        "category": metadata.get("category") or "unknown",
    }


def rank_key(row: dict) -> tuple:
    return (-row["agent_timeout_sec"], -row["expert_time_min"], row["name"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--n", type=int, default=20, help="how many tasks to select")
    parser.add_argument("--out", type=Path, help="write the selected names here, one per line")
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=Path.home() / "onepass-corpus" / "harbor",
        help="where to keep the terminal-bench-2 clone (scratch, never committed)",
    )
    parser.add_argument("--registry-url", default=REGISTRY_URL)
    args = parser.parse_args()

    git_url, commit, names = resolve_dataset(args.registry_url)
    repo = ensure_clone(git_url, commit, args.cache_dir)
    rows = sorted((read_task_metadata(repo, commit, n) for n in names), key=rank_key)

    print(f"# {DATASET_NAME}@{DATASET_VERSION}  {git_url}  {commit}", file=sys.stderr)
    print(f"# {len(rows)} tasks; selecting the {args.n} longest by agent timeout", file=sys.stderr)
    header = f"{'#':>3}  {'task':<34}{'agent_s':>9}{'expert_min':>12}  difficulty"
    print(header, file=sys.stderr)
    for i, row in enumerate(rows[: args.n], 1):
        print(
            f"{i:>3}  {row['name']:<34}{row['agent_timeout_sec']:>9.0f}"
            f"{row['expert_time_min']:>12.0f}  {row['difficulty']}",
            file=sys.stderr,
        )
    total_hours = sum(r["agent_timeout_sec"] for r in rows[: args.n]) / 3600
    print(
        f"# worst-case agent wall clock, one arm x one trial: {total_hours:.1f} h",
        file=sys.stderr,
    )

    selected = "\n".join(r["name"] for r in rows[: args.n]) + "\n"
    if args.out:
        args.out.write_text(selected)
        print(f"# wrote {args.out}", file=sys.stderr)
    else:
        sys.stdout.write(selected)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
