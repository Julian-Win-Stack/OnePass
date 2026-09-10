#!/usr/bin/env python3
"""Read the subscription's rate-limit state back out of finished Harbor jobs.

Claude Code emits a `rate_limit_event` line into its own stdout log (`agent/claude-code.txt`)
carrying the current utilization of the five-hour and seven-day windows. That is the only
readout available here — there is no endpoint to poll — so the numbers are as of the last
request a trial made, not as of now.

This matters because the account has no overage (`overageStatus: "rejected"`). When a window
reaches 1.0 requests are refused outright, the agent burns its own task timer retrying, the task
scores 0, and the results table then reads "the proxy failed this task" when it means "we ran out
of allowance". Those two are indistinguishable after the fact, so the run is batched and this
script is the gate between batches.

    python3 usage.py                     # newest reading across every job
    python3 usage.py --job <dir>         # readings from one job only
    python3 usage.py --all               # every reading, oldest first
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_JOBS = Path.home() / "onepass-corpus" / "harbor" / "jobs"


def _events(job_dirs: list[Path]):
    for job_dir in job_dirs:
        for log in sorted(job_dir.glob("*/agent/claude-code.txt")):
            trial = log.parent.parent.name
            try:
                text = log.read_text(errors="replace")
            except OSError:
                continue
            for line in text.splitlines():
                if '"rate_limit_event"' not in line:
                    continue
                try:
                    info = json.loads(line)["rate_limit_info"]
                except (json.JSONDecodeError, KeyError, TypeError):
                    continue
                windows = info.get("unifiedWindows") or {}
                yield {
                    "job": job_dir.name,
                    "trial": trial,
                    "status": info.get("status"),
                    "overage": info.get("overageStatus"),
                    "five_hour": (windows.get("five_hour") or {}).get("utilization"),
                    "seven_day": (windows.get("seven_day") or {}).get("utilization"),
                    "resets_at": info.get("resetsAt"),
                }


def _fmt_ts(epoch: int | None) -> str:
    if not epoch:
        return "unknown"
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--jobs-dir", type=Path, default=DEFAULT_JOBS)
    ap.add_argument("--job", type=Path, action="append", default=[])
    ap.add_argument("--all", action="store_true", help="print every reading, not just the newest")
    args = ap.parse_args()

    # A bare job name is the natural thing to pass, since that is what run.sh prints, so resolve
    # anything that is not already a directory against --jobs-dir before giving up on it.
    resolved = []
    for job in args.job:
        resolved.append(job if job.is_dir() else args.jobs_dir / job)
    job_dirs = resolved or sorted(d for d in args.jobs_dir.iterdir() if d.is_dir())
    missing = [d for d in job_dirs if not d.is_dir()]
    if missing:
        print("no such job directory: " + ", ".join(str(d) for d in missing), file=sys.stderr)
        return 2
    readings = list(_events(job_dirs))
    if not readings:
        print("no rate_limit_event lines found — no trial has run yet, or the logs were not "
              "collected", file=sys.stderr)
        return 1

    # The events carry no timestamp of their own; file order within a trial is chronological, and
    # utilization is monotonic within a window, so the highest five_hour reading sharing the
    # newest reset time is the latest state of the current window.
    newest_reset = max(r["resets_at"] or 0 for r in readings)
    current = [r for r in readings if (r["resets_at"] or 0) == newest_reset]
    latest = max(current, key=lambda r: r["five_hour"] or 0)

    if args.all:
        for r in readings:
            print(f"{r['job']}/{r['trial']}: 5h={r['five_hour']} 7d={r['seven_day']} "
                  f"status={r['status']} resets={_fmt_ts(r['resets_at'])}")
        print()

    five = latest["five_hour"] or 0.0
    seven = latest["seven_day"] or 0.0
    print(f"five-hour window : {five:6.1%} used   resets {_fmt_ts(latest['resets_at'])}")
    print(f"seven-day window : {seven:6.1%} used")
    print(f"status           : {latest['status']}   overage: {latest['overage']}")
    print(f"as of            : {latest['job']}/{latest['trial']}")
    if latest["status"] != "allowed":
        print("\nWARNING: the last reading was not 'allowed'. Do not start a batch.")
        return 2
    print(f"\nheadroom this window: {1 - five:.1%}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
