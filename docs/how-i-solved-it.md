# Building it was easy. Knowing it worked was not.

The proxy is a few hundred lines of deterministic code. I had it evicting in an afternoon.
What took the rest of the time was answering one question honestly: does this actually work,
or does it just look like it works?

I needed that answer for two reasons. I had to iterate: change something, see whether it
helped, change it again. Eyeballing a session does not tell you that. And I intend to
put this in front of other people, so "it feels fine when I use it" is not good enough.

This is how I built the measurement, in the order I built it. The numbers behind every claim
are in [findings.md](findings.md).

## 1. One verdict took an hour

Once eviction worked, I knew it worked. What I did not have was a way to change something
and find out within minutes whether it had helped.

My first approach was to run the biggest coding task I had ever given an agent: a real
feature in a large open-source repository, about 500 model turns, 30 to 40 minutes a run.
I ran it with and without the proxy and scored both against a test suite the agent never
saw. It gave me a real verdict. The two scored the same, and the proxied run peaked at
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

The replay caught the one expensive bug. The proxy was evicting far too often, and every
eviction rewrote Anthropic's prompt cache, so the worst task cost 7x the unproxied run.
What mattered was how fast I could fix it: I could try a change and see it work on recorded
traffic in seconds, instead of booking a 40-minute live run each time. Evictions on the
recording dropped from 112 to 5, and 94% of the live re-run's input came from cache instead
of 28%. That worst-case task now costs 1.35x the unproxied run. Most sessions cost the same
as a normal session without the proxy.

What I learned: test in three layers, cheapest first. Unit tests answer "does the code do
what I meant" in milliseconds. Replay answers "what does it do on real traffic" in seconds,
for free. Live runs answer "does it work in the world", and only they can, but they are
slow, expensive and noisy. So iterate on the first two, and book a live run only to confirm
what they already showed.

## 3. Does the agent get worse?

Smaller context is easy to show. The harder question is whether the agent reasons worse
because of it.

So I ran 20 of the hardest tasks from Terminal-Bench 2.0, a public benchmark scored by
tests. Plain Claude Code passed 16. With the proxy it passed 14.

That gap is noise, imo. Two of the tasks the proxy failed did not fail on the work: one hit a
network error, one hit a rate limit. The proxy also passed a task the plain run failed.
And the confidence interval on the difference includes zero.


## 4. An LLM judge is easy to build and hard to make right

What I really wanted to know was whether the proxy makes Claude worse at the things tests
cannot see. In a brainstorming claude code session, is every reply as good as it would have been
without the proxy? Is the code the agent writes as good?

Answering that means building an LLM judge, and that is a product of its own. Building one
is easy. Making it judge correctly is hard. I could do it, but making it accurate would be
overkill for this product, so I stopped.

What I did instead was watch how the agent behaves. Does it go in a loop because it lost
something? Does it get stuck? It does not. It goes and reads the file off disk when it
needs it. And I scored the final output with tests.

The rest is reasoning. It is the same model, and all I removed were file reads and tool
calls that are still on disk. I do not think that makes it write worse code or give worse
answers.

There is also a limit to what a judge would tell me. Plain Claude Code, same context, same
harness, asked the same thing twice, gives a good answer once and a slightly worse one the
next time. A judge would have to be reliable enough to see through that, and making it that
reliable is a lot of effort for what this product needs.

So this area is not fully measured, and I would rather say so than pretend otherwise.

## 5. Measure the noise before you read a difference

Two runs of the same task, both without the proxy, scored the same on the tests. But one
took 317 turns to get there and the other 381, and when I asked Claude Code to compare the
two pieces of work without telling it which was which, it clearly preferred one. Two
identical setups disagree that much on their own, so any difference smaller than that means
nothing.

So I stopped comparing one run against one run. Every comparison now runs the no-proxy side
more than once, so I can see how much it disagrees with itself before I read anything into
the gap. That caught a false alarm early on: all three proxied runs failed one test and the
single no-proxy run passed it, which looked like the proxy breaking something. Two more
no-proxy runs failed it too. It was luck.

## The order I would use next time

1. Unit tests on everything deterministic.
2. Record real traffic and replay it through every change.
3. A public, test-scored benchmark, with the control run more than once.
4. Live runs, only to confirm.
5. An LLM judge, only if nothing above can answer the question.
