# Performance

This document describes the middleware's performance characteristics, the
bottlenecks found during the 2026-07 investigation (with a focus on documents
that have been used for a while and have accumulated many changes), the fixes
that landed, and tuning guidance for consumers.

Reproduce all numbers with:

```sh
npm run bench
```

The suite lives in `bench/` and covers text diffing, Y.Text patching, array
diffing, end-to-end outbound/inbound flushes, and a simulated long editing
session ("aged document"). All fixtures are seeded, so runs are deterministic.

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

### 4. Full-tree flush on every set() — mitigated by `scopedDiff`

The legacy outbound path serializes the **entire** root map
(`sharedType.toJSON()`) and deep-diffs the entire state on every microtask
flush; the legacy inbound path re-reads the whole map per batch. This is
O(total state size) per write, regardless of how small the write is. The
`scopedDiff: true` option (per-top-level-key diffing) already existed and is
the structural fix:

| scenario | full-tree | scopedDiff |
|---|---:|---:|
| single-key update in a 100-key store (outbound flush) | 7.0 ms | 0.22 ms (~30×) |

The remaining full-tree cost also dropped ~3.7× from fixes 1–3 (25.6 ms →
7.0 ms), since text keys no longer pay full-window diffs during the tree walk.

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

## Guidance for consumers

- **Enable `scopedDiff: true`** if your store follows Zustand's
  immutable-update convention (a DEV-mode tripwire fails loudly if it
  doesn't). It changes per-write cost from O(total state) to O(changed
  subtree).
- **Use `atomicKeys` (or `disableYText`)** for strings that are not
  collaboratively edited text — UUIDs, enums, base64 blobs. Replacing a
  primitive string is one map operation; replacing a `Y.Text` is a diff plus
  item churn that permanently grows the document.
- **Batching is already automatic.** Multiple `set()` calls in one tick
  coalesce into one Yjs transaction; multiple inbound transactions in one
  tick coalesce into one store patch.
- **Long-lived documents:** Yjs garbage-collects tombstone *content* but not
  item metadata. If a document has accumulated years of history you no longer
  need, snapshot the state into a fresh doc (a schema-version bump via
  `schemaVersion`/`onObsolete` is the supported migration path).

## Regression coverage

`src/text-performance.spec.ts` locks the fixes in structurally (item counts
per edit, change-list size after trimming) plus fast-check equivalence
properties for the coalesced application paths, so CI catches
order-of-magnitude regressions without flaky wall-clock assertions.
