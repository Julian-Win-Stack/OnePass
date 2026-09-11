# Lessons learned

Things this project taught the hard way. One entry per lesson, dated, with the evidence that
taught it. Add to the top.

## 2026-09-11 — Test an AI system in three layers: unit tests, then replay, then live runs

**The lesson.** When iterating on a system that has a model in the loop, verify changes in
this order, and only move down when the layer above cannot answer the question:

1. **Unit tests** on the deterministic code. Milliseconds. No model, no cost.
2. **Replay** of recorded real traffic through the changed code, with the model faked.
   Seconds. Real inputs, no cost.
3. **Live runs** with the real agent and the real API. Minutes to hours, dollars, and
   noisy: two runs of the same task differ by 40% here. The last resort, but still
   necessary — it is the only layer that shows how the API and the agent actually react.

Live runs answer "does it work in the world". The two layers above answer "does the code do
what I meant", and they answer it in seconds. Iterate on the fast layers; confirm once on the
slow one.

**What taught it.** The proxy's eviction decision is plain deterministic code. It had a bug:
once the un-evictable part of the context passed the trip line, it evicted a few hundred tokens
on almost every request, and each of those evictions forced the API to rewrite the whole
conversation at 20× the cached price. Proxied runs cost 4× control.

Every verdict on the proxy until then had come from live runs: 30 minutes to overnight, tens
to hundreds of dollars each. The bug was found by a $200 Harbor pass. A unit test that pushes
200 requests through the eviction function with the floor over the line, and counts the trips,
would have found it in under a second. That test did not exist: all 45 eviction tests fed one
request each, and the bug only shows across a sequence.

**How to apply it here.** Before any live run, a change to eviction gets: a sequence unit test
in `proxy/src/`, then a replay of a saved Harbor recording through the old and new builds
(`eval` replay mode, no model calls). A live run is booked only to confirm what those two
already showed.
