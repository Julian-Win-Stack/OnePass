# Fix #18877 — share channel dedupe state across instances

You are picking this up cold. Everything you need is here; read it top to bottom before
touching code. The design decisions below were already made and reviewed — implement
them, don't re-litigate them.

---

## 1. What's broken

A Mastra agent connected to Slack keeps a note for each incoming message saying
"I already replied to this one," so that Slack's at-least-once delivery (duplicate
events, retries) doesn't produce duplicate replies.

That note lives in a plain JavaScript `Map`, inside one Node process:

```ts
// packages/core/src/channels/state-adapter.ts:26
private readonly cache = new Map<string, CachedValue>();
```

Deploy two instances behind a load balancer. Slack delivers message `M1` to both.
Instance A checks its own Map — empty — claims it, replies. Instance B checks *its* own
Map — also empty, because it's a different process — claims it, replies too.

**The user gets two replies to every message.**

This is not a race condition. There is no timing window where it works; the two
processes share no state whatsoever, so it fails every time.

The same `Map` also backs **modal context** — the note Slack modals use to remember
which message/thread they were opened from. So a modal opened on instance A cannot be
submitted through instance B. Fixing the cache fixes both.

**Out of scope:** locks, lists, and queues (`state-adapter.ts:27-29`) sit in the same
class and have the same per-process problem, but the issue is scoped to the cache — see
its title — and nothing calls `acquireLock` today because channels hardcode
`concurrency: { strategy: 'concurrent' }` (`packages/core/src/channels/agent-channels.ts:422`).
Leave them exactly as they are. Widening scope here turns a reviewable bug fix into a
refactor.

Issue: https://github.com/mastra-ai/mastra/issues/18877

---

## 2. Where you're starting from

- Branch: `fix/channels-shared-state-cache` (already checked out, based on `main`)
- One modified file: `packages/core/src/channels/__tests__/state-adapter.test.ts`
  — two regression tests were added at line 368 under
  `describe('shared state across instances')`. **They currently fail. That's intended.**
  They are your target.

  Their `beforeEach` currently builds two adapters with no channels store. Once Step 3
  lands, that wiring keeps both on private `Map`s and they'd still fail — so **change the
  `beforeEach` to construct one shared `InMemoryChannelsStorage` and pass it to both
  adapters. Leave every assertion alone.** Two adapters over one store is the production
  topology (two Node processes, two adapters, one Postgres) modelled in-process.
- Nothing staged, nothing committed.

**Do not run `git commit` or `git push`.** The user commits manually and must ask
explicitly each time. Finish the code and stop at "ready to commit."

---

## 3. Orientation: how Mastra storage works

Skip if you already know this.

Mastra storage is split into **domains** — `memory`, `channels`, `threadState`,
`favorites`, etc. Each domain is an abstract class in
`packages/core/src/storage/domains/<name>/base.ts`, with:

- an in-memory implementation next to it (`inmemory.ts`), used as the default and in tests
- one implementation per database, in `stores/<db>/src/storage/domains/<name>/index.ts`

A user gets a domain at runtime via `storage.getStore('channels')`.

Table names and column schemas are declared centrally in
`packages/core/src/storage/constants.ts`, not in the individual stores. There are **no
SQL migrations** — each store's `init()` creates its tables from the shared schema.

The channels domain (`packages/core/src/storage/domains/channels/base.ts`) currently has
nine methods, all about installations and platform config. It has no key/value surface at
all. You are adding one.

Five stores implement channels: **pg, libsql, mysql, spanner, convex**.

---

## 4. Decisions already made

Implement these as written.

### 4.1 A storage table, not the server cache

Mastra has a second shared place — `MastraServerCache`
(`packages/core/src/cache/base.ts`) — which already has TTL support and is missing only
a `setIfNotExists` method. Adding it there would be ~5 files instead of ~20, and is
semantically the better fit for TTL'd ephemeral data.

**It was rejected**, because:

```ts
// packages/core/src/mastra/index.ts:1290
this.#serverCache = config?.cache ?? new InMemoryServerCache();
```

The cache is optional and falls back to per-process memory — the same bug in a different
file. A user who never wrote `cache:` in their config would get no fix at all. The issue
reporter runs Postgres with no Redis. Channels, by contrast, already hard-require
storage, so a storage table fixes a default install on upgrade with no config change.

If a maintainer pushes back and asks for the cache route, stop and check with the user
before rewriting — most of the work (tests, adapter rewiring) is portable, but the five
store implementations are not.

### 4.2 State is scoped per agent

Today each agent gets its own `MastraStateAdapter` with its own `Map`, so dedupe is
implicitly **per-agent**. If `support-bot` and `sales-bot` both run in one Slack
workspace, both reply to a message — deliberately, they're different bots.

Moving to one shared table keyed only on the message id would mean the first agent to
claim it silences the other. **That would be a new bug you introduced.**

So `ownerId` is part of the primary key. The adapter already has the hook for this:
`getOwnerId` (`state-adapter.ts:21`), supplied at `agent-channels.ts:408` as
`() => this.getOwnerId()`, which resolves to the agent's id. It's already used to scope
threads (`ownerStamp`, `state-adapter.ts:246`); you're extending the same idea to cache
keys.

### 4.3 Expired rows get swept on a timer

A dedupe row is dead after ~10 minutes and **nothing ever reads it again**, so
delete-on-read alone would let the table grow forever — one dead row per Slack message.

So: delete expired rows on read (cheap, correct) **plus** a `deleteExpiredState()` the
channels layer calls on an interval.

Note the pg precedent at
`stores/pg/src/storage/domains/observability/v-next/discovery.ts:265` is a TTL'd
`cacheKey`→`jsonb` table with an atomic claim and *no* sweep — but it doesn't apply
here, because its key set is small and fixed, so rows are overwritten rather than
accumulated. Yours is unbounded.

### 4.4 There is no "unsupported store" case

Don't build a fallback or a warning path. Every code path already terminates at some
`ChannelsStorage`:

- Slack **throws** if there's no channels store — `channels/slack/src/provider.ts:418`
- Telegram falls back to `new InMemoryChannelsStorage()` —
  `channels/telegram/src/telegram-provider.ts:519`

Since you're adding the methods to the base class and to `InMemoryChannelsStorage`, both
paths are covered automatically.

Don't confuse this with the Convex missing-table case in Step 6. That's a store that
*does* implement channels but whose table the user hasn't deployed yet — a real error
worth throwing on. This section is about stores with no channels domain at all, a
population that doesn't exist. Neither one gets a silent `Map` fallback.

---

## 5. Implementation

Build in this order. Steps 1–2 survive a design change, so they go first; the store
implementations are the expensive, least-reversible part.

### Step 1 — Schema and constants

`packages/core/src/storage/constants.ts`:

```ts
export const TABLE_CHANNEL_STATE = 'mastra_channel_state';

export const CHANNEL_STATE_SCHEMA: Record<string, StorageColumn> = {
  ownerId:   { type: 'text',      nullable: false },
  key:       { type: 'text',      nullable: false },
  value:     { type: 'jsonb',     nullable: false },
  expiresAt: { type: 'bigint',    nullable: true  },
  createdAt: { type: 'timestamp', nullable: false },
  updatedAt: { type: 'timestamp', nullable: false },
};
```

Then register it in three places:
1. the `TABLE_NAMES` union (next to `TABLE_CHANNEL_INSTALLATIONS` / `TABLE_CHANNEL_CONFIG`)
2. `TABLE_SCHEMAS`
3. `TABLE_CONFIGS`, with the composite key:
   ```ts
   [TABLE_CHANNEL_STATE]: { columns: CHANNEL_STATE_SCHEMA, compositePrimaryKey: ['ownerId', 'key'] },
   ```
   Mirror `TABLE_THREAD_STATE` at `constants.ts:911`.

Legal column types are in `packages/core/src/storage/types.ts:15-30`.

**Two choices that look wrong and need a one-line code comment explaining why:**

- `expiresAt` is epoch-ms `bigint`, not `timestamp`. pg auto-generates an
  `<name>Z TIMESTAMPTZ` companion column for every `timestamp` column, which would mean
  binding and reading two columns on every call for a value only ever used in a `<=`
  comparison.
- `value` is `nullable: false` and always JSON-encoded, so a cached `null` is stored as
  JSON `null`, never SQL `NULL`. **Row presence means hit; the value's nullness must
  never be the signal.** Otherwise caching `null`/`false`/`0` reads back as a miss.

**Expected fallout:** `TABLE_SCHEMAS` is typed `Record<TABLE_NAMES, …>` — a *total*
record. Adding a name forces one-line edits in stores that don't implement channels at
all (clickhouse, cloudflare, `operations/inmemory`). Just satisfy the type checker; no
functional change. Mention this in the PR description, or a reviewer will open a channels
bug fix, see ClickHouse modified, and assume the worst.

### Step 2 — Domain interface + in-memory implementation

`packages/core/src/storage/domains/channels/base.ts`, add five abstract methods:

```ts
abstract getState(ownerId: string, key: string): Promise<{ value: unknown } | null>;
abstract setState(ownerId: string, key: string, value: unknown, expiresAt: number | null): Promise<void>;
abstract setStateIfNotExists(ownerId: string, key: string, value: unknown, expiresAt: number | null): Promise<boolean>;
abstract deleteState(ownerId: string, key: string): Promise<void>;
abstract deleteExpiredState(now: number): Promise<void>;
```

`getState` returns `{ value } | null` rather than `unknown | null` on purpose — that
wrapper is what makes a stored `null` distinguishable from a miss.

`expiresAt` is an absolute epoch-ms deadline (or `null` for never), computed by the
caller. Don't pass a TTL duration down — the store shouldn't be reading the clock.

Then implement in `packages/core/src/storage/domains/channels/inmemory.ts`, following
the existing `#installations` / `#configs` `Map` style in that file. A `Map` is
single-threaded, so `setStateIfNotExists` is trivially atomic there.

### Step 3 — Rewire the adapter

`packages/core/src/channels/state-adapter.ts`. Add the channels store as an **optional
third constructor parameter**:

```ts
constructor(memoryStore: MemoryStorage, getOwnerId?: () => string | null, channelsStore?: ChannelsStorage)
```

It must be optional and positional-compatible: this class is published via the
`./channels` subpath export (`packages/core/package.json:164`), so its constructor
signature is public API. An added optional param is non-breaking; changing the existing
ones is not.

Route the four cache methods — `get` (:96), `set` (:106), `setIfNotExists` (:113),
`delete` (:129) — to `channelsStore` when it's present. When it's absent, keep the
existing `Map` behaviour untouched, for anyone constructing the adapter directly.

Owner id comes from `this.getOwnerId?.() ?? null`. Since `ownerId` is `NOT NULL`, a null
owner needs a sentinel — use a named exported constant with a comment, not a bare string
literal buried in the method.

Convert TTL to a deadline at this layer: `ttlMs ? Date.now() + ttlMs : null`.

Leave locks, lists, and queues alone.

Also update the class doc comment at `state-adapter.ts:10-18` — it currently claims
cache and dedupe keys "don't need persistence," which is precisely the assumption being
fixed.

### Step 4 — Wire it up and add the sweep

`packages/core/src/channels/agent-channels.ts:396-410` is the only production
construction site. Fetch the channels store alongside the memory store and pass it in.
While you're there, fix the comment at `:396` — it mentions an "in-memory fallback" that
doesn't exist (the code throws).

Add the sweep: call `deleteExpiredState(Date.now())` on an interval (5 minutes is fine).

- `.unref()` the interval so it never holds the event loop open
- clear it on shutdown/disconnect so tests don't leak handles
- wrap the call so a sweep failure logs and never crashes the channel

### Step 5 — Postgres

`stores/pg/src/storage/domains/channels/index.ts`. Read the whole file first; it's short
and it's the template for the other four.

- add `TABLE_CHANNEL_STATE` to `MANAGED_TABLES` (`:20`) — `getExportDDL` iterates that
  array, so DDL export follows automatically
- add a `createTable` call in `init()` (`:31`)
- add a `clearTable` line in `dangerouslyClearAll()` (`:110`) — **this method is manual,
  one line per table**, it will silently miss your table otherwise
- add an index on `expiresAt` via `getDefaultIndexDefs` (`:44`) so the sweep isn't a scan

For the atomic claim, copy `stores/pg/src/storage/domains/favorites/index.ts:113-127`:
`INSERT … ON CONFLICT (…) DO NOTHING RETURNING "…"` with `oneOrNone`. A returned row
means this caller won the claim; `null` means someone else already had it.

**Critical:** the claim must be a single atomic statement. A `SELECT` followed by an
`INSERT` narrows the race window but does not close it, and it will pass every
sequential test while still producing duplicate replies in production.

One wrinkle: an *expired* row should be claimable. `DO NOTHING` won't overwrite it. Use
`ON CONFLICT DO UPDATE … WHERE <existing row is expired>` and treat "no row returned" as
"a live row already exists."

### Step 6 — Remaining four stores

Same shape, dialect-specific claim:

| Store | Claim mechanism | Template to copy |
| --- | --- | --- |
| libsql | `INSERT OR IGNORE`, check `rowsAffected` | `stores/libsql/src/storage/domains/favorites/index.ts:95` |
| mysql | `INSERT IGNORE`, check `affectedRows` | `stores/mysql/src/storage/domains/favorites/index.ts:156` |
| spanner | read-modify-write inside a transaction | no native equivalent |
| convex | transactional mutation | `stores/convex/src/server/cache.ts:32-43` for encode/expiry |

**MySQL gotcha:** `INSERT IGNORE` downgrades *every* error to a warning — truncation,
bad NULLs, type mismatches — not just duplicate-key. Checking `affectedRows`, as the
favorites driver does, is what makes it safe. Don't skip that check.

**Convex needs a user migration. This is normal — follow the house pattern.**

Convex schemas live in the *user's* repo, so Mastra cannot create the table; it exports a
definition the user lists in their own `convex/schema.ts`. There is no bundle export —
the quick-start enumerates all 16 tables by hand — so every table Mastra has ever added
required this. The maintainers did exactly this for `mastraObservationalMemoryTable`
(PR #19474) and for the vector tables.

So, decided:

- add the table next to `mastraChannelConfigTable` (`stores/convex/src/schema.ts:220`);
  `stores/convex/src/server/cache.ts` plus `mastraCacheTable` (`schema.ts:429`) is a
  close template — it is already TTL'd key-value with expiry
- add it to the quick-start list in `stores/convex/README.md:21` **and** add an upgrade
  note next to the observational-memory one at `README.md:206`
- **`@mastra/convex` takes a `minor` bump, not a patch** — see Step 8. A new Convex table
  is exactly what #19474 shipped as a minor (1.4.0). A user-visible schema step inside a
  patch is the thing a reviewer will object to; the right bump removes the objection

**Missing-table behaviour: fail loudly.** If a user upgrades without adding the table,
detect it and throw on startup, naming the table and pointing at the README. Do not fall
back to a `Map` with a warning — a lost warning line looks identical to "the fix didn't
work," and they'd rediscover it through duplicate Slack replies weeks later. This matches
how channels already treat missing storage (`channels/slack/src/provider.ts:418` throws).

The one part not yet traced is the mutation-registration surface in
`stores/convex/src/server/`. If that turns out to be much larger than `cache.ts` suggests,
stop and report before pushing through it.

### Step 7 — Tests

Two layers.

**Conformance** — `stores/_test-utils/src/domains/channels/index.ts`. This suite is
consumed by every store's `index.test.ts` through `createTestSuite`, so writing a test
once holds all five stores to it. It self-skips via
`storage.stores?.channels ? describe : describe.skip`.

Cases to add:
- a second caller's `setStateIfNotExists` on a live key returns `false`
- an expired key is claimable again
- caller B reads a value caller A wrote
- **concurrent claim** — `Promise.all` of N simultaneous `setStateIfNotExists` on one key
  yields exactly one `true`. *This is the important one.* A check-then-write
  implementation passes all the sequential tests and fails only this
- `null` round-trips as a hit, not a miss
- two different `ownerId`s claim the same key and both succeed
- `deleteExpiredState` removes expired rows and leaves live ones

**Regression** — the two tests already in
`packages/core/src/channels/__tests__/state-adapter.test.ts:368` must now pass. Their
assertions define the fix and must not change; only the `beforeEach` wiring changes, as
described in §2.

**Know what each layer proves.** The core regression tests prove *delegation* — that the
adapter reads and writes through the channels store instead of its private `Map`. They
say nothing about *atomicity*, because a `Map` is single-threaded and trivially atomic.
Atomicity is proven only by the concurrent-claim conformance test against a real
database. Green core tests are not evidence the bug is fixed.

After writing or changing any test, **invoke the `/test-guard` skill** and fix what it
flags. This is required, not optional.

### Step 8 — Docs and changeset

Docs:
- `docs/src/content/en/reference/agents/channels.mdx:77` — the `state` option
- `packages/core/src/channels/types.ts:559` — doc comment says "Defaults to in-memory",
  now wrong
- `stores/convex/README.md` — quick-start list (`:21`) and an upgrade note (`:206`)

Changeset, per `.mastracode/commands/changeset.md` — separate files per logical group,
never one file listing every package:

```bash
pnpm changeset -s -m "<message>" --patch @mastra/core
pnpm changeset -s -m "<message>" --patch @mastra/pg --patch @mastra/libsql --patch @mastra/mysql --patch @mastra/spanner
pnpm changeset -s -m "<message>" --minor @mastra/convex
```

Three files, because they say three different things:

- **`@mastra/core`** carries the behaviour change and the reason. This is the one users read.
- **the four SQL stores** just gain a table, created automatically on `init()`. Nothing for
  users to do — say that.
- **`@mastra/convex` is `minor` and needs its own file**, because it's the only one asking
  users to act. Copy the structure of the observational-memory entry at
  `stores/convex/CHANGELOG.md:208`: one sentence on what's fixed, then "add the new
  `...Table` to your Convex schema and redeploy", a `ts title="convex/schema.ts"` code
  block, then the `npx convex deploy` line.

Write for developers — what changes for them, not how it's implemented.

---

## 6. Verification

```bash
pnpm --filter ./packages/core test src/channels   # the two #18877 tests must go green
pnpm --filter ./packages/core check               # typecheck
pnpm --filter ./stores/pg test                    # conformance; needs a local postgres
pnpm lint                                         # must be clean
```

Build only what you need — `pnpm build:core`, or
`pnpm turbo build --filter ./packages/<name>`. Whole-monorepo builds are slow and
unnecessary. If you hit unresolvable workspace imports, the dependency packages just
aren't built yet.

End-to-end sanity check: two node processes against one Postgres, both calling
`setIfNotExists` with the same key. Exactly one should get `true`.

When implementation is done, run `cr review --agent --uncommitted` in the background,
check on it periodically, and fix genuine bugs and critical issues only — ignore nits.

---

## 7. Rules for this repo

- **Never use `any`.** No `as any`, `: any`, `any[]`, `Promise<any>`,
  `Record<string, any>`, `Function`, `Object`. Use `unknown` and narrow, a union, a
  generic, or `Record<string, unknown>`. The only escape hatch is a single-line
  eslint-disable with a comment explaining why no real type works.
- **Keep changes to `packages/core` surgical** — many packages depend on it.
- **Comments only where the code can't speak for itself**: the *why*, a gotcha, a
  deliberate choice that looks like a mistake, the origin of a magic value. Never restate
  what the code says. The two flagged in Step 1 genuinely need one.
- **Don't over-engineer.** No config knobs nobody asked for, no interface with one
  implementation, no abstraction for a second caller that doesn't exist.
- **Don't touch `examples/` or `reference/`.**
- **Never commit or push.** Stop at "ready to commit."
- If a decision comes up that isn't covered here and it changes *behaviour* rather than
  code structure — stop and ask the user. Don't pick a reasonable default.
