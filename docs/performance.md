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

### 11. Inbound patches re-read the whole top-level key

The mirror image of §9, on the receiving side, and the larger of the two.
`observeDeep` hands the middleware the exact path of every remote change, but
the scoped inbound patch kept only the FIRST segment of that path and re-read
the entire top-level key: `map.get(key).toJSON()` over the whole tree, then a
deep diff of that JSON against the whole current state, then a rebuild. For a
store whose hot key holds one growing tree, that is O(total state) per inbound
batch — a device pays for its entire library every time another device turns a
page, and the cost grows forever.

This was invisible in the first pass because the store patch is
microtask-batched: timing `Y.applyUpdate` measures only the observer
collecting key names, which is trivially cheap. The benchmark now drains the
microtask and times the patch itself, which is where the work actually was:
**202 ms per inbound page turn at 120 books.**

**Fix:** keep the whole event path, not its first segment, and reconcile at
that path. `computeInboundStateForPaths` reads the doc only at each changed
path, diffs it against the state value at the same path with the same
`patchState` call as before, and rebuilds the spine above it with structural
sharing — so untouched siblings keep their object identity (better referential
stability than rebuilding the whole top-level value, which is what the old
path did on every remote change).

Safety comes from being conservative about when the fast route applies:

- **Any shallow event in the batch disables it.** A top-level key being
  added, replaced or deleted is only visible at that level, so such a batch
  takes the original key-scoped route for all of its changes (which is also
  where merge-defaults delete suppression applies). Keys added, replaced or
  removed *below* a top-level key no longer count as shallow: see §12.
- **A missing branch escalates rather than skipping.** If a named path is
  absent on either side, `computeInboundStateForPaths` returns `undefined`
  and the caller falls back to the key-scoped patch for the whole batch.
  Dropping the path instead would silently lose a change — the one failure
  mode that would not show up as a crash.
- **`syncedKeys` still gates the first segment,** so a deep change under a
  key this store does not replicate is ignored exactly as before.
- **Paths are cut at their first array index.** Numeric segments are not
  reliable by the time the batch runs: Yjs up to 13.6.15 counts Items rather
  than elements in `event.path` (primitives inserted together share one
  Item), and a local write applied or flushed before the batch can shift the
  array. Reading both sides at such an index patches the wrong element, or
  finds two equal wrong elements and drops the change. Map keys are stable,
  so the path stops at the array and the whole array is reconciled; a path
  left under two segments takes the key-scoped route.

Like the key-scoped path it replaces, this reconciles what the events named
rather than the whole subtree — one level deeper, but the same assumption.

### 12. Inbound child-key adds and deletes still re-read the whole key

§11 left one very common case on the slow route. Yjs reports adding,
replacing or removing a key of a Y.Map as ONE event on that map, with
`event.keysChanged` naming the keys. For a map directly under a top-level
key — a new book under `progress`, a highlight created or deleted under
`annotations` — that event's store-relative path is just `[key]`, which the
observer counted as shallow, so the whole batch took the key-scoped route:
`toJSON()` of the entire top-level value, a deep diff, a rebuild. Deep edits
riding in the same batch went with it, and the offline catch-up applied
after a cold start nearly always contains an add, so it materialized the
whole key a second time. One level further down, a map event was reconciled
by reading its whole target map: a fields-only page turn re-serialized all
of that device's reading sessions, and adding one annotation to
`annotations[bookId]` re-serialized every annotation of the book.

**Fix:** when an event's target is a Y.Map and no array index sits above it,
the observer records one *key path* per key in `keysChanged` instead of the
map's own path (or the shallow flag). `computeInboundStateForPaths` groups
the key paths by parent and applies each group to one copy of the parent
record: a key only the doc has is inserted (its sanitized doc JSON), a key
only state has is removed (one filtering pass for all removals), a key on
both sides gets the usual `patchState` reconcile, and a key on neither
(changed and changed back within the batch) is a no-op. The parent must
exist on both sides — a Y.Map in the doc, a record in state — or the batch
escalates exactly as in §11; function-valued state keys are still never
replaced. Events on the store root itself keep the key-scoped route. Of two
equal paths the key path is kept, since it tolerates the key being absent.

Applying key paths one at a time would trade one O(key) re-read for one
O(parent) copy per changed key: in a prototype that did, a remote import of
4,000 annotations into a 4,000-record key went from ~30 ms to ~11 s. Two
supporting changes keep bulk batches linear: each container on a rebuilt
spine is copied once per batch instead of once per path, and
`minimizeInboundPaths` walks a trie instead of comparing every path with
every kept path.

Receiver-side store patch (`bench/inbound-child-keys.ts`, scopedDiff):
median ms of 5 interleaved runs against the parent commit, with the Y.Map +
Y.Array `toJSON()` calls in parentheses (identical in every run). Versicle
`progress` tree, 2 devices × 300 sessions per book:

| books | new book, before | after | drop book, before | after | fields-only turn, before | after |
|---:|---:|---:|---:|---:|---:|---:|
| 10 | 14.8 (6,080) | 0.09 (5) | 9.2 (6,075) | 0.05 (0) | 0.56 (304) | 0.13 (0) |
| 40 | 64.9 (24,290) | 0.12 (5) | 54.9 (24,285) | 0.09 (0) | 0.63 (304) | 0.12 (0) |
| 120 | 178.9 (72,850) | 0.14 (5) | 146.0 (72,845) | 0.15 (0) | 0.65 (304) | 0.21 (0) |

An ordinary page turn (fields plus one appended session) is unchanged at
0.6–0.9 ms; its 304 `toJSON` calls become 302, the sessions array that is
still reconciled whole because array indices are untrusted (§11). Cold
start, stale local doc plus one catch-up transaction of 30 page turns:

| books | turns only, before | after | turns + 1 new book, before | after |
|---:|---:|---:|---:|---:|
| 10 | 5.7 (3,060) | 4.8 (3,040) | 15.4 (6,106) | 5.2 (3,045) |
| 40 | 23.2 (9,120) | 24.8 (9,060) | 60.0 (24,316) | 26.1 (9,065) |
| 120 | 21.0 (9,120) | 19.5 (9,060) | 160.1 (72,876) | 22.7 (9,065) |

Annotations, one remote add or delete:

| annotations | flat add, before | after | flat delete, before | after | per-book add, in book | before | after |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 5.7 (1,002) | 0.48 (1) | 6.0 (1,001) | 0.68 (0) | 100 | 0.31 (105) | 0.03 (1) |
| 4,000 | 24.5 (4,002) | 1.7 (1) | 22.6 (4,001) | 1.6 (0) | 1,000 | 4.2 (1,005) | 0.50 (1) |
| 16,000 | 119.6 (16,002) | 7.4 (1) | 113.5 (16,001) | 6.2 (0) | 5,000 | 21.8 (5,005) | 2.1 (1) |

Bulk batches, one remote transaction into a flat `annotations` record
(medians of 5 interleaved rounds of 3 samples):

| batch | before | after |
|---|---:|---:|
| 100 adds into 1,000 records | 11.4 (1,101) | 0.88 (100) |
| 1,000 adds into 4,000 records | 20.7 (5,001) | 6.8 (1,000) |
| 4,000 adds into 4,000 records | 28.7 (8,001) | 32.6 (4,000) |
| 100 adds into 16,000 records | 101.9 (16,101) | 7.8 (100) |
| 100 deletes from 4,100 records | 328.9 (4,001) | 1.6 (0) |
| 1,000 deletes from 5,000 records | 3,447.6 (4,001) | 4.9 (0) |

The 4,000-into-4,000 row is on par (the samples overlap; a focused re-run
with 9 samples per round measured 48 → 32 ms, and 2,000 into 2,000
25 → 11 ms). The delete rows also stop paying the key-scoped route's
per-key record rebuild in the inbound state applier, which a deep diff of
a record with many deletions still pays elsewhere.

What remains on a flat record is the immutable copy of the record itself
(O(keys), ~7 ms at 16,000 annotations), which every structurally shared
update pays; splitting a huge record by book bounds it by the book.

Like §11, this reconciles what the events named: a child-key event no longer
re-reads the whole key, so it no longer incidentally heals drift elsewhere
in that key. It relies on the invariant §11 already relies on — once
`processBatch` has flushed pending local writes, store and doc agree for
synced keys except where the batch's events point. One observable detail
differs from the key-scoped route: keys inserted by the same batch are
appended in event order (the order the sender wrote them) rather than in
the doc's internal key order, which can differ when a deleted key is
re-added. Values are identical; key order of a record was never replicated
between devices.

### 13. Bulk inbound batches copied the shared parent once per path

§11 was measured with single-path batches. A batch that changes many sibling
records at once names one path per record under the same wide parent —
`['library', 'book-0']` ... `['library', 'book-N']`. That is what an offline
catch-up delivers (y-cinder applies its backlog inside one transaction, so it
arrives as one `observeDeep` call), and so do a backfill migration, a bulk
re-tag and "mark all read". Two costs on the path-scoped route were per path:

- `setStateAtPath` rebuilt the whole spine for every path, so P paths under a
  W-key parent spread that parent P times: O(P × W) property copies
  (16,004,000 for 4,000 changed records, where 4,001 suffice).
- `minimizeInboundPaths` compared every path with every kept path: O(P²),
  exactly 2P² segment reads (31,992,000 at 4,000 paths).

The P × W term is the root cause and dominates. Its constant depends on how
V8 represents the parent: a spread copy of an object with more than ~1,020
keys, or of one already in dictionary mode, is built in dictionary mode at
~0.3-0.5 µs per property, which is why 1,000 → 2,000 records cost far more
than 4×. The route that exists to be the fast path ended up ~300× slower
than the legacy full-tree route.

**Fix:** each spine container is copied at most once per batch.
`computeInboundStateForPaths` keeps a per-call set of the copies it made; a
later path that reaches one writes into it in place instead of copying it
again. Nothing else is ever written — not the store state or anything
reachable from it (it may be frozen, and subscribers share it), and not a
patched value (which shares unchanged subtrees with the old state). Writing
in place is safe because the minimized paths are prefix-free, so no write
lands inside another path's patched value. `minimizeInboundPaths` now walks a
trie keyed by `String(step)` in the same length-sorted order, so its output
and semantics are unchanged (`0` and `'0'` collide; `['a','bb']` does not
cover `['a','b']`). `setStateAtPath` also recurses by depth index instead of
re-slicing the path at every level.

The owned-copy spine and the trie were developed independently for this
section and for §12 (whose key paths need them too); the integrated code
keeps one implementation of each, shared by key paths and node paths. The
numbers below were measured on node-path batches before §12 landed.

Receiver inbound patch, one transaction changes every record of an N-record
library (`runInboundBulkBench`, medians of five interleaved runs):

| records changed | deep-path route, before | after | legacy full-tree route | minimize reads, before | after |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 38.1 ms | 14.6 ms | 8.2 ms | 1,998,000 | 2,000 |
| 2,000 | 1,491.9 ms | 13.8 ms | 10.6 ms | 7,996,000 | 4,000 |
| 4,000 | 6,905.6 ms | 26.9 ms | 29.5 ms | 31,992,000 | 8,000 |

P changed records under one fixed 5,000-record parent (properties copied
are counted exactly, with an instrumented copy of `setStateAtPath`):

| P | before | after | properties copied, before | after |
|---:|---:|---:|---:|---:|
| 1 | 1.95 ms | 2.12 ms | 5,001 | 5,001 |
| 8 | 20.99 ms | 1.88 ms | 40,008 | 5,001 |
| 32 | 65.76 ms | 2.07 ms | 160,032 | 5,001 |
| 128 | 294.75 ms | 2.49 ms | 640,128 | 5,001 |

The deep-path route now costs about the same as the legacy route on a bulk
batch (O(P + W)), and stays flat in P under a fixed parent. (The 1,000 row
runs first in each process and is the noisiest: 7.3-28.7 ms after the fix.) A single-path
batch (a page turn) still pays one O(W) spread of its parent; that copy is
inherent to the immutable-update contract and is unchanged.

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
merge the removed run).

Inbound, on the second client receiving those page turns (§11). `applyUpdate`
and the store patch are timed separately because the patch is
microtask-batched — timing only `applyUpdate`, as this benchmark first did,
measures the observer and misses all of the work:

| books | inbound patch, before | after |
|---:|---:|---:|
| 10 | 10.9 ms | 0.75 ms |
| 40 | 51.9 ms | 0.64 ms |
| 120 | 202.5 ms | 0.78 ms |

Also flat in library size, and the larger of the two wins: a page turn on one
device used to freeze every other device's main thread for a fifth of a
second.

### The remaining floor: cold-start hydration

Attaching a store to an already-populated document — every app launch — is
11.6 / 40.3 / 130.2 ms at 10 / 40 / 120 books. This one is inherent and is
NOT a bug: the store has to materialize the whole tree, and `toJSON()` over
the document dominates (the diff on top of it is only O(top-level branches),
since a branch absent from the initial state is inserted whole rather than
descended). It is reported as a column so that steady-state regressions stay
distinguishable from this unavoidable startup cost. Reducing it would mean
not materializing the whole tree at startup — a consumer-side decision (bind
a narrower store, or split the domain across documents), not something the
middleware can do on its own.

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

Six structural test suites lock the fixes in without flaky wall-clock
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
- `src/inbound-path-scoped.spec.ts` — the §11 fix: a `toJSON` spy proving no
  sibling branch (and not the top-level map) is serialized during a deep
  inbound patch, sibling object identity across a remote change, nested
  deletes, top-level additions and mixed batches taking the escalation route,
  the `syncedKeys` gate, the escalation contract of
  `computeInboundStateForPaths` (missing branch on either side, dangerous
  first segment), `minimizeInboundPaths` segment-wise coverage, and a
  fast-check property running arbitrary remote write sequences through both a
  path-scoped and a key-scoped receiver and asserting they end up identical
  to each other and to the sender. For §12 it adds the key-path contract
  (insert, remove, replace, no-op, parent missing on either side escalates,
  functions kept, a key path wins a tie with an equal node path, the input
  state is never mutated) and a second property, with and without `scope`:
  several remote transactions per tick, receiver-local writes pending in the
  same tick, and branches dropped or replaced by primitives, arrays or null
  at every level; every store must equal its own doc, the docs must
  converge, and the path-scoped receiver must equal a legacy full-tree
  receiver.
- `src/inbound-child-key.spec.ts` — the §12 fix: `toJSON` spies proving
  neither the top-level map nor a sibling is serialized for a remote child
  key add or delete, and exact receiver `toJSON` counts that do not grow with
  4× the siblings (new or dropped book, annotation add or delete, a deep edit
  riding with an add, a fields-only page turn, a per-book annotation add).
  Bulk guards keep a batch of K adds or deletes linear: `toJSON` calls and
  enumerated record entries exactly 4× at 4K/4N and below the key-scoped
  route, key-path reads per path flat as the batch grows (the trie
  minimizer), and — the one ratio of CPU times, because a parent copy leaves
  no trace outside the patch — 64 changed keys under a 5,000-key parent
  costing about what one does.
- `src/inbound-paths-scaling.spec.ts` — the §13 fix: segment-read counters
  (accessor-backed paths) proving `minimizeInboundPaths` and
  `computeInboundStateForPaths` read each path a bounded number of times as
  a bulk batch grows 4×, and a CPU-time *ratio* (a 32-path against a 1-path
  batch under the same 5,000-record parent, never an absolute time;
  1.1-1.4 fixed, 30-36 unfixed, limit 6) proving the shared parent is copied
  once per batch, not once per changed record.
