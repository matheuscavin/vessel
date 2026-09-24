import test from "node:test";
import assert from "node:assert/strict";
import {
  geometry,
  leaves,
  removeLeaf,
  resizeAt,
  splitLeaf,
} from "../src/layout.ts";
import type { Pane } from "../src/types.ts";

const leaf = (terminalId: string): Pane => ({ type: "leaf", terminalId });

test("a single pane fills the area", () => {
  const { panes, dividers } = geometry(leaf("a"), 0);
  assert.deepEqual(panes.a, { left: 0, top: 0, width: 100, height: 100 });
  assert.equal(dividers.length, 0);
});

test("splitting along one axis stays flat and halves only the target", () => {
  let root = splitLeaf(leaf("a"), "a", "b", "row");
  root = splitLeaf(root, "b", "c", "row");
  assert.deepEqual(leaves(root), ["a", "b", "c"]);
  const { panes } = geometry(root, 0);
  assert.equal(panes.a.width, 50);
  assert.equal(panes.b.width, 25);
  assert.equal(panes.c.width, 25);
  assert.equal(panes.a.height, 100);
  assert.equal(panes.c.left, 75);
});

test("splitting across axes nests and divides the inner box only", () => {
  let root = splitLeaf(leaf("a"), "a", "b", "row");
  root = splitLeaf(root, "b", "c", "column");
  const { panes, dividers } = geometry(root, 0);
  assert.equal(panes.a.width, 50);
  assert.equal(panes.a.height, 100);
  assert.equal(panes.b.width, 50);
  assert.equal(panes.b.height, 50);
  assert.equal(panes.c.top, 50);
  assert.equal(dividers.length, 2);
  assert.deepEqual(
    dividers.map((d) => d.axis).sort(),
    ["column", "row"],
  );
});

test("panes tile the area without overlapping", () => {
  let root = splitLeaf(leaf("a"), "a", "b", "row");
  root = splitLeaf(root, "b", "c", "column");
  root = splitLeaf(root, "a", "d", "column");
  const { panes } = geometry(root, 0);
  const rects = Object.values(panes);
  assert.equal(rects.length, 4);
  const area = rects.reduce((sum, r) => sum + r.width * r.height, 0);
  assert.ok(Math.abs(area - 10000) < 0.001, `covered ${area}`);
  for (const [i, a] of rects.entries())
    for (const b of rects.slice(i + 1)) {
      const overlap =
        Math.max(
          0,
          Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left),
        ) *
        Math.max(
          0,
          Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top),
        );
      assert.equal(overlap, 0);
    }
});

test("removing a pane collapses the split and gives its box to the survivor", () => {
  let root = splitLeaf(leaf("a"), "a", "b", "row");
  root = splitLeaf(root, "b", "c", "column");
  const pruned = removeLeaf(root, "c");
  assert.ok(pruned);
  assert.deepEqual(leaves(pruned), ["a", "b"]);
  const { panes } = geometry(pruned, 0);
  assert.equal(panes.b.height, 100);
  assert.equal(removeLeaf(leaf("a"), "a"), null);
});

test("resizing moves weight between neighbours and respects the minimum", () => {
  const root = splitLeaf(leaf("a"), "a", "b", "row");
  const wider = resizeAt(root, [], 0, 0.25);
  assert.equal(geometry(wider, 0).panes.a.width, 75);
  const clamped = resizeAt(root, [], 0, -5);
  const { panes } = geometry(clamped, 0);
  assert.ok(panes.a.width > 7 && panes.a.width < 9, `clamped to ${panes.a.width}`);
});

test("resizing reaches a nested split through its path", () => {
  let root = splitLeaf(leaf("a"), "a", "b", "row");
  root = splitLeaf(root, "b", "c", "column");
  const { dividers } = geometry(root, 0);
  const inner = dividers.find((d) => d.axis === "column");
  assert.ok(inner);
  const resized = resizeAt(root, inner.path, inner.index, 0.2);
  const { panes } = geometry(resized, 0);
  assert.equal(panes.b.height, 70);
  assert.equal(panes.a.width, 50);
});

test("gaps are taken out of the span, not added to it", () => {
  const root = splitLeaf(leaf("a"), "a", "b", "row");
  const { panes, dividers } = geometry(root, 1);
  assert.equal(panes.a.width + panes.b.width + 1, 100);
  assert.equal(dividers[0].rect.width, 1);
  assert.equal(dividers[0].rect.left, panes.a.width);
});
