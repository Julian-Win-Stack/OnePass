# Onepass on Terminal-Bench 2.0

> **Re-run, 2026-09-11.** The worst task here by cost, `make-mips-interpreter` ($44.93 proxied vs
> $6.46 control), re-run once on the proxy at `468c43f` with everything else held: **$8.72, reward
> 1.0**, 5 trips instead of 112, cache reads 94% of input instead of 28%. Table and caveats in
> [docs/findings.md §22a](../../docs/findings.md#22-live-re-runs-of-the-030-proxy-the-7x-cost-blow-up-is-gone-and-a-session-under-the-trip-line-costs-nothing).
> The 20-task table below is the *old* proxy (`1ddb4fa` / `462bb37`) and stands as recorded.

- proxied jobs (2 batches):
  - `/Users/phyonyanwinn/onepass-corpus/harbor/jobs/onepass-first-pass-proxied-20260909T220608Z`
  - `/Users/phyonyanwinn/onepass-corpus/harbor/jobs/onepass-first-pass-proxied-remaining-proxied-20260910T055000Z`
- control jobs (2 batches):
  - `/Users/phyonyanwinn/onepass-corpus/harbor/jobs/onepass-first-pass-control-20260910T005916Z`
  - `/Users/phyonyanwinn/onepass-corpus/harbor/jobs/onepass-first-pass-control-remaining-control-20260910T031053Z`
- proxied: 1 trial(s) excluded as superseded — they ended before the verifier ran (an infrastructure failure, not a task outcome) and the task was re-run successfully
- control: 3 trial(s) excluded as operator cancellations — the run was stopped and resumed, and each of those tasks was re-run below
- agent: onepass-claude-code (proxied) vs claude-code, onepass-claude-code-control (control)
- Claude Code: 2.1.267 (proxied), 2.1.267 (control)
- model: claude-opus-5

## Both arms

| | proxied | control | change |
|---|---|---|---|
| Trials | 20 | 20 | |
| Trials that errored | 5 | 3 | |
| Mean reward | 0.700 | 0.800 | -12.5% |
| Mean input tokens/trial (incl. cache) | 1,651,778 | 2,036,770 | -18.9% |
| Mean peak context/trial | 48,774 | 69,334 | -29.7% |
| Mean output tokens/trial | 32,239 | 34,614 | -6.9% |
| Mean agent steps/trial | 39.1 | 34.6 | +13.2% |
| Reported cost (USD, total) | 201.91 | 47.91 | +321.4% |
| Proxy trips | 507 | — | |
| — of them pressure-pass trips | 497 | — | |
| Segments evicted | 1,059 | — | |
| Chars removed | 7,133,550 | — | |
| `recall_search`/`recall_get` calls | 0 | 0 | |

## Paired difference (proxied − control, per task)

| metric | mean difference | 95% CI | tasks | method |
|---|---|---|---|---|
| reward | -0.1000 | [-0.3000, +0.1000] | 20 | percentile bootstrap, 10,000 resamples |
| input tokens (incl. cache) | -384,991 | [-802,878, -35,189] | 20 | percentile bootstrap, 10,000 resamples |
| peak context tokens | -20,561 | [-28,716, -12,808] | 20 | percentile bootstrap, 10,000 resamples |
| output tokens | -2,375 | [-7,556, +1,430] | 20 | percentile bootstrap, 10,000 resamples |

## Per task

| task | reward (proxied) | reward (control) | Δ reward | input tok (proxied) | input tok (control) | Δ input | peak (proxied) | peak (control) | trips | segments |
|---|---|---|---|---|---|---|---|---|---|---|
| bn-fit-modify | 1.000 | 1.000 | +0.000 | 232,913 | 237,084 | -4,171 | 23,406 | 24,614 | 0 | 0 |
| build-pov-ray | 1.000 | 1.000 | +0.000 | 2,580,330 | 3,145,383 | -565,053 | 43,446 | 81,196 | 55 | 156 |
| circuit-fibsqrt | 1.000 | 1.000 | +0.000 | 618,534 | 223,994 | +394,540 | 38,862 | 38,991 | 13 | 19 |
| compile-compcert | 0.000 | 1.000 | -1.000 | 482,203 | 1,469,985 | -987,782 | 30,030 | 48,783 | 0 | 0 |
| distribution-search | 1.000 | 1.000 | +0.000 | 100,683 | 78,539 | +22,144 | 22,233 | 21,172 | 0 | 0 |
| feal-differential-cryptanalysis | 1.000 | 1.000 | +0.000 | 286,649 | 155,307 | +131,342 | 30,539 | 26,385 | 3 | 9 |
| feal-linear-cryptanalysis | 1.000 | 1.000 | +0.000 | 144,898 | 173,731 | -28,833 | 30,667 | 29,643 | 1 | 2 |
| fix-ocaml-gc | 1.000 | 1.000 | +0.000 | 688,521 | 1,328,644 | -640,123 | 64,069 | 81,316 | 5 | 15 |
| install-windows-3.11 | 0.000 | 0.000 | +0.000 | 1,103,732 | 1,516,013 | -412,281 | 30,200 | 51,199 | 5 | 66 |
| make-mips-interpreter | 1.000 | 1.000 | +0.000 | 5,848,328 | 7,215,551 | -1,367,223 | 65,828 | 126,095 | 112 | 197 |
| mteb-leaderboard | 1.000 | 1.000 | +0.000 | 820,428 | 724,018 | +96,410 | 30,203 | 38,156 | 4 | 38 |
| path-tracing | 1.000 | 1.000 | +0.000 | 680,703 | 803,485 | -122,782 | 55,692 | 86,152 | 13 | 30 |
| portfolio-optimization | 1.000 | 1.000 | +0.000 | 309,332 | 262,143 | +47,189 | 30,009 | 32,646 | 2 | 11 |
| regex-chess | 1.000 | 1.000 | +0.000 | 1,512,490 | 1,580,419 | -67,929 | 64,004 | 85,529 | 21 | 35 |
| reshard-c4-data | 0.000 | 1.000 | -1.000 | 741,176 | 3,599,072 | -2,857,896 | 43,836 | 86,295 | 15 | 35 |
| sam-cell-seg | 0.000 | 0.000 | +0.000 | 5,337,669 | 4,705,867 | +631,802 | 66,271 | 108,556 | 106 | 193 |
| schemelike-metacircular-eval | 1.000 | 1.000 | +0.000 | 2,068,192 | 1,886,225 | +181,967 | 76,277 | 106,031 | 35 | 58 |
| train-fasttext | 0.000 | 0.000 | +0.000 | 435,790 | 632,023 | -196,233 | 26,965 | 37,210 | 0 | 0 |
| video-processing | 1.000 | 0.000 | +1.000 | 2,317,563 | 1,826,752 | +490,811 | 52,223 | 79,807 | 54 | 83 |
| winning-avg-corewars | 0.000 | 1.000 | -1.000 | 6,725,433 | 9,171,157 | -2,445,724 | 150,711 | 196,910 | 63 | 112 |

## Errored trials

| arm | task | trial | exception |
|---|---|---|---|
| proxied | compile-compcert | compile-compcert__Ad3dQBX | NetworkConnectionError |
| proxied | reshard-c4-data | reshard-c4-data__NwBHByw | ApiRateLimitError |
| proxied | schemelike-metacircular-eval | schemelike-metacircular-eval__DK5KqDb | AgentTimeoutError |
| proxied | train-fasttext | train-fasttext__V9wBbnD | AgentTimeoutError |
| proxied | winning-avg-corewars | winning-avg-corewars__h9TRkub | AgentTimeoutError |
| control | schemelike-metacircular-eval | schemelike-metacircular-eval__kmt5GKX | AgentTimeoutError |
| control | train-fasttext | train-fasttext__zqAVAti | AgentTimeoutError |
| control | winning-avg-corewars | winning-avg-corewars__krgTgCP | AgentTimeoutError |

