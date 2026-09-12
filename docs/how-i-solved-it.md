# Building it was easy. Knowing it worked was not.

The proxy is a few hundred lines of deterministic code. I had it evicting in an afternoon.
What took the rest of the time was answering one question honestly: does this actually work,
or does it just look like it works?

I needed that answer for two reasons. I had to iterate — change something, see whether it
helped, change it again — and eyeballing a session does not tell you that. And I intend to
put this in front of other people, so "it feels fine when I use it" is not good enough.

This is how I built the measurement, in the order I built it. The numbers behind every claim
are in [findings.md](findings.md).

## 1. One verdict took an hour

Once eviction worked, I knew it worked. What I did not have was a way to change something
and find out within minutes whether it had helped.

My first approach was to run the biggest coding task I had ever given an agent: a real
feature in a large open-source repository, about 500 model turns, 30 to 40 minutes a run.
I ran it with and without the proxy and scored both against a test suite the agent never
saw. It gave me a real verdict — the two scored the same, and the proxied run peaked at
well under half the context.

But each verdict cost 30 to 60 minutes and real money, and one run of a task tells you
little on its own. I could not iterate on that.

## 2. Record it once, replay it in seconds

The proxy's eviction decision is plain deterministic code. It needs no model to test. So I
did two things.

First, unit tests that push a sequence of requests through the eviction code, not just one
request at a time. Second, a recorder: every request body a proxied session sends is saved
to disk. A changed build can then replay the whole session against a fake API in seconds,
and report exactly what it would have evicted and when.

The replay caught the one expensive bug. Once the part of the context that cannot be
removed grew past the threshold, the proxy fired on almost every request to remove a few
hundred tokens each time, and every firing rewrote Anthropic's prompt cache at many times
the cached price. One recording showed 112 evictions in 120 requests. Live, the worst task
cost 7x the unproxied run. The fix was a batch minimum: only evict when at least 20k tokens
can go at once. The replay showed 112 evictions dropping to 5. One live run confirmed it:
the same task at 1.35x, with 94% of its input served from cache instead of 28%.

The replay also taught me something about fakes. My fake API answered with a fixed
characters-per-token ratio. The real one had reported a lower ratio, so every replayed
request looked 20% smaller than it had in life, and the replay showed 97 evictions where
the real run had made 112. The fake has to return the numbers the real API returned, not
plausible ones.

What I learned: test in three layers, cheapest first. Unit tests answer "does the code do
what I meant" in milliseconds. Replay answers "what does it do on real traffic" in seconds,
for free. Live runs answer "does it work in the world", and only they can, but they are
slow, expensive and noisy. So iterate on the first two, and book a live run only to confirm
what they already showed.

## 3. Does the agent get worse?

Smaller context is easy to show. The real question is whether removing it hurts the work.
An agent that never compacts but quietly does a worse job is not a win.

So I took 20 of the hardest tasks from Terminal-Bench 2.0, a public benchmark scored by
tests, and ran each once with the proxy and once without, in identical containers, with the
eviction threshold forced low so it would fire on tasks that normally stay small. The proxy
passed 14, the plain run passed 16, and the confidence interval on the difference includes
zero. Peak context was 30% lower with the proxy. Two of the three tasks only the proxy
failed died on a network error and a rate limit, not on the task.

That is not proof of no effect. It is one run per task, and the next sections are why one
run is not enough. But it is the shape of evidence I trust: an existing benchmark, a
test-based score, and a stranger can check it without reading my code.

## 4. An LLM judge is easy to build and hard to make right

Tests only see whether a feature is missing. They cannot see a clumsy or drifting
implementation. So for the code-quality question I tried the tool everyone reaches for: a
model reading two diffs and saying which is better, blind to which one used the proxy.

Building it took an afternoon. Trusting it took much longer, and I never fully got there.
To read anything out of it I had to add a positive control (a pair with a known answer), a
self-pair (the same diff against itself, which must come out equal), and a check that the
file and line numbers it cited were real. It cost $108 for 22 calls. And at the end it
could rank five runs of one task, but it could not tell me whether the proxy mattered,
because two runs with no proxy differed from each other by as much as the proxied runs
differed from them.

What I learned: LLM-as-a-judge is a second AI system you have to get right, on top of the
one you are building. It can be the right tool. But unit tests, replay, and a test-scored
benchmark answered my questions without it, so it should come last, when nothing cheaper
can answer the question.

## 5. Measure the noise before you read a difference

Two runs of the same task with no proxy scored the same on the tests, and the blind judge
still ranked one clearly above the other. One took 317 turns to get there and the other
381. That spread is the noise floor, and any proxied-versus-unproxied difference smaller
than it means nothing.

So I stopped comparing one run against one run. The implementation task got three runs
each way. The benchmark got 20 tasks. And the control side always ran more than once, so I
could see how much two identical setups disagree before I read the gap between different
ones. An early result where every proxied run failed one test and the single control passed
it looked like a regression. With two more controls it turned out to be luck.

## The order I would use next time

1. Unit tests on everything deterministic.
2. Record real traffic and replay it through every change.
3. A public, test-scored benchmark, with the control run more than once.
4. Live runs, only to confirm.
5. An LLM judge, only if nothing above can answer the question.
