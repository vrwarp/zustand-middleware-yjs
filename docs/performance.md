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
changes are merged into run operations before application (into `Y.Text`,
and at the time also into plain state strings on the inbound path, where §15
later removed the text diff altogether). The sequential-application semantics
are preserved exactly; the diff contract is unchanged.

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

The remaining cost in the mid-array case was blamed on diff quality: block
removals larger than the differ's 10-element lookahead window degrade to
element-wise updates (delete+insert per element). Part of it was application
cost after all — each of those updates was its own Yjs call pair, quadratic
for primitive elements — and §16 now applies them as one ranged delete plus
one insert per contiguous run; §10's identity scan finds the block outright
when the new array is built from the old one (this scenario is a single range
delete today). A rebuilt array still rewrites every shifted element as a new
item, so if your workload removes large mid-array blocks from lists it
rebuilds, model the list as an object keyed by id, or split it across
top-level keys.

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

- **A shallow event sends only its own key to the key-scoped route.** A
  top-level key being added, replaced or deleted (or edited inside a
  top-level array, whose path is cut to one segment; see below) is only
  visible at that level, so that key is re-read whole by the original
  key-scoped patch, which is also where merge-defaults delete suppression
  applies. Top-level keys reconcile independently, so the deep paths under
  every other key in the batch stay on this route, and both parts land in
  one `setState`. Deep paths under a key that is re-read whole are dropped:
  the re-read covers them, and if the batch deleted that key they would
  name a missing branch and escalate the whole batch (next bullet). Keys
  added, replaced or removed *below* a top-level key are not shallow at
  all: see §12.
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

The first version tracked shallow events with one batch-wide flag, so a
single one sent *every* change in the batch down the key-scoped route,
re-reading the hot key in full although it only had a deep change. The
trigger is ordinary: a small synced field (`selectedId`, `updatedAt`, a
counter) written next to a deep change, in the same transaction or just in
the same tick; an edit of a short top-level array; a write to a top-level
key this store does not even sync (another store sharing the named map);
or the caller's write next to the store's own flush (see
`src/own-flush-in-user-transaction.spec.ts`). Receiver patch for one page
turn on the versicle `progress` tree (the downstream scenario below), with
a string `currentBookId` and a five-element `recentBookIds` array in the
same store (`bench/inbound-mixed-batch.ts`); median ms of 7 interleaved
runs against the parent commit, with the Y.Map + Y.Array `toJSON()` calls
in parentheses (identical in every run):

| books | page turn alone | + string, same txn, before | after | + string, next txn, before | after | + array edit, before | after |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 0.53 (307) | 11.4 (6,097) | 0.59 (307) | 10.3 (6,098) | 0.68 (307) | 11.1 (6,100) | 0.57 (308) |
| 40 | 0.54 (304) | 48.6 (24,307) | 0.60 (304) | 52.5 (24,308) | 0.73 (304) | 54.3 (24,310) | 0.65 (305) |
| 120 | 0.71 (304) | 160.8 (72,867) | 0.67 (304) | 166.8 (72,868) | 0.68 (304) | 163.2 (72,870) | 0.78 (305) |

A mixed batch now costs what its deep part costs plus the small keys
themselves (the array edit adds its one `toJSON`), flat in library size.
The gain is for stores that keep small synced fields next to a large tree
key. Versicle's synced stores keep one data key per named map
(`progress`, `books`, `annotations`, `entries`, plus the implicit
`__schemaVersion`), so they rarely hit this: a schema-version write during
a migration, or an old client writing a key the store no longer syncs.

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
a record with many deletions paid elsewhere until §14 made it one pass.

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

### 14. Inbound bulk record deletes (quadratic)

Every inbound route — the §11 deep-path route, the key-scoped route, the
legacy full-tree route and creation hydration — ends in the state applier,
and its record case rebuilt the whole record (`Object.entries` + `filter` +
`Object.fromEntries`) once per `[delete, key]` change. A peer removing k
entries from one n-key record therefore cost O(n × k) on every receiving
device's main thread: bulk-deleting books, clearing or pruning an id-keyed
annotations or progress map, or an offline device catching up on many
separate deletes (inbound transactions in one tick merge into one patch).

**Fix:** `applyChangesToObject` collects deleted keys in a Set and filters
the record once at the end — O(n + k). The output is unchanged:
`getRecordChanges` never deletes and writes the same key in one list, so
survivors keep their relative order and inserts still append. The rebuild
stays on `Object.fromEntries`, which keeps an own `"__proto__"` key as data
(plain assignment would set the prototype), and a change list without
deletes still returns the single spread copy.

`bench/record-delete.ts` (interleaved A/B, median of 5 rounds; `enumerated`
is the deterministic count of record entries materialized by the `Object`
enumeration built-ins):

| scenario | before | after |
|---|---:|---:|
| `patchState`: delete 500 of 1,000 keys | 303 ms (752,502) | 2.3 ms (4,002) |
| `patchState`: delete 1,000 of 2,000 keys | **1,653 ms** (3,005,002) | **6.7 ms** (8,002) |
| `patchState`: clear 1,000 keys | 284 ms (1,002,002) | 1.1 ms (3,002) |
| inbound, deep route: peer deletes 500 of 1,000 books | 349 ms | 10.1 ms |
| inbound, deep route: peer deletes 1,000 of 2,000 books | **1,827 ms** | **23.3 ms** |
| inbound, key-scoped route: 500 of 1,000 | 290 ms | 7.4 ms |
| inbound, legacy route: 500 of 1,000 | 289 ms | 6.9 ms |

The before column grows with n × k (4× the entries for 2× n and 2× k, and
more than 4× the time once GC joins in); the after column grows with n.
At today's library sizes (tens to hundreds of books) the old cost was at
most ~15 ms; the win is for id-keyed maps with thousands of entries.

### 15. Text diffs computed and thrown away (string writes)

The record and array differs built a nested change list for every unequal
string pair, which runs the O(NP) text diff of §2: quadratic in the edit
distance, in time and in memory. Nothing used that list:

- **Outbound, primitive strings** (`atomicKeys`, `disableYText`) are written
  with one `map.set` (a delete+insert in a `Y.Array`); the list was
  discarded.
- **Outbound, `Y.Text` children** are patched by their own `patchSharedType`
  call, which diffed the same pair again. In full-tree mode every `Y.Map` or
  `Y.Array` level re-diffs its subtree, so a string three records deep paid
  four text diffs per flush.
- **Inbound,** `patchState` diffed the state string against the doc string
  and applied the result, rebuilding a string that is by construction the
  doc string. Strings are primitives, so there is no identity to preserve.

§2's prefix/suffix trimming keeps this to microseconds for small edits (a
title, a CFI), but replacing a long string, which is exactly what
`atomicKeys` and `disableYText` are recommended for, ran a full-window diff
on the sender **and on every receiver**. A 4k-char replacement grew the heap
by ~600 MB, and a 6k-char base64 replacement (a ~4.5 KB thumbnail) ran out
of memory under a 1 GB heap (`--max-old-space-size=1024`).

**Fix:** an internal `nestedStrings` option on `getChanges`; its default
output is unchanged.

- `"defer"` (`patchSharedType` and both scoped paths): an unequal nested
  string pair emits a `pending` change carrying a sentinel instead of a
  diff. The applier never reads a pending payload: it writes a primitive
  whole, repairs a `Y.Text` ↔ string mapping change, or recurses into the
  `Y.Text`, whose own call runs the one diff that is applied. A top-level
  string pair is never deferred.
- `"update"` (`patchState`): the pair emits an `update` carrying the doc
  string, and a top-level string pair returns the doc string directly.

Only the final element-wise emit changes, so array alignment and every other
change are identical to the default output (a fast-check property pins this).
The sentinel is a symbol, not an empty list: applying it by mistake throws
instead of silently dropping the edit.

`bench/string-diffs.ts`, interleaved A/B, median of five process runs (each a
median of 5-31 runs) on a heavily loaded 4-CPU box; `textDiffs` is the exact
number of text diffs one operation runs:

| scenario | before | after | textDiffs |
|---|---:|---:|---:|
| replace a 1k-char `disableYText` string (scoped) | 56.9 ms | 0.20 ms | 1 → 0 |
| replace a 2k-char `disableYText` string (scoped) | 229 ms | 0.05 ms | 1 → 0 |
| replace a 4k-char `disableYText` string (scoped) | 912 ms | 0.09 ms | 1 → 0 |
| replace a 4k-char `disableYText` string (full-tree) | 1,048 ms | 0.07 ms | 1 → 0 |
| replace a 4k-char `atomicKeys` string (full-tree) | 926 ms | 0.07 ms | 1 → 0 |
| replace one of fifty 1k-char array strings (full-tree) | 86.8 ms | 1.04 ms | 2 → 0 |
| replace one of fifty 1k-char array strings (scoped) | 34.4 ms | 0.71 ms | 1 → 0 |
| 1-char insert into a 50k-char `Y.Text` (full-tree) | 1.03 ms | 0.53 ms | 2 → 1 |
| 1-char insert into a 50k-char `Y.Text` (scoped) | 0.96 ms | 0.52 ms | 2 → 1 |
| inbound patch, replaced 1k / 2k / 4k-char string | 38 / 135 / 757 ms | 0.02 ms | 1 → 0 |
| inbound patch, 1-char insert into a 50k-char string | 0.36 ms | 0.003 ms | 1 → 0 |

The bench's random strings are not a contrived worst case. Replacing one
`disableYText` string of a realistic shape (scoped flush on the sender,
inbound patch on a receiver; interleaved, median of five):

| shape | 1k chars | 2k chars | 4k chars |
|---|---:|---:|---:|
| English prose, sender | 40 ms | 107 ms | 529 ms |
| English prose, receiver | 33 ms | 116 ms | 570 ms |
| base64, sender | 42 ms | 185 ms | 897 ms |
| base64, receiver | 38 ms | 213 ms | 838 ms |

After the fix every cell is under 0.3 ms and flat in length, and the 6k
base64 replacement completes with ~43 MB of heap in use. For stores of short
strings with small edits (versicle's CFIs and titles) the per-flush saving is
microseconds; the value is removing the out-of-memory tail when a long string
is replaced, plus ~1.9× on keystrokes in very large `Y.Text` notes.

### 16. Y.Array bulk primitive inserts and rewrites (quadratic inside Yjs)

The array differ emits one change per element — an append of k elements is k
inserts at n, n+1, ..., a rewrite is k contiguous updates (or k `pending`
string diffs) — and the Y.Array applier issued one `yarray.insert(i, [value])`
(plus a `delete(i)` for updates) per change. For elements that integrate with
a single clock — numbers, booleans, null, strings under `disableYText`, empty
objects and arrays — that is quadratic inside Yjs: one transaction hands them
consecutive clocks from the same client, and on every insert Yjs's
`findMarker` walks left across the whole mergeable run inserted so far, so k
inserts step over ~k²/2 items. Objects with fields break the clock run (their
field items take clocks in between), which is why the object-array benches
never showed it, and the first flush (`arrayToYArray`, one insert of
everything) was never affected. Mid-array and head block inserts were already
linear; appends and element-wise rewrites — an import or restore, bulk-adding
ids to a shelf, rebuilding a list of ids or CFI ranges — were not.

**Fix:** `coalesceArrayElementRuns` in `src/patching.ts` merges insert (or
update) changes at strictly contiguous ascending indices into one run,
applied as a single `insert(i, values)` (after one `delete(i, k)` for
updates). Under `disableYText` a `pending` change on a string element joins
update runs: both of its branches already replaced the element by delete +
insert, and a string-list rewrite diffs every element as pending. Runs stop at
any other change and at function values, so the pending `previousState`
alignment and the delete-run clamp are unchanged, and values are mapped
exactly as before. Yjs merged the per-element items when the transaction
ended anyway, so the document is byte-identical — items, clocks, origins and
update bytes do not change, only the CPU spent inside Yjs.

Measured with `bench/yarray-runs.ts` (through the middleware with
`disableYText` + `scopedDiff`, Node 22, Yjs 13.5.52; medians of five
interleaved before/after runs; "item visits" counts reads of `Item#deleted`,
i.e. the items Yjs's list walks step over):

| scenario | before | after | item visits |
|---|---:|---:|---:|
| append 2,000 ids to a 1,000-id list | 514 ms | 1.3 ms | 6.0M → 17 |
| append 4,000 numbers | **2,167 ms** | **1.0 ms** (~2,000×) | 24.0M → 17 |
| rewrite all 4,000 numbers (update path) | 480 ms | 1.1 ms | 8.1M → 22 |
| rewrite all 4,000 ids (pending-string path) | 902 ms | 9.2 ms | 16.1M → 22 |
| append 4,000 objects with fields (control) | 141 ms | 28 ms | 334k → 44k |

Before the fix, item visits grew 4.0× per doubling of the run (1k → 2k → 4k
elements); now they are flat. Below ~200 elements per flush the old cost was a
few milliseconds, so everyday edits were never affected — this was a cliff
for bulk operations on primitive lists.

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
  primitive string is one map operation, with no text diff on the sender or
  on any receiver whatever its length (§15); replacing a `Y.Text` is a diff
  plus item churn that permanently grows the document.
- **Batching is already automatic.** Multiple `set()` calls in one tick
  coalesce into one Yjs transaction; multiple inbound transactions in one
  tick coalesce into one store patch.
- **Large arrays:** appends, single-element edits, clears, truncations, and
  block splices (head/mid removals and insertions of any size) are all cheap,
  *provided the surviving elements keep their identity* — i.e. the new array
  is built from the old one (`slice`, `filter`, `concat`, spread) rather than
  rebuilt from scratch. A rebuilt array shares no references, so a large
  splice in it still degrades to element-wise updates (applied as one ranged
  rewrite since §16, but every rewritten element becomes a new item); prefer
  id-keyed objects for collections with heavy mid-list churn that cannot
  preserve identity.
- **Long-lived documents:** Yjs garbage-collects tombstone *content* but not
  item metadata. If a document has accumulated years of history you no longer
  need, snapshot the state into a fresh doc (a schema-version bump via
  `schemaVersion`/`onObsolete` is the supported migration path).

## Regression coverage

Eleven structural test suites lock the fixes in without flaky wall-clock
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
- `src/inbound-record-delete.spec.ts` — the §14 fix: spies on the `Object`
  enumeration built-ins count the record entries materialized per patch,
  pinning a ~4× (not ~16×) cost ratio at 4× record width and delete count,
  and deleting half of a 1,000-key record at no more than twice the cost of
  deleting one key — on `patchState`, all three inbound routes and creation
  hydration. Guards for survivor key order and for an own `"__proto__"` key
  staying data rather than becoming the prototype.
- `src/discarded-string-diff.spec.ts` — the §15 fix: a `getChanges` spy
  counting text diffs per flush and per inbound batch in both modes: zero
  for primitive strings (top level, three records deep, array elements) and
  for receivers, exactly one for a `Y.Text` keystroke (the applied diff,
  which doubles as a liveness check on the spy). Plus a fast-check property
  that the internal `nestedStrings` modes change only how nested string
  pairs are described (array alignment and every other change identical to
  the default output), and that the deferral sentinel cannot be applied as
  an empty change list.
- `src/yarray-insert-runs.spec.ts` — the §16 fix: Y.Array insert/delete call
  counts for bulk primitive appends and rewrites (update and pending-string
  paths, legacy and `scopedDiff`), an `Item#deleted` read count proving the
  Yjs list-walk work of an append grows linearly, and a fast-check property
  that patches random write sequences (with concurrent remote edits) into two
  docs — one through the library, one through an element-wise reference
  applier — and requires byte-identical encoded state after every patch.
- `src/inbound-mixed-shallow-batch.spec.ts` — the per-key shallow split of
  §11: `toJSON` spies proving the hot key and an untouched sibling are
  never serialized when a top-level primitive is written in the same
  transaction or tick as a deep change, a top-level array is edited, a
  top-level key is deleted, a non-synced key is written, or under `scope`;
  the mixed batch's receiver `toJSON` count equals its deep part's at 10
  and 40 books; one notification, convergence and sibling identity per
  mixed batch.
- `src/inbound-mixed-batch-convergence.spec.ts` — a fast-check property
  for the same split, under `replace` and merge-defaults, with and without
  `scope`: several remote transactions per tick mixing deep edits, child
  adds and drops, top-level primitive, array and map sets, replacements and
  deletes (the hot key's included) and non-synced writes, some batches
  ending with a caller transaction around the store's own flush. After
  every batch the scopedDiff receiver must equal a legacy full-tree
  receiver, each store its own doc, and it must notify at most once. Plus a
  `toJSON` pin that a deep path under a key the batch deletes is dropped
  rather than escalating the whole batch.
