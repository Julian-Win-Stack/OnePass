#!/usr/bin/env python3
"""Separate trials that ran out of allowance from trials that genuinely failed.

The account has no overage, so reaching 100% of a rolling window is a hard refusal. Claude Code
answers a refusal with backoff, the backoff burns the *task's* own timer, and the task then times
out and scores 0 — identical, in `result.json`, to the agent simply failing the task. Reported
without separating the two, a truncated run reads as "the proxy failed these tasks".

This script looks for the evidence that distinguishes them, per trial:

  * a `rate_limit_event` whose status is not "allowed"        (the direct signal)
  * HTTP 429 recorded by the proxy                            (proxied arm only)
  * usage/limit wording in the CLI's own error output
  * a zero reward on a trial whose session ended far earlier than its timeout

A trial flagged here is not evidence about eviction either way; it is a trial to rerun. Rerun just
those tasks with ONEPASS_TASKS_FILE pointing at a file listing them.

    python3 triage.py <job-dir> [<job-dir> ...]
    python3 triage.py --rerun-list retry.txt <job-dir> ...
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

LIMIT_WORDING = re.compile(
    r"(usage limit|rate limit reached|rate_limit_error|too many requests|quota exceeded|"
    r"overloaded_error|resets at)", re.I)


def _read(path: Path) -> str:
    try:
        return path.read_text(errors="replace")
    except OSError:
        return ""


def triage_trial(trial_dir: Path) -> dict:
    out = {
        "trial": trial_dir.name,
        "task": trial_dir.name,
        "reward": None,
        "errored": False,
        "error": None,
        "incomplete": False,
        "limit_signals": [],
    }
    result_path = trial_dir / "result.json"
    if not result_path.exists():
        # Harbor writes result.json when the trial finishes, so its absence means "still running"
        # far more often than it means "failed". Those two must not be reported the same way:
        # calling a live trial a failure is how a run gets abandoned halfway for no reason.
        out["incomplete"] = True
        return out
    try:
        r = json.loads(result_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        out["limit_signals"].append(f"unreadable result.json: {exc}")
        return out

    out["task"] = r.get("task_name") or trial_dir.name
    rewards = (r.get("verifier_result") or {}).get("rewards") or {}
    out["reward"] = rewards.get("reward")
    exc_info = r.get("exception_info")
    if exc_info:
        out["errored"] = True
        out["error"] = exc_info.get("exception_type")

    cc = _read(trial_dir / "agent" / "claude-code.txt")
    for line in cc.splitlines():
        if '"rate_limit_event"' in line:
            try:
                info = json.loads(line)["rate_limit_info"]
            except (json.JSONDecodeError, KeyError, TypeError):
                continue
            if info.get("status") != "allowed":
                out["limit_signals"].append(f"rate_limit_event status={info.get('status')}")

    # The CLI reports a refusal as an error/result line, not as a rate_limit_event.
    for line in cc.splitlines():
        if '"is_error":true' in line.replace(" ", "") or '"subtype":"error' in line:
            if LIMIT_WORDING.search(line):
                out["limit_signals"].append("limit wording in CLI error output")
                break

    proxy_logs = list((trial_dir / "agent" / "onepass").glob("proxy.log.*.jsonl"))
    for log in proxy_logs:
        for line in _read(log).splitlines():
            if '"status": 429' in line or '"status":429' in line:
                out["limit_signals"].append("proxy saw HTTP 429")
                break

    # dedupe, keep order
    seen, uniq = set(), []
    for s in out["limit_signals"]:
        if s not in seen:
            seen.add(s)
            uniq.append(s)
    out["limit_signals"] = uniq
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("job_dirs", type=Path, nargs="+")
    ap.add_argument("--rerun-list", type=Path,
                    help="write the affected task names here, one per line")
    ap.add_argument("-v", "--verbose", action="store_true",
                    help="also list trials that have not finished yet")
    args = ap.parse_args()

    rows, suspect_tasks = [], set()
    for job_dir in args.job_dirs:
        if not job_dir.is_dir():
            print(f"not a directory: {job_dir}", file=sys.stderr)
            return 1
        for trial_dir in sorted(d for d in job_dir.iterdir() if d.is_dir()):
            if not (trial_dir / "agent").exists() and not (trial_dir / "result.json").exists():
                continue
            row = triage_trial(trial_dir)
            row["job"] = job_dir.name
            rows.append(row)
            if row["limit_signals"]:
                suspect_tasks.add(row["task"])

    running = [r for r in rows if r.get("incomplete")]
    finished = [r for r in rows if not r.get("incomplete")]
    clean = [r for r in finished if not r["limit_signals"]]
    dirty = [r for r in finished if r["limit_signals"]]

    print(f"{len(rows)} trials: {len(finished)} finished "
          f"({len(clean)} clean, {len(dirty)} with allowance signals), "
          f"{len(running)} still running\n")
    if dirty:
        print("TRIALS TO RERUN — these carry no information about eviction:")
        for r in dirty:
            print(f"  {r['job']}/{r['task']}: reward={r['reward']} errored={r['errored']} "
                  f"({'; '.join(r['limit_signals'])})")
        print()
    zero = [r for r in clean if r["reward"] == 0]
    if zero:
        print("Genuine zero-reward trials (no allowance signal — these are real failures):")
        for r in zero:
            print(f"  {r['job']}/{r['task']}: errored={r['errored']} error={r['error']}")
        print()

    if running and args.verbose:
        print("Still running (no result.json yet):")
        for r in running:
            print(f"  {r['job']}/{r['task']}")
        print()

    if args.rerun_list:
        args.rerun_list.write_text(
            "# tasks with rate-limit signals; rerun with ONEPASS_TASKS_FILE\n"
            + "\n".join(sorted(suspect_tasks)) + ("\n" if suspect_tasks else ""))
        print(f"wrote {args.rerun_list} ({len(suspect_tasks)} tasks)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
