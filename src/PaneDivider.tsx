import { useRef, type PointerEvent } from "react";
import type { Divider } from "./layout";

/**
 * Drags write straight to the parent's draft tree, never to the daemon, so a gesture costs
 * no round trips. The settled tree is committed once on release.
 */
export function PaneDivider({
  divider,
  onStart,
  onDrag,
  onCommit,
}: {
  divider: Divider;
  onStart: () => void;
  /** Cumulative offset since the gesture began, so it always applies to the start state. */
  onDrag: (fraction: number) => void;
  onCommit: () => void;
}) {
  const start = useRef(0);
  const extent = useRef(1);
  const row = divider.axis === "row";
  return (
    <div
      className={`pane-divider ${divider.axis}`}
      role="separator"
      aria-orientation={row ? "vertical" : "horizontal"}
      style={{
        left: `${divider.rect.left}%`,
        top: `${divider.rect.top}%`,
        width: `${divider.rect.width}%`,
        height: `${divider.rect.height}%`,
      }}
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        const area = e.currentTarget.parentElement;
        if (!area) return;
        const box = area.getBoundingClientRect();
        extent.current =
          ((row ? box.width : box.height) * divider.span) / 100 || 1;
        start.current = row ? e.clientX : e.clientY;
        e.currentTarget.setPointerCapture(e.pointerId);
        document.body.classList.add("resizing");
        onStart();
      }}
      onPointerMove={(e: PointerEvent<HTMLDivElement>) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        const moved = (row ? e.clientX : e.clientY) - start.current;
        onDrag(moved / extent.current);
      }}
      onPointerUp={(e: PointerEvent<HTMLDivElement>) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        document.body.classList.remove("resizing");
        onCommit();
      }}
      onPointerCancel={() => {
        document.body.classList.remove("resizing");
        onCommit();
      }}
    />
  );
}
