// The proxy child, against the fake upstream. The build is real: these tests compile `proxy/`
// the way a run does, so a proxy that stopped building fails here rather than halfway through
// a paid run.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildProxyUnderTest, startProxyChild, withProxyChild, type ProxyBuild } from "./proxy.js";
import { EvalError } from "./errors.js";
import { startFakeUpstream, type FakeUpstream } from "./fakeUpstream.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

let build: ProxyBuild;
let upstream: FakeUpstream;

before(async () => {
  build = await buildProxyUnderTest(repoRoot);
  upstream = await startFakeUpstream();
});

after(async () => {
  await upstream.close();
});

test("the build is identified by the repository's short SHA and its own version", () => {
  assert.match(build.shortSha, /^[0-9a-f]{7,}$/);
  assert.match(build.version, /^\d+\.\d+\.\d+/);
  assert.equal(typeof build.dirty, "boolean");
});

test("a child listens on a port the operating system picked, not the proxy's default", async () => {
  await withProxyChild(build, { upstreamUrl: upstream.url }, async (child) => {
    assert.ok(child.port > 0);
    assert.notEqual(child.port, 3777);
    assert.equal(child.baseUrl, `http://127.0.0.1:${child.port}`);
    assert.match(child.logFilePath, /proxy\.log\..*\.jsonl$/);
  });
});

test("two children run at once on different ports", async () => {
  const first = await startProxyChild(build, { upstreamUrl: upstream.url });
  const second = await startProxyChild(build, { upstreamUrl: upstream.url });
  try {
    assert.notEqual(first.port, second.port);
  } finally {
    await first.stop();
    await second.stop();
  }
});

test("what a child is given, it forwards to the upstream it was pointed at", async () => {
  const before = upstream.requests.length;
  const answer = await withProxyChild(build, { upstreamUrl: upstream.url }, async (child) => {
    const response = await fetch(`${child.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fake", max_tokens: 16, messages: [{ role: "user", content: "hello" }] }),
    });
    return (await response.json()) as { content: { text: string }[] };
  });

  assert.equal(answer.content[0]?.text, "fake upstream");
  const forwarded = upstream.requests.slice(before);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0]?.url, "/v1/messages");
  assert.match(forwarded[0]?.body ?? "", /hello/);
});

test("the judge is held off even when a key is set in the environment around the run", async () => {
  await withProxyChild(
    build,
    { upstreamUrl: upstream.url, env: { ONEPASS_JUDGE_API_KEY: "sk-should-be-dropped" } },
    async (child) => {
      assert.equal(child.judge, "off");
    },
  );
});

test("a child is torn down after the run, however the run ended", async () => {
  const child = await startProxyChild(build, { upstreamUrl: upstream.url });
  const port = child.port;
  await child.stop();
  await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", body: "{}" }));

  let failedPort = 0;
  await assert.rejects(
    withProxyChild(build, { upstreamUrl: upstream.url }, async (started) => {
      failedPort = started.port;
      throw new Error("the arm failed");
    }),
    /the arm failed/,
  );
  await assert.rejects(fetch(`http://127.0.0.1:${failedPort}/v1/messages`, { method: "POST", body: "{}" }));
});

test("stopping twice is not an error", async () => {
  const child = await startProxyChild(build, { upstreamUrl: upstream.url });
  await child.stop();
  await child.stop();
});

test("a proxy that is not there is a refusal, not a crash", async () => {
  await assert.rejects(buildProxyUnderTest("/nonexistent-repository"), EvalError);
});
