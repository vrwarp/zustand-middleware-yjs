/**
 * @jest-environment node
 */
/*
 * Regression: the Y.Text diff must never split a UTF-16 surrogate pair.
 *
 * getChanges() trims the common prefix/suffix and runs the O(NP) diff one
 * UTF-16 code unit at a time. Emoji that share a high surrogate (U+1F600..
 * U+1F64F all start with \uD83D) then produce insert/delete offsets that land
 * between the two halves of a pair. Applied to a Y.Text, Yjs splits the
 * ContentString item mid-pair and replaces both halves with U+FFFD, so the
 * local doc, every peer and every reload read garbage while the author's store
 * still shows the right emoji. The "😀" -> "😀😂" case passes today and is
 * kept as a control.
 *
 * The node environment is used so the update encoder has a native TextEncoder
 * (under jsdom lib0 falls back to encodeURIComponent and the flush throws a
 * URIError instead), which lets the test assert on the visible text.
 */
import * as fc from "fast-check";
import { createStore } from "zustand/vanilla";
import * as Y from "yjs";
import yjs, { getYjsStoreHandle } from ".";
import { patchSharedType } from "./patching";

interface TextState {
  text: string;
}

const textOf = (doc: Y.Doc): unknown => {
  return (doc.getMap("shared").toJSON() as Partial<TextState>).text;
};

describe("Y.Text emoji edits do not split surrogate pairs", () => {
  it.each([
    ["replaces an emoji sharing the high surrogate", "😀", "😁"],
    ["replaces a trailing emoji sharing the high surrogate", "I love 😀", "I love 😁"],
    ["replaces an emoji in the middle of a string", "a😀b", "a😃b"],
    ["inserts an emoji right before another emoji", "😀", "😂😀"],
    ["inserts an emoji right after a space before another emoji", "ok 😀", "ok 😁😀"],
    ["inserts an emoji right after another emoji", "😀", "😀😂"],
    // No common prefix/suffix: the split comes from the inner O(NP) diff.
    ["rewrites text around an emoji edit", "x😀-y", "z😁-w"],
    ["swaps two emoji separated by text", "a😀b😃c", "a😃b😀c"],
    // No shared code point at all: the full-replacement path.
    ["replaces text with an unrelated emoji", "ab😀", "😁"],
  ])("%s (%j -> %j) on the local doc, a peer and a reload", (_name, before, after) => {
    const doc = new Y.Doc();
    const peer = new Y.Doc();
    let encodeError: unknown;

    doc.on("update", (update: Uint8Array) => {
      Y.applyUpdate(peer, update);
    });

    const store = createStore<TextState>()(
      yjs(doc, "shared", () => {
        return { "text": "" };
      })
    );
    const handle = getYjsStoreHandle(store);

    store.setState({ "text": before });
    handle.flush();

    expect(textOf(doc)).toBe(before);
    expect(textOf(peer)).toBe(before);

    try {
      store.setState({ "text": after });
      handle.flush();
    } catch (error: unknown) {
      encodeError = error;
    }

    expect(encodeError).toBeUndefined();
    // The author's store always reads the intended string...
    expect(store.getState().text).toBe(after);
    // ...and so must the shared doc it is mirrored into,
    expect(textOf(doc)).toBe(after);
    // every peer receiving the emitted updates,
    expect(textOf(peer)).toBe(after);

    // and a doc reloaded from the persisted state.
    const reloaded = new Y.Doc();

    Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(doc));

    expect(textOf(reloaded)).toBe(after);
  });

  it("keeps random emoji-heavy edits intact in Y.Text and after a reload", () => {
    // Emoji sharing the \uD83D high surrogate make code-unit splits likely.
    const text = fc.string({
      "maxLength": 12,
      "unit": fc.constantFrom("a", "b", " ", "😀", "😁", "😂", "😃"),
    });

    fc.assert(
      fc.property(text, text, (before, after) => {
        const doc = new Y.Doc();
        const map = doc.getMap("shared");

        map.set("text", new Y.Text(before));
        doc.transact(() => {
          patchSharedType(map, { "text": after });
        });

        const reloaded = new Y.Doc();

        Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(doc));

        expect(textOf(doc)).toBe(after);
        expect(textOf(reloaded)).toBe(after);
      }),
      { "numRuns": 500 }
    );
  });
});
