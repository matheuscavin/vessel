import type { Axis, Pane, PaneChild } from "./types";

/** Percentages of the terminal area, so panes never move in the DOM. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface Divider {
  /** Child indexes from the root to the split that owns this divider. */
  path: number[];
  /** The divider sits between `index` and `index + 1`. */
  index: number;
  axis: Axis;
  rect: Rect;
  /** Combined extent of the two neighbours, as a percentage of the whole area. */
  span: number;
}
export interface Geometry {
  panes: Record<string, Rect>;
  dividers: Divider[];
}

export const MIN_SHARE = 0.08;

export function leaves(pane: Pane): string[] {
  return pane.type === "leaf"
    ? [pane.terminalId]
    : pane.children.flatMap((c) => leaves(c.pane));
}

/**
 * Partitions the area by child weight. Splitting into rectangles rather than nested DOM is
 * what lets every terminal stay mounted in one flat list: panes move by changing four
 * numbers, never by changing parents, so xterm instances and their scrollback survive.
 */
export function geometry(root: Pane | null | undefined, gap = 0.25): Geometry {
  const out: Geometry = { panes: {}, dividers: [] };
  if (root)
    walk(root, { left: 0, top: 0, width: 100, height: 100 }, [], gap, out);
  return out;
}

function walk(
  pane: Pane,
  rect: Rect,
  path: number[],
  gap: number,
  out: Geometry,
): void {
  if (pane.type === "leaf") {
    out.panes[pane.terminalId] = rect;
    return;
  }
  const row = pane.direction === "row";
  const total =
    pane.children.reduce((sum, c) => sum + Math.max(c.size, 0), 0) || 1;
  const span =
    (row ? rect.width : rect.height) - gap * (pane.children.length - 1);
  let offset = row ? rect.left : rect.top;
  pane.children.forEach((child, i) => {
    const size = (Math.max(child.size, 0) / total) * span;
    walk(
      child.pane,
      row
        ? { left: offset, top: rect.top, width: size, height: rect.height }
        : { left: rect.left, top: offset, width: rect.width, height: size },
      [...path, i],
      gap,
      out,
    );
    offset += size;
    if (i < pane.children.length - 1)
      out.dividers.push({
        path,
        index: i,
        axis: pane.direction,
        rect: row
          ? { left: offset, top: rect.top, width: gap, height: rect.height }
          : { left: rect.left, top: offset, width: rect.width, height: gap },
        span:
          ((Math.max(child.size, 0) + Math.max(pane.children[i + 1].size, 0)) /
            total) *
          span,
      });
    offset += gap;
  });
}

/** Halves the target pane. Joins the enclosing split when it already runs along `axis`. */
export function splitLeaf(
  pane: Pane,
  target: string,
  newId: string,
  axis: Axis,
): Pane {
  if (pane.type === "leaf")
    return pane.terminalId === target
      ? {
          type: "split",
          direction: axis,
          children: [
            { size: 1, pane },
            { size: 1, pane: { type: "leaf", terminalId: newId } },
          ],
        }
      : pane;
  if (pane.direction === axis) {
    const i = pane.children.findIndex(
      (c) => c.pane.type === "leaf" && c.pane.terminalId === target,
    );
    if (i >= 0) {
      const half = pane.children[i].size / 2;
      const children = [...pane.children];
      children[i] = { ...children[i], size: half };
      children.splice(i + 1, 0, {
        size: half,
        pane: { type: "leaf", terminalId: newId },
      });
      return { ...pane, children };
    }
  }
  return {
    ...pane,
    children: pane.children.map((c) => ({
      ...c,
      pane: splitLeaf(c.pane, target, newId, axis),
    })),
  };
}

/** Drops a pane, collapsing a split left with one child so the survivor takes its box. */
export function removeLeaf(pane: Pane, terminalId: string): Pane | null {
  if (pane.type === "leaf") return pane.terminalId === terminalId ? null : pane;
  const children = pane.children
    .map((c) => ({ size: c.size, pane: removeLeaf(c.pane, terminalId) }))
    .filter((c): c is PaneChild => c.pane !== null);
  if (!children.length) return null;
  if (children.length === 1) return children[0].pane;
  return { ...pane, children };
}

/** Moves the weight between two adjacent children, keeping both above `MIN_SHARE`. */
export function resizeAt(
  root: Pane,
  path: number[],
  index: number,
  fraction: number,
): Pane {
  if (!path.length) {
    if (root.type !== "split") return root;
    const children = [...root.children];
    const a = children[index];
    const b = children[index + 1];
    if (!a || !b) return root;
    const pair = a.size + b.size;
    const min = pair * MIN_SHARE;
    const next = Math.min(Math.max(a.size + fraction * pair, min), pair - min);
    children[index] = { ...a, size: next };
    children[index + 1] = { ...b, size: pair - next };
    return { ...root, children };
  }
  if (root.type !== "split") return root;
  const [head, ...rest] = path;
  const children = [...root.children];
  children[head] = {
    ...children[head],
    pane: resizeAt(children[head].pane, rest, index, fraction),
  };
  return { ...root, children };
}
