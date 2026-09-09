#!/usr/bin/env python3
"""Turn two Harbor job directories — proxied and control — into one markdown table.

    python3 report.py --proxied <job-dir> --control <job-dir> [--out RESULT.md]

What it reads, and from where:

* ``<job>/<trial>/results.json`` — Harbor's own record: the task, the verifier's reward, and the
  agent's token totals. ``n_input_tokens`` is input *including* cache, which is exactly the
  number the proxy shrinks and the number Claude Code's auto-compact decision reads.
* ``<job>/<trial>/agent/trajectory.json`` — per-step metrics. ``max(step.metrics.prompt_tokens)``
  is the peak context of that session: the single number ``docs/findings.md`` reports, and the
  one that decides whether a session compacts.
* ``<job>/<trial>/agent/onepass/proxy.log.*.jsonl`` — proxied arm only: trips, segments evicted,
  chars removed.
* ``<job>/<trial>/agent/sessions/projects/*/*.jsonl`` — the Claude Code transcript, scanned for
  ``recall_search`` / ``recall_get`` calls.

The headline is the paired difference: proxied − control on the same task, averaged over trials
within a task first so a task with more completed trials does not count more than one with
fewer, then bootstrapped over tasks (``scipy.stats.bootstrap``, paired by construction because
each task contributes one difference).
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

RECALL_TOOLS = ("recall_search", "recall_get")


@dataclass
class TrialRecord:
    task: str
    trial: str
    reward: float | None
    errored: bool
    error: str | None
    input_tokens: int | None
    cache_tokens: int | None
    output_tokens: int | None
    cost_usd: float | None
    peak_context_tokens: int | None
    n_steps: int | None
    agent_name: str
    agent_version: str
    model: str | None
    # Proxied arm only.
    trips: int | None = None
    segments_evicted: int | None = None
    chars_removed: int | None = None
    pressure_trips: int | None = None
    recall_calls: int = 0


@dataclass
class Arm:
    label: str
    job_dir: Path
    # An arm may be spread over several Harbor jobs: the run is batched to stay inside a
    # rate-limit window, so each batch is its own job directory.
    job_dirs: list[Path] = field(default_factory=list)
    trials: list[TrialRecord] = field(default_factory=list)

    def by_task(self) -> dict[str, list[TrialRecord]]:
        grouped: dict[str, list[TrialRecord]] = {}
        for trial in self.trials:
            grouped.setdefault(trial.task, []).append(trial)
        return grouped


def _reward_of(results: dict[str, Any]) -> float | None:
    verifier = results.get("verifier_result") or {}
    rewards = verifier.get("rewards")
    if not rewards:
        return None
    if "reward" in rewards:
        return float(rewards["reward"])
    values = [float(v) for v in rewards.values()]
    return sum(values) / len(values) if values else None


def _peak_and_steps(trial_dir: Path) -> tuple[int | None, int | None]:
    path = trial_dir / "agent" / "trajectory.json"
    if not path.is_file():
        return None, None
    try:
        trajectory = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None, None
    steps = trajectory.get("steps") or []
    prompts = [
        (step.get("metrics") or {}).get("prompt_tokens")
        for step in steps
        if isinstance(step, dict)
    ]
    prompts = [p for p in prompts if isinstance(p, int)]
    return (max(prompts) if prompts else None), (len(steps) or None)


def _proxy_log_stats(trial_dir: Path) -> dict[str, int] | None:
    logs = sorted((trial_dir / "agent" / "onepass").glob("proxy.log.*.jsonl"))
    if not logs:
        return None
    trips = segments = chars = pressure = 0
    for log in logs:
        for line in log.read_text(errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("kind") != "trip":
                continue
            trips += 1
            segments += len(entry.get("addedToolUseIds") or [])
            chars += int(entry.get("charsRemoved") or 0)
            if entry.get("pressure"):
                pressure += 1
    return {
        "trips": trips,
        "segments": segments,
        "chars": chars,
        "pressure_trips": pressure,
    }


def _recall_calls(trial_dir: Path) -> int:
    """Count recall_search / recall_get tool calls in the Claude Code transcript.

    A raw substring scan over each transcript line: the tool names appear in a ``tool_use``
    block's ``name``, and nothing else in a session writes those exact strings unless the agent
    reached for recall.
    """
    sessions = (trial_dir / "agent" / "sessions").rglob("*.jsonl")
    count = 0
    for session in sessions:
        try:
            text = session.read_text(errors="replace")
        except OSError:
            continue
        for tool in RECALL_TOOLS:
            count += text.count(f'"name":"{tool}"') + text.count(f'"name": "{tool}"')
    return count


def _trial_results_paths(job_dir: Path) -> list[Path]:
    """Every per-trial result file under a job directory.

    Harbor 0.22.0 writes `<job>/<trial>/result.json` (singular). Earlier drafts of this script
    globbed `results.json`, which matches nothing on a real job — the fixture it was tested
    against used the plural name. Both are accepted so a rerun against either layout works.
    """
    paths = sorted(job_dir.glob("*/result.json")) + sorted(job_dir.glob("*/results.json"))
    return [p for p in paths if p.parent != job_dir]


def load_arm(label: str, job_dirs: Sequence[Path]) -> Arm:
    for job_dir in job_dirs:
        if not job_dir.is_dir():
            raise SystemExit(f"{label}: not a directory: {job_dir}")
    arm = Arm(label=label, job_dir=job_dirs[0], job_dirs=list(job_dirs))
    for results_path in [p for d in job_dirs for p in _trial_results_paths(d)]:
        trial_dir = results_path.parent
        try:
            results = json.loads(results_path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            print(f"warning: unreadable {results_path}: {exc}", file=sys.stderr)
            continue
        agent_info = results.get("agent_info") or {}
        model_info = agent_info.get("model_info") or {}
        agent_result = results.get("agent_result") or {}
        exception_info = results.get("exception_info")
        peak, n_steps = _peak_and_steps(trial_dir)
        record = TrialRecord(
            task=results.get("task_name") or trial_dir.name,
            trial=results.get("trial_name") or trial_dir.name,
            reward=_reward_of(results),
            errored=exception_info is not None,
            error=(exception_info or {}).get("exception_type"),
            input_tokens=agent_result.get("n_input_tokens"),
            cache_tokens=agent_result.get("n_cache_tokens"),
            output_tokens=agent_result.get("n_output_tokens"),
            cost_usd=agent_result.get("cost_usd"),
            peak_context_tokens=peak,
            n_steps=n_steps,
            agent_name=agent_info.get("name") or "unknown",
            agent_version=agent_info.get("version") or "unknown",
            model=model_info.get("name"),
            recall_calls=_recall_calls(trial_dir),
        )
        stats = _proxy_log_stats(trial_dir)
        if stats is not None:
            record.trips = stats["trips"]
            record.segments_evicted = stats["segments"]
            record.chars_removed = stats["chars"]
            record.pressure_trips = stats["pressure_trips"]
        arm.trials.append(record)
    if not arm.trials:
        joined = ", ".join(str(d) for d in job_dirs)
        raise SystemExit(f"{label}: no trials with a result.json under {joined}")
    return arm


def _mean(values: Iterable[float | None]) -> float | None:
    present = [v for v in values if v is not None]
    return sum(present) / len(present) if present else None


def paired_differences(
    proxied: Arm, control: Arm, metric: str
) -> tuple[list[str], list[float]]:
    """Per-task (proxied mean − control mean) over the tasks both arms scored."""
    p_by_task, c_by_task = proxied.by_task(), control.by_task()
    tasks, diffs = [], []
    for task in sorted(set(p_by_task) & set(c_by_task)):
        p = _mean(getattr(t, metric) for t in p_by_task[task])
        c = _mean(getattr(t, metric) for t in c_by_task[task])
        if p is None or c is None:
            continue
        tasks.append(task)
        diffs.append(float(p) - float(c))
    return tasks, diffs


def bootstrap_ci(diffs: list[float], confidence: float = 0.95) -> tuple[float, float, str]:
    """A percentile bootstrap CI on the mean paired difference.

    Each task contributes exactly one difference, so resampling tasks is already the paired
    bootstrap; there is nothing left to pair.
    """
    if len(diffs) < 2:
        return float("nan"), float("nan"), "n<2"
    try:
        import numpy as np
        from scipy.stats import bootstrap
    except ImportError:
        return float("nan"), float("nan"), "scipy not installed"
    result = bootstrap(
        (np.asarray(diffs, dtype=float),),
        statistic=np.mean,
        confidence_level=confidence,
        n_resamples=10_000,
        method="percentile",
        random_state=0,
    )
    return (
        float(result.confidence_interval.low),
        float(result.confidence_interval.high),
        "percentile bootstrap, 10,000 resamples",
    )


def _fmt(value: float | int | None, spec: str = ",.0f") -> str:
    if value is None:
        return "—"
    if isinstance(value, float) and value != value:  # NaN
        return "—"
    return format(value, spec)


def _pct(new: float | None, old: float | None) -> str:
    if not old or new is None:
        return "—"
    return f"{(new - old) / old * 100:+.1f}%"


def arm_summary(arm: Arm) -> dict[str, Any]:
    scored = [t for t in arm.trials if t.reward is not None]
    return {
        "trials": len(arm.trials),
        "errored": sum(1 for t in arm.trials if t.errored),
        "scored": len(scored),
        "mean_reward": _mean(t.reward for t in scored),
        "mean_input_tokens": _mean(t.input_tokens for t in arm.trials),
        "mean_peak_context": _mean(t.peak_context_tokens for t in arm.trials),
        "mean_output_tokens": _mean(t.output_tokens for t in arm.trials),
        "mean_steps": _mean(t.n_steps for t in arm.trials),
        "total_cost_usd": sum(t.cost_usd or 0.0 for t in arm.trials) or None,
        "trips": sum(t.trips or 0 for t in arm.trials) or None,
        "segments": sum(t.segments_evicted or 0 for t in arm.trials) or None,
        "chars_removed": sum(t.chars_removed or 0 for t in arm.trials) or None,
        "pressure_trips": sum(t.pressure_trips or 0 for t in arm.trials) or None,
        "recall_calls": sum(t.recall_calls for t in arm.trials),
        "agent": sorted({t.agent_name for t in arm.trials}),
        "cli_version": sorted({t.agent_version for t in arm.trials}),
        "model": sorted({t.model for t in arm.trials if t.model}),
    }


def render(proxied: Arm, control: Arm) -> str:
    p, c = arm_summary(proxied), arm_summary(control)
    out: list[str] = []
    w = out.append

    w("# Onepass on Terminal-Bench 2.0")
    w("")
    for arm in (proxied, control):
        dirs = arm.job_dirs or [arm.job_dir]
        if len(dirs) == 1:
            w(f"- {arm.label} job: `{dirs[0]}`")
        else:
            w(f"- {arm.label} jobs ({len(dirs)} batches):")
            for d in dirs:
                w(f"  - `{d}`")
    w(f"- agent: {', '.join(p['agent'])} (proxied) vs {', '.join(c['agent'])} (control)")
    w(f"- Claude Code: {', '.join(p['cli_version'])} (proxied), {', '.join(c['cli_version'])} (control)")
    w(f"- model: {', '.join(p['model'] or ['—'])}")
    w("")

    w("## Both arms")
    w("")
    w("| | proxied | control | change |")
    w("|---|---|---|---|")
    w(f"| Trials | {p['trials']} | {c['trials']} | |")
    w(f"| Trials that errored | {p['errored']} | {c['errored']} | |")
    w(
        f"| Mean reward | {_fmt(p['mean_reward'], '.3f')} | {_fmt(c['mean_reward'], '.3f')} "
        f"| {_pct(p['mean_reward'], c['mean_reward'])} |"
    )
    w(
        f"| Mean input tokens/trial (incl. cache) | {_fmt(p['mean_input_tokens'])} "
        f"| {_fmt(c['mean_input_tokens'])} | {_pct(p['mean_input_tokens'], c['mean_input_tokens'])} |"
    )
    w(
        f"| Mean peak context/trial | {_fmt(p['mean_peak_context'])} "
        f"| {_fmt(c['mean_peak_context'])} | {_pct(p['mean_peak_context'], c['mean_peak_context'])} |"
    )
    w(
        f"| Mean output tokens/trial | {_fmt(p['mean_output_tokens'])} "
        f"| {_fmt(c['mean_output_tokens'])} | {_pct(p['mean_output_tokens'], c['mean_output_tokens'])} |"
    )
    w(
        f"| Mean agent steps/trial | {_fmt(p['mean_steps'], ',.1f')} "
        f"| {_fmt(c['mean_steps'], ',.1f')} | {_pct(p['mean_steps'], c['mean_steps'])} |"
    )
    w(
        f"| Reported cost (USD, total) | {_fmt(p['total_cost_usd'], ',.2f')} "
        f"| {_fmt(c['total_cost_usd'], ',.2f')} | {_pct(p['total_cost_usd'], c['total_cost_usd'])} |"
    )
    w(f"| Proxy trips | {_fmt(p['trips'])} | — | |")
    w(f"| — of them pressure-pass trips | {_fmt(p['pressure_trips'])} | — | |")
    w(f"| Segments evicted | {_fmt(p['segments'])} | — | |")
    w(f"| Chars removed | {_fmt(p['chars_removed'])} | — | |")
    w(f"| `recall_search`/`recall_get` calls | {p['recall_calls']} | {c['recall_calls']} | |")
    w("")

    w("## Paired difference (proxied − control, per task)")
    w("")
    w("| metric | mean difference | 95% CI | tasks | method |")
    w("|---|---|---|---|---|")
    for label, metric, spec in (
        ("reward", "reward", "+.4f"),
        ("input tokens (incl. cache)", "input_tokens", "+,.0f"),
        ("peak context tokens", "peak_context_tokens", "+,.0f"),
        ("output tokens", "output_tokens", "+,.0f"),
    ):
        tasks, diffs = paired_differences(proxied, control, metric)
        if not diffs:
            w(f"| {label} | — | — | 0 | no task scored in both arms |")
            continue
        low, high, method = bootstrap_ci(diffs)
        mean = statistics.fmean(diffs)
        ci = "—" if low != low else f"[{format(low, spec)}, {format(high, spec)}]"
        w(f"| {label} | {format(mean, spec)} | {ci} | {len(diffs)} | {method} |")
    w("")

    w("## Per task")
    w("")
    w(
        "| task | reward (proxied) | reward (control) | Δ reward | input tok (proxied) "
        "| input tok (control) | Δ input | peak (proxied) | peak (control) | trips | segments |"
    )
    w("|---|---|---|---|---|---|---|---|---|---|---|")
    p_by, c_by = proxied.by_task(), control.by_task()
    for task in sorted(set(p_by) | set(c_by)):
        pt, ct = p_by.get(task, []), c_by.get(task, [])
        p_reward, c_reward = _mean(t.reward for t in pt), _mean(t.reward for t in ct)
        p_in, c_in = _mean(t.input_tokens for t in pt), _mean(t.input_tokens for t in ct)
        p_peak, c_peak = (
            _mean(t.peak_context_tokens for t in pt),
            _mean(t.peak_context_tokens for t in ct),
        )
        d_reward = (
            "—" if p_reward is None or c_reward is None else f"{p_reward - c_reward:+.3f}"
        )
        d_in = "—" if p_in is None or c_in is None else f"{p_in - c_in:+,.0f}"
        trips = sum(t.trips or 0 for t in pt)
        segments = sum(t.segments_evicted or 0 for t in pt)
        w(
            f"| {task} | {_fmt(p_reward, '.3f')} | {_fmt(c_reward, '.3f')} | {d_reward} "
            f"| {_fmt(p_in)} | {_fmt(c_in)} | {d_in} | {_fmt(p_peak)} | {_fmt(c_peak)} "
            f"| {trips} | {segments} |"
        )
    w("")

    errored = [
        (arm.label, t) for arm in (proxied, control) for t in arm.trials if t.errored
    ]
    if errored:
        w("## Errored trials")
        w("")
        w("| arm | task | trial | exception |")
        w("|---|---|---|---|")
        for label, t in errored:
            w(f"| {label} | {t.task} | {t.trial} | {t.error} |")
        w("")

    return "\n".join(out) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--proxied", type=Path, required=True, nargs="+",
        help="proxied arm job directory (repeatable: the run is batched across windows)")
    parser.add_argument(
        "--control", type=Path, required=True, nargs="+",
        help="control arm job directory (repeatable)")
    parser.add_argument("--out", type=Path, help="write markdown here instead of stdout")
    args = parser.parse_args()

    proxied = load_arm("proxied", args.proxied)
    control = load_arm("control", args.control)
    markdown = render(proxied, control)
    if args.out:
        args.out.write_text(markdown)
        print(f"wrote {args.out}", file=sys.stderr)
    else:
        sys.stdout.write(markdown)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
