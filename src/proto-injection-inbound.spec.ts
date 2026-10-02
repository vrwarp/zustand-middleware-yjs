/*
 * A remote "__proto__" Y.Map entry must never reach store state.
 *
 * Y.Map.prototype.toJSON builds its result with `map[key] = value`, so an
 * entry named "__proto__" whose value is a Y.Map (or plain object) sets the
 * PROTOTYPE of the returned JSON object instead of creating an own property.
 * The inbound paths read the doc through toJSON and insert those objects into
 * store state as-is, so a remote (buggy or malicious) peer can attach
 * inherited properties to store objects: Object.keys looks clean, but property
 * reads and `in` checks see the injected values.
 *
 * lib0 decodes an object-valued ContentAny the same way, so a "__proto__" key
 * inside a plain-object value has the same effect.
 *
 * Contract: the "__proto__" entry is ignored, exactly like the other
 * prototype-pollution guards (outbound mapping, isDangerousKey): objects in
 * store state keep Object.prototype as their prototype and expose no
 * injected properties.
 */
import * as Y from "yjs";
import { createStore } from "zustand/vanilla";
import yjs from ".";

interface Profile {
  theme: string;
  isAdmin?: boolean;
}

interface User {
  name: string;
  isAdmin?: boolean;
  profile?: Profile;
  avatar?: Uint8Array;
  notes?: Y.Doc;
}

interface State {
  users: Record<string, User>;
}

const creator = (): State => ({ "users": {} });

/** Lets the middleware's queueMicrotask inbound batch run to completion. */
const drainInbound = (): Promise<void> =>
  new Promise<void>((resolve) => { setTimeout(resolve, 0); });

/** A remote peer writes users.bob = Y.Map{ name: "bob", ...fill(bob) }. */
const writeBob = (remote: Y.Doc, fill: (bob: Y.Map<unknown>) => void): void => {
  remote.transact(() => {
    const users = new Y.Map<unknown>();
    const bob = new Y.Map<unknown>();

    bob.set("name", "bob");
    fill(bob);
    users.set("bob", bob);
    remote.getMap("store").set("users", users);
  });
};

/** A remote peer writes users.bob = { name: "bob", "__proto__": { isAdmin: true } }. */
const writeMaliciousBob = (remote: Y.Doc): void => {
  writeBob(remote, (bob) => {
    const evil = new Y.Map<unknown>();

    evil.set("isAdmin", true);
    bob.set("__proto__", evil);
  });
};

const expectNoInjectedPrototype = (state: State): void => {
  const bob = state.users.bob as User | undefined;

  expect(bob).toBeDefined();
  expect(bob?.name).toBe("bob");
  expect(bob?.isAdmin).toBeUndefined();
  expect("isAdmin" in (bob as object)).toBe(false);
  expect(Object.getPrototypeOf(bob)).toBe(Object.prototype);
};

describe("inbound remote '__proto__' Y.Map entries are ignored", () => {
  describe.each([
    ["full inbound patch", false],
    ["scopedDiff inbound patch", true],
  ])("%s", (unused, scopedDiff) => {
    it("does not give a store object a remote-controlled prototype", async () => {
      const local = new Y.Doc();
      const remote = new Y.Doc();
      const store = createStore<State>()(yjs(local, "store", creator, { scopedDiff }));

      writeMaliciousBob(remote);
      Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));
      await drainInbound();

      expectNoInjectedPrototype(store.getState());
    });

    it("ignores a '__proto__' entry whose value is a plain object (ContentAny)", async () => {
      const local = new Y.Doc();
      const remote = new Y.Doc();
      const store = createStore<State>()(yjs(local, "store", creator, { scopedDiff }));

      writeBob(remote, (bob) => { bob.set("__proto__", { "isAdmin": true }); });
      Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));
      await drainInbound();

      expectNoInjectedPrototype(store.getState());
    });

    it("ignores a '__proto__' entry whose value is a subdocument", async () => {
      const local = new Y.Doc();
      const remote = new Y.Doc();
      const store = createStore<State>()(yjs(local, "store", creator, { scopedDiff }));

      // A subdocument prototype makes bob pass `instanceof Y.Doc` and exposes
      // the meta the remote chose.
      writeBob(remote, (bob) => { bob.set("__proto__", new Y.Doc({ "meta": { "isAdmin": true } })); });
      Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));
      await drainInbound();

      expectNoInjectedPrototype(store.getState());
      expect("meta" in (store.getState().users.bob as object)).toBe(false);
    });

    it("ignores a top-level '__proto__' entry", async () => {
      const local = new Y.Doc();
      const remote = new Y.Doc();
      const store = createStore<State>()(yjs(local, "store", creator, { scopedDiff }));

      writeBob(remote, () => undefined);
      Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));
      await drainInbound();

      const before = Y.encodeStateVector(local);

      // Delete users while an injected prototype offers a replacement.
      remote.transact(() => {
        const root = remote.getMap("store");
        const evil = new Y.Map<unknown>();
        const users = new Y.Map<unknown>();
        const mallory = new Y.Map<unknown>();

        mallory.set("name", "mallory");
        users.set("mallory", mallory);
        evil.set("users", users);
        root.delete("users");
        root.set("__proto__", evil);
      });
      Y.applyUpdate(local, Y.encodeStateAsUpdate(remote, before));
      await drainInbound();

      expect("users" in store.getState()).toBe(false);
    });

    it("ignores a '__proto__' key inside a plain-object (ContentAny) value", async () => {
      const local = new Y.Doc();
      const remote = new Y.Doc();
      const store = createStore<State>()(yjs(local, "store", creator, { scopedDiff }));

      // JSON.parse makes "__proto__" an own key, which lib0 encodes; the
      // receiving peer decodes it with `obj[key] = value`.
      writeBob(remote, (bob) => {
        bob.set("profile", JSON.parse('{"theme":"dark","__proto__":{"isAdmin":true}}') as unknown);
      });
      Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));
      await drainInbound();

      const profile = store.getState().users.bob?.profile;

      expect(profile?.theme).toBe("dark");
      expect(profile?.isAdmin).toBeUndefined();
      expect("isAdmin" in (profile as object)).toBe(false);
      expect(Object.getPrototypeOf(profile)).toBe(Object.prototype);
    });

    it("keeps binary and subdocument values of a sanitized object intact", async () => {
      const local = new Y.Doc();
      const remote = new Y.Doc();
      const store = createStore<State>()(yjs(local, "store", creator, { scopedDiff }));

      writeBob(remote, (bob) => {
        bob.set("avatar", new Uint8Array([1, 2, 3]));
        bob.set("notes", new Y.Doc());
        bob.set("__proto__", { "isAdmin": true });
      });
      Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));
      await drainInbound();

      const state = store.getState();

      expectNoInjectedPrototype(state);
      expect(state.users.bob?.avatar).toBeInstanceOf(Uint8Array);
      expect(state.users.bob?.avatar).toEqual(new Uint8Array([1, 2, 3]));
      expect(state.users.bob?.notes).toBeInstanceOf(Y.Doc);
    });
  });

  it("does not give a store object a remote-controlled prototype on the scopedDiff deep-path route", async () => {
    const local = new Y.Doc();
    const remote = new Y.Doc();

    // Seed users.bob on both sides so the next remote write is a deep event
    // (path ["users", "bob"]) that the path-scoped inbound route handles.
    remote.transact(() => {
      const users = new Y.Map<unknown>();
      const bob = new Y.Map<unknown>();

      bob.set("name", "bob");
      users.set("bob", bob);
      remote.getMap("store").set("users", users);
    });
    Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));

    const store = createStore<State>()(yjs(local, "store", creator, { "scopedDiff": true }));

    expect(store.getState().users.bob?.name).toBe("bob");

    const before = Y.encodeStateVector(local);

    remote.transact(() => {
      const users = remote.getMap("store").get("users") as Y.Map<unknown>;
      const bob = users.get("bob") as Y.Map<unknown>;
      const profile = new Y.Map<unknown>();
      const evil = new Y.Map<unknown>();

      evil.set("isAdmin", true);
      profile.set("theme", "dark");
      profile.set("__proto__", evil);
      bob.set("profile", profile);
    });
    Y.applyUpdate(local, Y.encodeStateAsUpdate(remote, before));
    await drainInbound();

    const profile = store.getState().users.bob?.profile;

    expect(profile).toBeDefined();
    expect(profile?.theme).toBe("dark");
    expect(profile?.isAdmin).toBeUndefined();
    expect("isAdmin" in (profile as object)).toBe(false);
    expect(Object.getPrototypeOf(profile)).toBe(Object.prototype);
  });

  it("does not give a store object a remote-controlled prototype when hydrating at creation", () => {
    const local = new Y.Doc();
    const remote = new Y.Doc();

    writeMaliciousBob(remote);
    Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));

    const store = createStore<State>()(yjs(local, "store", creator));

    expectNoInjectedPrototype(store.getState());
  });
});

/*
 * "constructor" and "prototype" are dangerous keys too, but toJSON assigns
 * them as ordinary own properties. The sanitize walk must drop them whatever
 * their value: a walk that skips primitive values before checking the key
 * lets `constructor: "x"` through on every route that inserts doc JSON whole.
 */
describe("inbound remote 'constructor' / 'prototype' entries with primitive values are ignored", () => {
  /** A Y.Map{ constructor: "x", prototype: 7, b: 1 }, to be integrated by the caller. */
  const makeDangerousRecord = (): Y.Map<unknown> => {
    const record = new Y.Map<unknown>();

    record.set("constructor", "x");
    record.set("prototype", 7);
    record.set("b", 1);

    return record;
  };

  /** A remote doc holding an empty users map. */
  const makeRemote = (): { remote: Y.Doc; users: Y.Map<unknown> } => {
    const remote = new Y.Doc();
    const users = new Y.Map<unknown>();

    remote.getMap("store").set("users", users);

    return { remote, users };
  };

  const ownKeys = (value: unknown): string[] => Object.keys(value as object);

  describe.each([
    ["full", false],
    ["scopedDiff", true],
  ])("%s", (unused, scopedDiff) => {
    it("drops them when hydrating an absent branch at creation", () => {
      const local = new Y.Doc();
      const { remote, users } = makeRemote();

      users.set("bob", makeDangerousRecord());
      Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));

      const store = createStore<State>()(yjs(local, "store", creator, { scopedDiff }));

      expect(ownKeys(store.getState().users.bob)).toEqual(["b"]);
    });

    it("drops them from an inbound patch of a top-level key", async () => {
      const local = new Y.Doc();
      const { remote, users } = makeRemote();

      Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));

      const store = createStore<State>()(yjs(local, "store", creator, { scopedDiff }));
      const before = Y.encodeStateVector(local);

      // An event on users itself: the key-scoped route under scopedDiff.
      users.set("bob", makeDangerousRecord());
      Y.applyUpdate(local, Y.encodeStateAsUpdate(remote, before));
      await drainInbound();

      expect(ownKeys(store.getState().users.bob)).toEqual(["b"]);
    });

    it("drops them from an inbound patch of a nested branch", async () => {
      const local = new Y.Doc();
      const { remote, users } = makeRemote();
      const bob = new Y.Map<unknown>();

      users.set("bob", bob);
      Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));

      const store = createStore<State>()(yjs(local, "store", creator, { scopedDiff }));
      const before = Y.encodeStateVector(local);

      // An event on users.bob: the deep-path route under scopedDiff.
      bob.set("profile", makeDangerousRecord());
      Y.applyUpdate(local, Y.encodeStateAsUpdate(remote, before));
      await drainInbound();

      expect(ownKeys(store.getState().users.bob?.profile)).toEqual(["b"]);
    });
  });
});
