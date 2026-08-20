# Performance

This document describes the middleware's performance characteristics, the
bottlenecks found during the 2026-07 and 2026-08 investigations (with a focus
on documents that have been used for a while and have accumulated many
changes), the fixes that landed, and tuning guidance for consumers.

Reproduce all numbers with:

```sh
npm run bench
```

The suite lives in `bench/` and covers text diffing, Y.Text patching, array
diffing, end-to-end outbound/inbound flushes, a simulated long editing session
("aged document"), and a downstream-shaped scenario where one top-level key
holds a large tree that grows with library size (`bench/versicle.ts`). All
fixtures are seeded, so runs are deterministic.

## Why aged documents get slow

A Yjs document is an append-only log of items. Every insertion creates items;
every deletion leaves tombstones. Two costs grow with that history:

1. **Item traversal.** Position lookups inside `Y.Text`/`Y.Array` walk the
   item list. The more items (including tombstones) an old document has, the
   more expensive each operation on it becomes.
2. **Update payload size.** Every separate operation becomes a separate item
   (until Yjs can merge adjacent ones), so chatty write patterns inflate both
   the document state and every sync message.

The middleware's job — diff the Zustand state, apply the difference to the
doc — sits directly on top of both costs, so how it applies changes matters
more as the document ages.

## Bottlenecks found and fixed

### 1. Per-character Y.Text operations (quadratic; the big one)

The text differ (`src/diff.ts`) emits one change per character. The patcher
applied them one at a time: a 500-character paste became 500 separate
`ytext.insert(i, char)` calls, and a bulk delete became N separate
`ytext.delete(i, 1)` calls. Deletes are the killer: each `delete(i, 1)` walks
the item list **past the tombstones the previous deletes just created**, so a
bulk delete is quadratic in the edit size — and it starts further behind in an
aged document.

**Fix:** `coalesceTextChanges` in `src/patching.ts`. Adjacent per-character
changes are merged into run operations before application (both into `Y.Text`
and into plain state strings on the inbound path). The sequential-application
semantics are preserved exactly; the diff contract is unchanged.

Measured (Node 22, median):

| scenario | before | after |
|---|---:|---:|
| replace 5k-char Y.Text (disjoint content) | **9,379 ms** | **2.4 ms** (~3,900×) |
| append 100 chars to 50k Y.Text | 24.3 ms | 0.66 ms (37×) |
| insert 500 chars mid 50k Y.Text | 25.3 ms | 0.89 ms (28×) |
| inbound 500-char insert into 50k string | 15.4 ms | 0.35 ms (44×) |

Coalescing also creates one Yjs item per run instead of one per character,
which shrinks the document and sync payloads (the aged-doc session below ends
with ~7% fewer items and a ~8% smaller encoded doc even for 8-char edits).

### 2. Full-string diff work for small edits

`getChangesText` ran the Wu et al. O(NP) diff over the **entire** string on
every flush, allocating two O(m+n) frontier arrays each time — ~11 ms per
flush for a 50k-character field even when one character changed. Because the
outbound differ compares every text key on every flush (to detect "no
change"), unchanged large strings still paid an O(n) scan plus, when changed
anywhere, the full-window diff.

**Fix:** common prefix/suffix trimming in `src/diff.ts`. The expensive diff
runs only on the edited window; emitted indices are shifted by the prefix
length, which reproduces whole-string coordinates exactly.

| scenario | before | after |
|---|---:|---:|
| diff: insert 11 chars mid 50k string | 10.9 ms | 0.35 ms (31×) |
| diff: append 100 chars to 50k string | 10.9 ms | 0.36 ms (30×) |

### 3. Change-list allocation as an equality test (array lookahead)

`getArrayChanges`' lookahead matching used `getChanges(a, b).length === 0` as
a deep-equality test — building (and discarding) full recursive change lists
just to learn "equal or not".

**Fix:** `isDeepEqualForDiff`, an early-exit structural comparison with the
exact same semantics (including the differ's quirks: function-valued keys
missing from the new state don't count as differences; non-diffable values
compare strictly). Arrays of 2k objects diff in ~0.13 ms.

### 4. Y.Array bulk deletes (quadratic, same mechanism as text)

Shrinking or clearing a large array emitted one `yarray.delete(i, 1)` per
removed element. Two compounding problems: each single delete walks the item
list past the tombstones the previous deletes created (quadratic), and the
differ emitted *trailing* deletes at ascending indices, which defeats any
batching.

**Fix (two parts):**
- `getArrayChanges` now emits the trailing-block deletes (the "everything
  past this point is gone" case — clears, truncations) at one fixed index.
  Sequential application at a fixed index removes consecutive elements, so
  the block is expressible as a run.
- The Y.Array applier coalesces same-index delete runs into a single range
  `delete(index, count)` (with the legacy end-of-array clamp semantics
  preserved exactly).

| scenario | before | after |
|---|---:|---:|
| clear a 5,000-element Y.Array | **2,265 ms** | **0.95 ms** (~2,400×) |
| remove 500 elements mid a 5,000-element Y.Array | 366 ms | 175 ms (2×) |

The remaining cost in the mid-array case is a diff-quality limit, not an
application cost: block removals larger than the differ's 10-element
lookahead window degrade to element-wise updates (delete+insert per element).
If your workload removes large mid-array blocks, model the list as an object
keyed by id, or split it across top-level keys.

### 5. Repeated subtree serialization in nested recursion

`patchSharedType` serialized the whole shared type at the root, then every
`pending` recursion called `toJSON()` on its child again — the parent's
snapshot already contained every child subtree, so a change at depth *d* paid
for the changed path's subtrees once per ancestor. This also halved the value
of `scopedDiff`, whose per-key snapshot was re-serialized by the recursion.

**Fix:** the already-computed JSON snapshot is threaded down through Y.Map
pending recursion (`precomputedJson`), so each subtree is serialized exactly
once per flush. Y.Array pending recursion still re-serializes its (changed)
elements: earlier sibling inserts/deletes shift positions, so a precomputed
snapshot cannot be trusted there. A structural test asserts the call count
(one serialization per level) so regressions are caught without timing.

### 6. Deep-equality cost in full-tree object diffs

Between a map's JSON and the store state no object is ever reference-equal,
so a full-tree diff pays a structural comparison for every array element and
record key. Two changes cut that constant: `getRecordChanges` now uses the
early-exit equality check as a prefilter (unchanged subtrees no longer build
and discard trees of empty change lists), and the equality helper checks
primitive `===` before any type classification and avoids per-field tuple
allocations.

| scenario | before | after |
|---|---:|---:|
| update 1 field of one object in a 2,000-object Y.Array | 14.5 ms | 7.4 ms |
| update 1 of 1,000 nested objects under a single key | 5.5 ms | 3.5 ms |
| e2e single-key update, 100-key store (full-tree flush) | 9.2 ms | 3.5 ms |
| e2e inbound full-tree patch, 100-key state | 0.27 ms | 0.09 ms |

### 7. Correctness: inbound array deletes were misapplied

Found while validating the array work: `getArrayChanges` emits delete indices
in sequential post-application coordinates (the interpretation the Y.Array
applier uses), but the inbound state applier (`applyChangesToArray`) applied
all deletes FIRST in descending index order — an original-coordinates
assumption. Any change list mixing a lookahead delete with trailing deletes
was corrupted on the store side while the doc side stayed correct: a remote
peer changing `[1, 2, 3]` to `[2]` patched the local store to `[3]`, silently
diverging store from doc. The random fuzz suite never caught it because
arbitrary values rarely produce the overlapping-element shapes that trigger
lookahead matches.

**Fix:** the inbound applier now applies changes strictly in list order with
evolving indices — the same interpretation as the Y.Array applier — and a
fast-check suite with high-collision arrays (where overlaps are common)
cross-validates both appliers on every run.

### 8. Full-tree flush on every set() — mitigated by `scopedDiff`

The legacy outbound path serializes the **entire** root map
(`sharedType.toJSON()`) and deep-diffs the entire state on every microtask
flush; the legacy inbound path re-reads the whole map per batch. This is
O(total state size) per write, regardless of how small the write is. The
`scopedDiff: true` option (per-top-level-key diffing) already existed and is
the structural fix:

| scenario | full-tree | scopedDiff |
|---|---:|---:|
| single-key update in a 100-key store (outbound flush) | 3.5 ms | 0.21 ms (~17×) |

The remaining full-tree cost also dropped ~7× across this work (25.6 ms →
3.5 ms): text keys no longer pay full-window diffs during the tree walk, each
subtree serializes once, and unchanged subtrees compare without allocating
change lists. `scopedDiff` remains the structural fix — O(changed subtree)
instead of O(total state) per write.

### 9. `scopedDiff` stopped at the top level (one hot key = no scoping)

`scopedDiff` confines a write to the top-level keys whose values changed by
reference. That is the right granularity when a store spreads its data across
many top-level keys, but downstream stores commonly put a whole domain under
**one** key — e.g. a `progress` map of `bookId -> deviceId -> { fields,
readingSessions[] }` that grows with the user's library. Every write touches
that one key, so the scope filter never excluded anything and each write paid
`toJSON()` plus a deep diff over the entire tree: O(total library), not
O(changed branch). The cost grows with library size forever, so a reader with
120 books paid ~112 ms of main-thread work per page turn.

**Fix:** `patchSharedTypeScoped` now descends *within* a changed key instead
of handing the whole subtree to the generic differ. At each plain-record level
whose doc-side counterpart is an existing `Y.Map`, it walks the union of the
previous and next child keys, skips children that are reference-identical
(`Object.is`) with unchanged presence, and recurses only into the rest. Only
the leaf that actually changed is serialized and diffed.

Two invariants keep this exactly equivalent to the full diff:

- **Backfill.** Descent requires the doc-side child to be an existing
  `Y.Map`; a missing container falls back to a whole-subtree insert, so a
  first flush (or any branch the doc has never seen) is still written in full.
- **No resurrection.** Identity-equal branches are skipped rather than
  rewritten, so a nested key another peer concurrently deleted is not
  re-inserted by an unrelated local write to a sibling branch.

Anything that is not a plain record over a `Y.Map` (arrays, text, type
changes) still goes through the confined legacy single-key path, so the
change is a pure narrowing of what gets walked.

### 10. Block splices beyond the lookahead window (the sawtooth)

Capped append-only lists — "keep the last N sessions/events/messages" — trim
by removing a large head block: 500 elements become the last 300. That is a
200-element removal, far beyond the differ's 10-element deep-equality
lookahead window (§3), so the differ fell back to element-wise
reconciliation: ~300 rewrites, ~30 KB of update payload, and **+244 Yjs items
permanently added to the document** on every trim. Repeated over a long-lived
document, that is the dominant source of item growth for this shape of data.

Widening the window is not an option — the window is deep-equality-based, so
its cost is O(window × subtree size).

**Fix:** an identity-based scan that runs only after the deep-equality window
fails, is pointer-comparison-only (never deep equality), and is budgeted
(`max(1000, 4 × (a.length + b.length))` comparisons) so arrays that share no
references stop scanning and keep the legacy behavior. Immutable-update
splices (`slice`/`filter`/`concat`) preserve element identity, so a shifted
block shows up as the *same object reference* further along the other side.

Two modes, because the outbound differ compares doc JSON against state:

- **Direct** — `a` shares references with `b` (state-vs-state diffs).
- **Hinted** — `a` is a fresh `toJSON()` snapshot and shares nothing, but the
  caller's *previous state* for the same array does. An identity hit in the
  previous state only **proposes** a shift; one deep-equality check against
  `a` confirms it. If the doc diverged from the previous state (a concurrent
  remote edit), the confirm fails and the legacy element-wise path runs. A
  stale hint can therefore cost one extra comparison — never a wrong emit.

`patchSharedTypeScoped` passes the previous state as the hint on its array
fast path; `getChanges(a, b, { previousA })` exposes it directly.

The 500 → 300 trim now emits one coalesced 200-element range delete plus the
append, and **removes** items from the document instead of adding them.

## Downstream-shaped aging scenario (one hot top-level key)

`bench/versicle.ts` models the shape §9 and §10 were found in: a single
`progress` top-level key holding `bookId -> deviceId -> { fields,
readingSessions[] }`, 300 live sessions per device and two devices per book,
with `scopedDiff: true`. Each measured page turn rewrites a handful of fields
in **one** device branch and appends one session; the sawtooth trips the
500 → keep-last-300 cap (median of five fill/splice cycles, because a
single-shot sample at these fixture sizes mostly measures V8 GC pauses).

Page-turn flush latency, by library size:

| books | live sessions | before | after |
|---:|---:|---:|---:|
| 10 | 6,000 | 8.19 ms | 0.45 ms |
| 40 | 24,000 | 29.52 ms | 0.40 ms |
| 120 | 72,000 | 112.51 ms | 0.51 ms |

The before column scales linearly with library size; the after column is flat,
which is the actual fix — cost is now proportional to the changed branch, not
to the document.

The sawtooth trim, at 120 books:

| metric | before | after |
|---|---:|---:|
| splice flush | 180.9 ms | 12.6 ms |
| update payload | 29,246 B | 300 B |
| Yjs items added to the doc | +244 | −795 |

The item delta is the durable part: the trim used to *grow* the document by
244 items each time it fired, and now shrinks it (the range delete lets Yjs
merge the removed run). Inbound apply on a second client also improved at
every scale (1.05–1.49 ms → 0.21–0.30 ms), since the patch path is scoped the
same way.

## Aged-document session (end-to-end)

500 edits (mostly 8-char insertions, 20% 40-char deletions) against a
~2k-char `Y.Text` note through the real middleware:

| metric | before | after |
|---|---:|---:|
| total session time | 567 ms | 95 ms |
| mean flush latency (last 25 edits) | 1.02 ms | 0.20 ms |
| encoded doc state after session | 17,991 B | 16,604 B |
| Yjs item count after session | 1,279 | 1,184 |

Latency no longer degrades measurably as this document ages, and the doc/
network footprint is smaller.

## Aged-object session (end-to-end, no text)

The same shape of session against pure object/array state: 500 edits (nested
counter bumps, tag-array appends and removals) across 20 sections through the
real middleware:

| metric | before | after |
|---|---:|---:|
| total session time | 82.9 ms | 54.0 ms |
| mean flush latency (last 25 edits) | 0.157 ms | 0.126 ms |
| Yjs item count after session | 599 | 599 |

(Item counts are identical by construction — object edits were never
per-item pathological the way text and array bulk edits were; the win here is
per-flush diff cost. Encoded byte counts vary ±10% between runs because the
random Yjs client ID changes varint widths, so they are not comparable
run-to-run.)

## Guidance for consumers

- **Enable `scopedDiff: true`** if your store follows Zustand's
  immutable-update convention (a DEV-mode tripwire fails loudly if it
  doesn't). It changes per-write cost from O(total state) to O(changed
  branch) — including *within* a single top-level key, so putting a whole
  growing domain under one key is no longer a scaling problem (§9).
  Reference-identical branches are skipped, so keep using immutable spreads:
  rebuilding an unchanged branch (deep-cloning state, `JSON.parse(JSON
  .stringify(...))`, re-mapping a list that did not change) destroys the
  identity the fast path relies on and silently restores full-tree cost.
- **Use `atomicKeys` (or `disableYText`)** for strings that are not
  collaboratively edited text — UUIDs, enums, base64 blobs. Replacing a
  primitive string is one map operation; replacing a `Y.Text` is a diff plus
  item churn that permanently grows the document.
- **Batching is already automatic.** Multiple `set()` calls in one tick
  coalesce into one Yjs transaction; multiple inbound transactions in one
  tick coalesce into one store patch.
- **Large arrays:** appends, single-element edits, clears, truncations, and
  block splices (head/mid removals and insertions of any size) are all cheap,
  *provided the surviving elements keep their identity* — i.e. the new array
  is built from the old one (`slice`, `filter`, `concat`, spread) rather than
  rebuilt from scratch. A rebuilt array shares no references, so a large
  splice in it still degrades to element-wise updates; prefer id-keyed
  objects for collections with heavy mid-list churn that cannot preserve
  identity.
- **Long-lived documents:** Yjs garbage-collects tombstone *content* but not
  item metadata. If a document has accumulated years of history you no longer
  need, snapshot the state into a fresh doc (a schema-version bump via
  `schemaVersion`/`onObsolete` is the supported migration path).

## Regression coverage

Three structural test suites lock the fixes in without flaky wall-clock
assertions:

- `src/text-performance.spec.ts` — Y.Text run coalescing (item counts per
  edit), prefix/suffix trimming (change-list size), plus fast-check
  equivalence properties for the coalesced text application paths.
- `src/object-array-patching.spec.ts` — the inbound array-delete correctness
  fix (explicit cases plus fast-check cross-validation of the state applier
  against the Y.Array applier with high-collision arrays), Y.Array delete-run
  coalescing (large-clear ceiling), and precomputed-JSON threading (a
  `toJSON` call-count spy proving one serialization per subtree per flush).
- `src/branch-scoped-diff.spec.ts` — the §9/§10 fixes: a `toJSON` spy
  proving sibling branches are never serialized when one branch changes,
  first-flush whole-subtree backfill, no resurrection of concurrently
  remote-deleted nested keys, scoped-vs-full convergence over write
  sequences, hinted splice detection (one delete run, zero rewrites), hint
  *rejection* when the doc diverged from the previous state, and an
  end-to-end sawtooth asserting the trim stays under 1 KB of update payload.
