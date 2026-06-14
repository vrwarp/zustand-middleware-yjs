# Yjs Middleware for Zustand

One of the difficult things about using Yjs is that it's not easily integrated
with modern state management libraries in React. This middleware for Zustand
solves that problem by allowing a Zustand store to be turned into a CRDT, with
the store's state replicated to all peers.

This differs from the other Yjs and Zustand solution, `zustand-yjs` by allowing
any Zustand store be turned into a CRDT. This contrasts with `zustand-yjs`'s
solution, which uses a Zustand store to collect shared types and access them
through special hooks.

Because this solution is simply a middleware, it can also work anywhere Zustand
can be used. The vanilla Zustand `create()` function handles middleware exactly
the same as the React version. And not only that, but it can be composed with
other middleware, such as Immer or Redux!

## Example

```tsx
import React from "react";
import { render } from "react-dom";

import * as Y from "yjs";
import create from "zustand";
import yjs from "zustand-middleware-yjs";

// Create a Y Doc to place our store in.
const ydoc = new Y.Doc();

// Create the Zustand store.
const useSharedStore = create(
  // Wrap the store creator with the Yjs middleware.
  yjs(
    // Provide the Y Doc and the name of the shared type that will be used
    // to hold the store.
    ydoc, "shared",
          
    // Create the store as you would normally.
    (set) =>
      ({
        count: 0,
        increment: () =>
          set(
            (state) =>
            ({
              count: state.count + 1,
            })
          ),
      })
  )
);

// Use the shared store like you normally would any other Zustand store.
const App = () =>
{
  const { count, increment } = useSharedStore((state) =>
    ({
      count: state.count,
      increment: state.increment
    }));

  return (
    <>
      <p>count: {count}</p>
      <button onClick={() => increment()}>+</button>
    </>
  );
};

render(
  <App />,
  document.getElementById("app-root")
);
```

## Options

The `yjs` middleware function takes an optional fourth argument, `options`:

```typescript
export interface YjsOptions {
  atomicKeys?: string[];
  disableYText?: boolean;
  yTextKeys?: string[];
  onLoaded?: () => void;
  schemaVersion?: number;
  onObsolete?: (incomingVersion: number) => void;
  syncedKeys?: readonly string[];
  hydration?: "replace" | "merge-defaults";
  scopedDiff?: boolean;
  scope?: { key: string };
}
```

Every option is opt-in: with none of them set, the middleware behaves exactly
as it did before they were added.

### Disabling Y.Text Mapping globally

By default, strings in the Zustand store are converted to `Y.Text` objects in Yjs to support collaborative text editing. However, if your application does not require collaborative text editing on strings, you can disable this default behavior globally by setting the `disableYText` option to `true`. This causes all strings to be stored as primitive strings in the Yjs map.

```tsx
const useSharedStore = create(
  yjs(ydoc, "shared", (set) => ({ name: "Anonymous" }), {
    disableYText: true,
  })
);
```

When `disableYText` is enabled, you can still opt-in specific keys to use `Y.Text` by providing a list of keys in `yTextKeys`:

```tsx
const useSharedStore = create(
  yjs(ydoc, "shared", (set) => ({ name: "Anonymous", documentBody: "Initial content" }), {
    disableYText: true,
    yTextKeys: ["documentBody"]
  })
);
```

**Migrations:** The middleware handles data migration automatically. If you change a key from being mapped to `Y.Text` to a plain string (e.g. by enabling `disableYText` or adding it to `atomicKeys`), the next time the value is updated in Zustand, it will seamlessly overwrite the `Y.Text` object in Yjs with the plain string. The reverse is also true.

### Schema Version Guard (Poison Pill)

To support backwards-incompatible breaking changes to your data model, you can provide a `schemaVersion` option. If a remote peer writes a `__schemaVersion` to the Yjs document that is strictly *greater* than your local `schemaVersion`, the middleware permanently halts all outbound and inbound synchronization. This "Poison Pill" prevents legacy clients from corrupting newly upgraded data structures offline and unintentionally syncing that corruption back to the network.

When the poison pill is triggered, the `onObsolete` callback is fired, allowing your application to display an update prompt or reload the page.

```tsx
const useSharedStore = create(
  yjs(ydoc, "shared", (set) => ({ count: 0 }), {
    schemaVersion: 2,
    onObsolete: (version) => {
      alert(`Client is outdated! New schema version ${version} detected. Please refresh.`);
    }
  })
);
```

### Replicating only some keys (`syncedKeys`)

By default every non-function top-level key of the store is replicated to the
Yjs document. Set `syncedKeys` to a whitelist to restrict replication — in
**both** directions — to exactly those top-level keys. This is useful when a
store mixes shared, collaborative state with purely local/transient state that
should never leave the device.

```tsx
const useStore = create(
  yjs(ydoc, "shared", (set) => ({
    document: {},      // shared
    cursorPosition: 0, // local-only
    setDocument: (d) => set({ document: d }),
  }), {
    syncedKeys: ["document"],
  })
);
```

- A non-listed key is never inserted, updated, or deleted in the Yjs map by
  this client (outbound), and a foreign map key is never inserted into store
  state nor is a non-listed local key ever touched by remote updates (inbound).
- **Resurrection guard:** a key you remove from `syncedKeys` whose value still
  lives in older documents is ignored in both directions — only a migration can
  remove it from the document, and nothing writes it back.
- When `schemaVersion` is set, `__schemaVersion` is implicitly synced; you do
  not need to list it.
- Nesting below a synced key replicates fully — the whitelist applies only at
  the top level.

In development (`process.env.NODE_ENV !== "production"`) a `syncedKeys` entry
that is missing from the initial state or that points at a function throws
loudly at store creation, surfacing typos early.

### Merge-over-declared-defaults hydration (`hydration`)

The default hydration mode (`"replace"`) makes the document authoritative: a
top-level state key that is absent from the document is deleted from the store
on hydration. This means a field newly added to a store's initial state is
wiped the first time it hydrates from an older document.

Set `hydration: "merge-defaults"` to suppress top-level inbound deletes for the
store's **declared defaults** — the non-function keys of the initial state,
captured before any patching. Everything else still applies: inserts, updates,
and all nested deletes.

```tsx
const useStore = create(
  yjs(ydoc, "shared", (set) => ({
    books: {},
    // Newly added in this version; older docs don't have it.
    fontProfiles: { en: { font: "serif" } },
  }), {
    hydration: "merge-defaults",
  })
);
```

A retained default is not written back to the document until something actually
sets it (lazy backfill). Deliberately removing a top-level key remains a
migration concern: drop it from the defaults and bump `schemaVersion` in the
same release.

### Per-key scoped diffing (`scopedDiff`)

By default each flush re-serializes the entire map and deep-diffs the whole
state. With `scopedDiff: true`, only the top-level keys whose value changed by
reference (`Object.is`) since the start of the batch are diffed, each against
its own subtree, and inbound batches re-read only the keys named by the
incoming Yjs events (so untouched keys keep their object identity). This is a
performance optimization for large stores.

```tsx
const useStore = create(
  yjs(ydoc, "shared", (set) => ({ /* … */ }), { scopedDiff: true })
);
```

`scopedDiff` is sound for stores that follow Zustand's immutable-update
convention. A write that mutates state in place (keeping the same object
reference) is invisible to the fast path; in development the middleware samples
flushes and throws a loud "scopedDiff divergence tripwire" error if it detects
such drift.

### Binding to a nested map (`scope`)

`scope: { key }` binds the store to a nested `Y.Map` at
`doc.getMap(name).get(key)` instead of the top-level named map, while keeping
the flat store shape unchanged. This lets several stores share one named map
under distinct keys (e.g. per-device preferences under `preferences.<deviceId>`)
without changing any call sites.

```tsx
const usePrefs = create(
  yjs(ydoc, "preferences", (set) => ({ theme: "light" }), {
    scope: { key: deviceId },
  })
);
```

- The nested map is created lazily on the first outbound flush, so late-join
  safety is preserved.
- Only transactions touching the scope key reach the store — sibling entries
  never patch it.
- The `__schemaVersion` poison pill still reads the **top-level** named map, so
  the obsolete check is unaffected by scoping.

### The store handle (`api.yjs`)

Stores created with this middleware expose a per-store handle, modeled on
`zustand/persist`'s `api.persist`. Reach it with the typed `getYjsStoreHandle`
accessor:

```tsx
import yjs, { getYjsStoreHandle } from "zustand-middleware-yjs";

const handle = getYjsStoreHandle(useStore);

await handle.whenHydrated();      // resolves after the first patch from the doc
handle.hasHydrated();             // boolean
handle.markHydrated();            // mark hydrated when the doc is synced but empty
handle.flush();                   // drain the pending outbound batch synchronously
handle.isObsolete();              // true once the schema-version poison pill fired
```

`whenHydrated()` resolves strictly after the hydrating `setState`, so an
awaiting caller always observes hydrated state. `markHydrated()` exists for the
case the middleware cannot detect on its own — the document is synced but this
store's map is legitimately empty; it is idempotent and safe to call after real
hydration.

## Caveats

 1. The Yjs awareness protocol is not supported. At the moment, it is unclear
    if the library is able to support Yjs protocols. This means that, for now,
    support for the awareness protocol is not planned.
      * This does not mean you cannot use awareness in your projects - see the
        sister project [y-react](joebobmiles/y-react) for an example of using
        awareness without the middleware.

# License

This library is licensed under the MIT license:

> Copyright © 2021 Joseph R Miles
> 
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the “Software”), to deal 
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is 
> furnished to do so, subject to the following conditions:
> 
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
> 
> THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE. 