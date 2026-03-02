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
}
```

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