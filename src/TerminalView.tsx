import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Terminal } from "@xterm/xterm";
import { TerminalSquare } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { readTerminal, rpc } from "./api";
import { joinWrapped } from "./copy";
import { terminalTheme } from "./themes";
import { commandDefinitions, matches } from "./commands";
import type { Config } from "./types";
export function TerminalView({
  id,
  active,
  visible,
  name,
  onFocus,
  config,
  generation,
  rect,
  accent,
}: {
  id: string;
  active: boolean;
  visible: boolean;
  name: string;
  onFocus: () => void;
  config: Config;
  generation: number;
  /** Percentages within the terminal area. Absent means full bleed. */
  rect?: { left: number; top: number; width: number; height: number };
  /** Drives the focused pane's border; falls back to the theme accent. */
  accent?: string;
}) {
  const host = useRef<HTMLDivElement>(null),
    term = useRef<Terminal | null>(null),
    fit = useRef<FitAddon | null>(null),
    cfg = useRef(config);
  cfg.current = config;
  const [error, setError] = useState("");
  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    setError("");
    const x = new Terminal({
      fontFamily: cfg.current.fontFamily,
      fontSize: cfg.current.fontSize,
      lineHeight: cfg.current.lineHeight,
      scrollback: cfg.current.scrollback,
      theme: terminalTheme(cfg.current.theme),
      cursorBlink: true,
      allowProposedApi: false,
      convertEol: false,
    });
    const f = new FitAddon();
    x.loadAddon(f);
    x.open(host.current);
    term.current = x;
    fit.current = f;
    x.attachCustomKeyEventHandler(
      (e) =>
        !commandDefinitions.some((c) =>
          matches(e, cfg.current.keybindings[c.id] ?? c.key),
        ) && !((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)),
    );
    // Input is serialized so rapid typing and paste preserve byte order.
    let inputs = Promise.resolve();
    const input = x.onData((data) => {
      inputs = inputs
        .then(async () => {
          for (let offset = 0; offset < data.length; offset += 8192) {
            await rpc({
              op: "input",
              id,
              data: data.slice(offset, offset + 8192),
            });
          }
        })
        .catch((e) => {
          if (!disposed) setError(String(e));
        });
    });
    // Dragging a divider refits every frame; only the settled size needs to reach the PTY.
    let pending: { rows: number; cols: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resize = x.onResize((size) => {
      pending = size;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!pending || disposed) return;
        void rpc({ op: "resize", id, ...pending }).catch((e) => {
          if (!disposed) setError(String(e));
        });
      }, 80);
    });
    // Ahead of xterm's own handler, which would write the rows exactly as the program
    // wrapped them.
    const element = host.current;
    const copy = (e: ClipboardEvent) => {
      if (!cfg.current.copyJoinWrapped) return;
      const selection = x.getSelection();
      if (!selection) return;
      e.clipboardData?.setData("text/plain", joinWrapped(selection, x.cols));
      e.preventDefault();
      e.stopPropagation();
    };
    element.addEventListener("copy", copy, true);
    let cursor: number | null = null;
    const readerId = crypto.randomUUID();
    async function pump() {
      while (!disposed) {
        try {
          const data = await readTerminal(id, cursor, readerId);
          if (disposed) break;
          const view = new DataView(
            data.buffer,
            data.byteOffset,
            data.byteLength,
          );
          cursor = Number(view.getBigUint64(0));
          if (data[8]) x.reset();
          if (data.length > 10)
            await new Promise<void>((resolve) =>
              x.write(data.subarray(10), resolve),
            );
          if (data[9]) break;
        } catch (e) {
          if (!disposed) setError(String(e));
          break;
        }
      }
    }
    void pump();
    return () => {
      disposed = true;
      clearTimeout(timer);
      element.removeEventListener("copy", copy, true);
      input.dispose();
      resize.dispose();
      x.dispose();
      term.current = null;
      fit.current = null;
    };
  }, [id, generation]);
  useEffect(() => {
    const x = term.current;
    if (!x) return;
    x.options.theme = terminalTheme(config.theme);
    x.options.fontSize = config.fontSize;
    x.options.fontFamily = config.fontFamily;
    x.options.lineHeight = config.lineHeight;
    x.options.scrollback = config.scrollback;
    if (visible) fit.current?.fit();
  }, [config, visible]);
  useEffect(() => {
    if (!visible || !host.current || !term.current) return;
    const x = term.current;
    let webgl: WebglAddon | undefined;
    try {
      webgl = new WebglAddon();
      x.loadAddon(webgl);
      webgl.onContextLoss(() => webgl?.dispose());
    } catch {
      /* Canvas/DOM rendering remains available. */
    }
    const resize = () => {
      if (host.current?.clientWidth && host.current.clientHeight)
        fit.current?.fit();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    const frame = requestAnimationFrame(resize);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      webgl?.dispose();
    };
    // Focus is deliberately not a dependency: it would recreate the WebGL context on every pane switch.
  }, [visible, generation]);
  useEffect(() => {
    if (visible && active) term.current?.focus();
  }, [visible, active, generation]);
  return (
    <div
      className={`terminal-instance ${visible ? "visible" : ""} ${active ? "focused" : ""}`}
      aria-hidden={!visible}
      onMouseDown={onFocus}
      style={
        {
          ...(rect && {
            left: `${rect.left}%`,
            top: `${rect.top}%`,
            width: `${rect.width}%`,
            height: `${rect.height}%`,
            right: "auto",
            bottom: "auto",
          }),
          ...(accent && { "--swatch": accent }),
        } as CSSProperties
      }
    >
      {visible && (
        <div className="split-terminal-title">
          <TerminalSquare size={12} />
          <span>{name}</span>
          {active && <i className="status-dot live" />}
        </div>
      )}
      <div className="xterm-host" ref={host} />
      {error && (
        <div className="terminal-error">
          Connection interrupted · {error}
          <button onClick={() => location.reload()}>Reconnect</button>
        </div>
      )}
    </div>
  );
}
