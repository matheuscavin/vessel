import { DirectoryField } from "./DirectoryField";
import { Select } from "./Select";
import { PaneDivider } from "./PaneDivider";
import { geometry, resizeAt, splitLeaf } from "./layout";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type CSSProperties,
} from "react";
import {
  Anchor,
  Plus,
  Settings,
  Search,
  TerminalSquare,
  GitBranch,
  ChevronRight,
  Folder,
  ArrowLeft,
  X,
  Check,
  Copy,
  RotateCcw,
  MoreHorizontal,
  Command,
  Layers,
  Keyboard,
  SlidersHorizontal,
  Volume2,
  Bell,
  Compass,
  ArrowRight,
  LifeBuoy,
  Radio,
  Trash2,
  Ban,
  Zap,
} from "lucide-react";
import { rpc, desktop, listShells } from "./api";
import { TerminalView } from "./TerminalView";
import {
  commandDefinitions,
  displayKey,
  matches,
  mod,
  type CommandId,
} from "./commands";
import { themes, accents, accentHex } from "./themes";
import { playSound, soundNames } from "./sounds";
import type {
  Snapshot,
  Config,
  GitInfo,
  ShellOption,
  Pane,
  SoundName,
} from "./types";
/** Percent of the terminal area given to a divider line. */
const DIVIDER = 0.3;
const initial: Snapshot = {
  state: {
    workspaces: [],
    sessions: [],
    terminals: [],
    selectedWorkspace: null,
    selectedSession: null,
    selectedTerminal: null,
    workspaceSessions: {},
    sessionTerminals: {},
  },
  config: {
    theme: "Ocean",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 14,
    lineHeight: 1.25,
    scrollback: 5000,
    shell: "",
    keybindings: {},
    copyJoinWrapped: false,
    notifyEnabled: true,
    notifyOnBell: true,
    notifyAfterSeconds: 5,
    soundEnabled: false,
    soundName: "Chime",
    soundCooldownSeconds: 30,
    soundVolume: 50,
  },
  statuses: {},
  configPath: "",
  protocolVersion: 1,
};
type Dialog = {
  kind:
    | "workspace"
    | "session"
    | "rename"
    | "close"
    | "delete-workspace"
    | "delete-session";
  id?: string;
  entity?: string;
  name?: string;
  color?: string | null;
} | null;
export function App() {
  const [data, setData] = useState<Snapshot>(initial),
    [connection, setConnection] = useState<"connecting" | "online" | "offline">(
      "connecting",
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [settings, setSettings] = useState(false),
    [dialog, setDialog] = useState<Dialog>(null),
    [palette, setPalette] = useState(false),
    [query, setQuery] = useState(""),
    [paletteIndex, setPaletteIndex] = useState(0),
    [filter, setFilter] = useState(""),
    [menu, setMenu] = useState(false),
    [generations, setGenerations] = useState<Record<string, number>>({});
  const { state, config, statuses } = data;
  const workspace =
    state.workspaces.find((w) => w.id === state.selectedWorkspace) ??
    state.workspaces[0];
  const sessions = state.sessions.filter(
    (s) => s.workspaceId === workspace?.id,
  );
  const session =
    sessions.find((s) => s.id === state.selectedSession) ?? sessions[0];
  const terminals = state.terminals.filter((t) => t.sessionId === session?.id);
  const terminal =
    terminals.find((t) => t.id === state.selectedTerminal) ?? terminals[0];
  // A drag holds the tree locally so a gesture costs no round trips; the poll is paused
  // meanwhile, otherwise an incoming snapshot would snap the divider back mid-gesture.
  const [draft, setDraft] = useState<{ sessionId: string; root: Pane } | null>(
    null,
  );
  const dragging = useRef(false);
  const dragBase = useRef<Pane | null>(null);
  const dragRoot = useRef<Pane | null>(null);
  const root =
    (draft && session && draft.sessionId === session.id
      ? draft.root
      : session?.layout.root) ?? null;
  const geo = useMemo(() => geometry(root, DIVIDER), [root]);
  const tiled = geo.dividers.length > 0;
  const current = useRef({
    workspace,
    session,
    terminal,
    terminals,
    sessions,
    data,
  });
  current.current = { workspace, session, terminal, terminals, sessions, data };
  const refresh = useCallback(async () => {
    if (dragging.current) return;
    try {
      const next = await rpc({ op: "snapshot" });
      setData((prev) =>
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next,
      );
      setConnection("online");
    } catch (e) {
      setConnection("offline");
      setError(String(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [refresh]);
  const act = useCallback(async (op: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    try {
      const next = await rpc(op);
      setData(next);
      setConnection("online");
      return next;
    } catch (e) {
      setError(String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }, []);
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    const enter = () => setFocused(true),
      leave = () => setFocused(false);
    window.addEventListener("focus", enter);
    window.addEventListener("blur", leave);
    return () => {
      window.removeEventListener("focus", enter);
      window.removeEventListener("blur", leave);
    };
  }, []);
  // Each finished command is announced once. Watching it finish is not an interruption,
  // so the terminal in front of a focused window stays silent and clears itself.
  const announced = useRef<Record<string, number>>({});
  const lastSound = useRef(0);
  const watching = focused && !settings ? terminal?.id : undefined;
  useEffect(() => {
    let unseen = false;
    for (const t of data.state.terminals) {
      const at = data.statuses[t.id]?.attention?.at;
      if (!at) {
        delete announced.current[t.id];
        continue;
      }
      if (announced.current[t.id] === at) continue;
      announced.current[t.id] = at;
      if (t.id !== watching) unseen = true;
    }
    // One wait for the whole app: five terminals reporting at once, or one ringing in a
    // loop, is still a single sound.
    const elapsed = Date.now() - lastSound.current;
    if (
      unseen &&
      data.config.soundEnabled &&
      elapsed >= data.config.soundCooldownSeconds * 1000
    ) {
      lastSound.current = Date.now();
      playSound(data.config.soundName, data.config.soundVolume);
    }
  }, [data, watching]);
  useEffect(() => {
    if (!watching || !data.statuses[watching]?.attention) return;
    void rpc({ op: "acknowledge", id: watching })
      .then(setData)
      .catch(() => {
        /* The next snapshot carries it again. */
      });
  }, [data, watching]);
  const safe = (promise: Promise<unknown>) => void promise.catch(() => {});
  const select = useCallback((wid: string, sid?: string, tid?: string) => {
    const state = current.current.data.state;
    const selectedSession =
      sid ??
      state.workspaceSessions[wid] ??
      state.sessions.find((x) => x.workspaceId === wid)?.id;
    const selectedTerminal =
      tid ??
      state.terminals.find(
        (x) => x.id === state.sessionTerminals[selectedSession ?? ""],
      )?.id ??
      state.terminals.find((x) => x.sessionId === selectedSession)?.id;
    setData((d) => ({
      ...d,
      state: {
        ...d.state,
        selectedWorkspace: wid,
        selectedSession: selectedSession ?? null,
        selectedTerminal: selectedTerminal ?? null,
        workspaceSessions: selectedSession
          ? { ...d.state.workspaceSessions, [wid]: selectedSession }
          : d.state.workspaceSessions,
        sessionTerminals:
          selectedSession && selectedTerminal
            ? {
                ...d.state.sessionTerminals,
                [selectedSession]: selectedTerminal,
              }
            : d.state.sessionTerminals,
      },
    }));
    // The daemon repoints the pane showing the old terminal, so take its snapshot rather
    // than reimplementing that rule here.
    void rpc({
      op: "select",
      workspaceId: wid,
      sessionId: selectedSession ?? null,
      terminalId: selectedTerminal ?? null,
    })
      .then((next) => setData(next))
      .catch((e) => setError(String(e)));
    setSettings(false);
  }, []);
  const run = useCallback(
    (id: CommandId) => {
      const {
        workspace: w,
        session: s,
        terminal: t,
        terminals: ts,
        sessions: ss,
        data: d,
      } = current.current;
      setPalette(false);
      setMenu(false);
      switch (id) {
        case "palette":
          setQuery("");
          setPaletteIndex(0);
          setPalette(true);
          break;
        case "settings":
          setSettings((v) => !v);
          break;
        case "new-workspace":
          setDialog({ kind: "workspace" });
          break;
        case "delete-workspace":
          if (w)
            setDialog({ kind: "delete-workspace", id: w.id, name: w.name });
          break;
        case "delete-session":
          if (s) setDialog({ kind: "delete-session", id: s.id, name: s.name });
          break;
        case "new-session":
          setDialog({ kind: w ? "session" : "workspace" });
          break;
        case "quick-session": {
          if (!w) {
            setDialog({ kind: "workspace" });
            break;
          }
          setSettings(false);
          let name = "Quick session";
          for (let n = 2; ss.some((x) => x.name === name); n++)
            name = `Quick session ${n}`;
          void (async () => {
            const next = await act({
              op: "createSession",
              workspaceId: w.id,
              name,
            });
            const sid = next.state.selectedSession;
            if (sid) await act({ op: "createTerminal", sessionId: sid });
          })().catch(() => {});
          break;
        }
        case "new-terminal":
        case "duplicate-terminal":
          if (s)
            void act({
              op: "createTerminal",
              sessionId: s.id,
              name:
                id === "duplicate-terminal"
                  ? `${t?.name ?? "Shell"} copy`
                  : "Shell",
            }).catch(() => {});
          else setDialog({ kind: w ? "session" : "workspace" });
          break;
        case "split-right":
        case "split-down": {
          if (!s) break;
          if (!t) {
            setError("Open a terminal before splitting this session.");
            break;
          }
          const axis = id === "split-right" ? "row" : "column";
          const target = t.id;
          void (async () => {
            // A split always opens a new pane, so the focused one is halved rather than
            // paired with whichever other terminal happened to exist.
            const next = await act({
              op: "createTerminal",
              sessionId: s.id,
              name: "Shell",
            });
            const added = next.state.selectedTerminal;
            if (!added) return;
            const before: Pane = next.state.sessions.find((x) => x.id === s.id)
              ?.layout.root ?? { type: "leaf", terminalId: target };
            await act({
              op: "setLayoutTree",
              sessionId: s.id,
              root: splitLeaf(before, target, added, axis),
            });
          })().catch(() => {});
          break;
        }
        case "tabs-layout":
          if (s)
            void act({
              op: "setLayoutTree",
              sessionId: s.id,
              root: null,
            }).catch(() => {});
          break;
        case "close-terminal":
          if (t) setDialog({ kind: "close", id: t.id, name: t.name });
          break;
        case "rename-session":
          if (s)
            setDialog({
              kind: "rename",
              id: s.id,
              entity: "session",
              name: s.name,
            });
          break;
        case "rename-terminal":
          if (t)
            setDialog({
              kind: "rename",
              id: t.id,
              entity: "terminal",
              name: t.name,
              color: t.color,
            });
          break;
        case "restart-terminal":
          if (t)
            void act({ op: "restartTerminal", id: t.id })
              .then(() =>
                setGenerations((g) => ({ ...g, [t.id]: (g[t.id] ?? 0) + 1 })),
              )
              .catch(() => {});
          break;
        case "next-terminal":
        case "previous-terminal":
          if (ts.length && w && s) {
            const i = ts.findIndex((x) => x.id === t?.id);
            select(
              w.id,
              s.id,
              ts[(i + (id === "next-terminal" ? 1 : ts.length - 1)) % ts.length]
                .id,
            );
          }
          break;
        case "next-session":
          if (ss.length && w) {
            const i = ss.findIndex((x) => x.id === s?.id);
            select(w.id, ss[(i + 1) % ss.length].id);
          }
          break;
        case "next-workspace":
          if (d.state.workspaces.length) {
            const i = d.state.workspaces.findIndex((x) => x.id === w?.id);
            select(d.state.workspaces[(i + 1) % d.state.workspaces.length].id);
          }
          break;
      }
    },
    [act, select],
  );
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPalette(false);
        setDialog(null);
        setMenu(false);
        return;
      }
      if (dialog) return;
      const c = commandDefinitions.find((c) =>
        matches(e, config.keybindings[c.id] ?? c.key),
      );
      if (c) {
        e.preventDefault();
        run(c.id);
      } else if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        const t = terminals[+e.key - 1];
        if (t && workspace && session) {
          e.preventDefault();
          select(workspace.id, session.id, t.id);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [config, dialog, run, terminals, workspace, session, select]);
  useEffect(() => {
    if (!dialog && !palette) return;
    const previous = document.activeElement as HTMLElement | null;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const overlay = document.querySelector<HTMLElement>('[role="dialog"]');
      const items = [
        ...(overlay?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
        ) ?? []),
      ];
      const first = items[0],
        last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", trap);
    return () => {
      window.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, [dialog, palette]);
  useEffect(() => {
    if (!menu) return;
    const outside = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(".terminal-menu")) setMenu(false);
    };
    const items = () =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '.session-actions [role="menuitem"]',
        ),
      );
    items()[0]?.focus();
    const navigate = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        setMenu(false);
        return;
      }
      if (e.key === "Escape") {
        document
          .querySelector<HTMLButtonElement>(".terminal-menu > button")
          ?.focus();
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const all = items();
        const at = all.indexOf(document.activeElement as HTMLButtonElement);
        all[
          (at + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length
        ]?.focus();
      }
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", navigate);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", navigate);
    };
  }, [menu]);
  // A finished command is announced where it can be seen from: the tab, the session it
  // belongs to and the workspace holding it, even when none of them is on screen.
  const waiting = new Set(
    state.terminals.filter((t) => statuses[t.id]?.attention).map((t) => t.id),
  );
  const waitingSessions = new Set(
    state.terminals.filter((t) => waiting.has(t.id)).map((t) => t.sessionId),
  );
  const waitingWorkspaces = new Set(
    state.sessions
      .filter((s) => waitingSessions.has(s.id))
      .map((s) => s.workspaceId),
  );
  const theme = themes[config.theme] ?? themes.Ocean;
  const style = Object.fromEntries(
    Object.entries(theme).map(([k, v]) => [`--${k}`, v]),
  ) as CSSProperties;
  const commands = commandDefinitions.filter((c) =>
    c.label.toLowerCase().includes(query.toLowerCase()),
  );
  const running = Object.values(statuses).filter(
    (s) => s.state === "running",
  ).length;
  return (
    <div className="app" style={style}>
      <header className="topbar">
        <div className="brand">
          <Anchor size={22} strokeWidth={1.6} />
          <span>
            vessel<span className="brand-dot">.</span>
          </span>
        </div>
        <nav className="workspace-tabs" aria-label="Workspaces">
          {state.workspaces.map((w, i) => (
            <div
              key={w.id}
              className={`workspace-tab ${w.id === workspace?.id ? "selected" : ""}`}
            >
              <button
                onClick={() => select(w.id)}
                onDoubleClick={() =>
                  setDialog({
                    kind: "rename",
                    entity: "workspace",
                    id: w.id,
                    name: w.name,
                    color: w.color,
                  })
                }
              >
                <span
                  className="workspace-mark"
                  style={{ "--swatch": accentHex(w.color, i) } as CSSProperties}
                >
                  {w.name.slice(0, 1).toUpperCase()}
                </span>
                {w.name}
                {waitingWorkspaces.has(w.id) && (
                  <i
                    className="attention-dot"
                    aria-label={`A command finished in ${w.name}`}
                  />
                )}
              </button>
              <button
                className="tab-close"
                title="Delete workspace"
                aria-label={`Delete workspace ${w.name}`}
                onClick={() =>
                  setDialog({
                    kind: "delete-workspace",
                    id: w.id,
                    name: w.name,
                  })
                }
              >
                <X size={13} />
              </button>
            </div>
          ))}
          <button
            className="icon-button workspace-add"
            title="New workspace"
            aria-label="New workspace"
            onClick={() => run("new-workspace")}
          >
            <Plus size={16} />
          </button>
        </nav>
        <div className="header-actions">
          <button className="command-trigger" onClick={() => run("palette")}>
            <Search size={14} />
            <span>Find a command</span>
            <kbd>{mod} ⇧ P</kbd>
          </button>
          <span className="header-divider" />
          <button
            className={`icon-button ${settings ? "active" : ""}`}
            title="Settings"
            aria-label="Settings"
            onClick={() => run("settings")}
          >
            <Settings size={18} />
          </button>
        </div>
      </header>
      <div className="app-body">
        <aside className="sidebar">
          <div className="workspace-heading">
            <div>
              <span className="eyebrow">WORKSPACE</span>
              <h2>{workspace?.name ?? "Your space"}</h2>
            </div>
            <span className="workspace-count">
              {sessions.length.toString().padStart(2, "0")}
            </span>
          </div>
          <div className="section-heading">
            <span>SESSIONS</span>
            <button
              className="icon-button small"
              title="Quick session in your home directory"
              aria-label="Quick session"
              disabled={busy}
              onClick={() => run("quick-session")}
            >
              <Zap size={15} />
            </button>
            <button
              className="icon-button small"
              title="New session"
              aria-label="New session"
              onClick={() => run("new-session")}
            >
              <Plus size={16} />
            </button>
          </div>
          {sessions.length > 5 && (
            <div className="session-search">
              <Search size={13} />
              <input
                placeholder="Filter sessions…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
          )}
          <nav className="session-list" aria-label="Sessions">
            {sessions
              .filter((s) =>
                s.name.toLowerCase().includes(filter.toLowerCase()),
              )
              .map((s) => {
                const ts = state.terminals.filter((t) => t.sessionId === s.id);
                const alive = ts.some(
                  (t) => statuses[t.id]?.state === "running",
                );
                return (
                  <div
                    key={s.id}
                    className={`session-item ${session?.id === s.id ? "selected" : ""}`}
                  >
                    <button
                      onClick={() => select(workspace!.id, s.id)}
                      onDoubleClick={() =>
                        setDialog({
                          kind: "rename",
                          entity: "session",
                          id: s.id,
                          name: s.name,
                        })
                      }
                    >
                      <div className="session-title">
                        <Layers size={15} />
                        <span>{s.name}</span>
                        <span className={`status-dot ${alive ? "live" : ""}`} />
                        {waitingSessions.has(s.id) && (
                          <i
                            className="attention-dot"
                            aria-label={`A command finished in ${s.name}`}
                          />
                        )}
                      </div>
                      <div className="session-meta">
                        {s.branch ? (
                          <>
                            <GitBranch size={11} />
                            <span>{s.branch}</span>
                          </>
                        ) : (
                          <>
                            <Folder size={11} />
                            <span>Local session</span>
                          </>
                        )}
                        <span className="terminal-count">{ts.length}</span>
                      </div>
                    </button>
                    <button
                      className="tab-close"
                      title="Delete session"
                      aria-label={`Delete session ${s.name}`}
                      onClick={() =>
                        setDialog({
                          kind: "delete-session",
                          id: s.id,
                          name: s.name,
                        })
                      }
                    >
                      <X size={13} />
                    </button>
                  </div>
                );
              })}
            {!sessions.length && (
              <div className="sidebar-empty">
                A little space for
                <br />
                your next big thing.
              </div>
            )}
            <button className="new-session" onClick={() => run("new-session")}>
              <Plus size={15} />
              New session<kbd>{mod} N</kbd>
            </button>
          </nav>
          <div className="sidebar-bottom">
            {session && (
              <div className="context-details">
                <span className="eyebrow">WORKING DIRECTORY</span>
                <div title={session.cwd}>
                  <Folder size={13} />
                  <span>
                    {session.cwd
                      .split(/[\\/]/)
                      .filter(Boolean)
                      .slice(-2)
                      .join("/")}
                  </span>
                </div>
                {session.worktree && <small>Git worktree</small>}
              </div>
            )}
            <div className="daemon-note">
              <Radio size={15} />
              <div>
                <strong>
                  {connection === "online"
                    ? "Your processes stay aboard"
                    : connection === "connecting"
                      ? "Connecting to Vessel"
                      : "Desktop connection required"}
                </strong>
                <span>
                  {connection === "online"
                    ? "Safe to close the window."
                    : "Local. Private. On your machine."}
                </span>
              </div>
            </div>
            <div className="sidebar-foot">
              <span>
                VESSEL <b>0.1</b>
              </span>
              <button
                className="icon-button small"
                aria-label="Open command palette"
                title="Command palette"
                onClick={() => run("palette")}
              >
                <LifeBuoy size={15} />
              </button>
            </div>
          </div>
        </aside>
        <main className="main">
          {settings && (
            <SettingsView
              config={config}
              path={data.configPath}
              save={(c) => act({ op: "configure", config: c })}
              close={() => setSettings(false)}
            />
          )}
          <div className={`session-surface ${settings ? "hidden" : ""}`}>
            {session ? (
              <>
                <div
                  className="terminal-tabs"
                  role="tablist"
                  aria-label="Terminals"
                >
                  {terminals.map((t, i) => (
                    <div
                      key={t.id}
                      className={`terminal-tab ${terminal?.id === t.id ? "selected" : ""}`}
                      style={
                        t.color
                          ? ({
                              "--swatch": accentHex(t.color),
                            } as CSSProperties)
                          : undefined
                      }
                      draggable
                      onDragStart={(e) =>
                        e.dataTransfer.setData("text/plain", t.id)
                      }
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        const source = e.dataTransfer.getData("text/plain");
                        if (!terminals.some((t) => t.id === source)) return;
                        const ids = terminals
                          .map((t) => t.id)
                          .filter((id) => id !== source);
                        ids.splice(i, 0, source);
                        safe(
                          act({
                            op: "reorderTerminals",
                            sessionId: session.id,
                            ids,
                          }),
                        );
                      }}
                    >
                      <button
                        role="tab"
                        aria-selected={terminal?.id === t.id}
                        onClick={() => select(workspace!.id, session.id, t.id)}
                        onDoubleClick={() =>
                          setDialog({
                            kind: "rename",
                            entity: "terminal",
                            id: t.id,
                            name: t.name,
                            color: t.color,
                          })
                        }
                      >
                        <TerminalSquare size={14} />
                        <span>{t.name}</span>
                        <span
                          className={`status-dot ${statuses[t.id]?.state === "running" ? "live" : ""}`}
                        />
                        {waiting.has(t.id) && (
                          <i
                            className="attention-dot"
                            title={
                              statuses[t.id]?.attention?.kind === "bell"
                                ? "Asked for your attention"
                                : `Finished after ${statuses[t.id]?.attention?.seconds}s`
                            }
                            aria-label={`A command finished in ${t.name}`}
                          />
                        )}
                        <kbd>{i < 9 ? i + 1 : ""}</kbd>
                      </button>
                      <button
                        className="tab-close"
                        aria-label={`Close ${t.name}`}
                        onClick={() =>
                          setDialog({ kind: "close", id: t.id, name: t.name })
                        }
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                  <button
                    className="icon-button"
                    title="New terminal"
                    aria-label="New terminal"
                    disabled={busy}
                    onClick={() => run("new-terminal")}
                  >
                    <Plus size={16} />
                  </button>
                  <div className="tab-spacer" />
                  <div className="terminal-menu">
                    <button
                      className="icon-button"
                      aria-label="Session and terminal actions"
                      title="Session and terminal actions"
                      aria-expanded={menu}
                      aria-haspopup="menu"
                      onClick={() => setMenu(!menu)}
                    >
                      <MoreHorizontal size={18} />
                    </button>
                    {menu && (
                      <div
                        className="dropdown session-actions"
                        role="menu"
                        aria-label="Session and terminal actions"
                      >
                        <div className="menu-context">
                          <strong>{session.name}</strong>
                          <span>
                            <GitBranch size={12} />
                            {session.branch ?? "No Git repository"}
                          </span>
                          <small title={session.cwd}>{session.cwd}</small>
                        </div>
                        <button
                          role="menuitem"
                          onClick={() => run("split-right")}
                        >
                          Split right
                        </button>
                        <button
                          role="menuitem"
                          onClick={() => run("split-down")}
                        >
                          Split down
                        </button>
                        {tiled && (
                          <button
                            role="menuitem"
                            onClick={() => run("tabs-layout")}
                          >
                            Show as tabs
                          </button>
                        )}
                        <div className="menu-separator" />
                        <button
                          role="menuitem"
                          onClick={() => run("rename-session")}
                        >
                          <Layers size={13} />
                          Rename session
                        </button>
                        <button
                          role="menuitem"
                          onClick={() => run("delete-session")}
                        >
                          <Trash2 size={13} />
                          Delete session
                        </button>
                        <button
                          role="menuitem"
                          onClick={() => run("new-terminal")}
                        >
                          <Plus size={13} />
                          New terminal
                        </button>
                        {terminal && (
                          <>
                            <div className="menu-separator" />
                            <button
                              role="menuitem"
                              onClick={() => run("rename-terminal")}
                            >
                              Rename terminal
                            </button>
                            <button
                              role="menuitem"
                              onClick={() => run("duplicate-terminal")}
                            >
                              <Copy size={13} />
                              Duplicate terminal
                            </button>
                            <button
                              role="menuitem"
                              onClick={() => run("restart-terminal")}
                            >
                              <RotateCcw size={13} />
                              Restart terminal
                            </button>
                            <button
                              role="menuitem"
                              onClick={() => run("close-terminal")}
                            >
                              <X size={13} />
                              Close terminal
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <div className={`terminal-area ${tiled ? "tiled" : ""}`}>
                  {terminals.map((t) => {
                    const rect = tiled ? geo.panes[t.id] : undefined;
                    const visible = tiled ? !!rect : t.id === terminal?.id;
                    if (!visible)
                      return statuses[t.id]?.state !== "stopped" ? (
                        <TerminalView
                          key={t.id}
                          id={t.id}
                          name={t.name}
                          visible={false}
                          active={false}
                          onFocus={() => {}}
                          config={config}
                          generation={generations[t.id] ?? 0}
                        />
                      ) : null;
                    if (statuses[t.id]?.state === "stopped")
                      return (
                        <div
                          key={t.id}
                          className="split-stopped"
                          style={
                            rect && {
                              left: `${rect.left}%`,
                              top: `${rect.top}%`,
                              width: `${rect.width}%`,
                              height: `${rect.height}%`,
                            }
                          }
                        >
                          <TerminalSquare size={25} />
                          <strong>{t.name}</strong>
                          <span>Saved terminal · process stopped</span>
                          <button
                            className="primary"
                            onClick={() => {
                              select(workspace!.id, session.id, t.id);
                              void act({ op: "restartTerminal", id: t.id })
                                .then(() =>
                                  setGenerations((g) => ({
                                    ...g,
                                    [t.id]: (g[t.id] ?? 0) + 1,
                                  })),
                                )
                                .catch(() => {});
                            }}
                          >
                            Start terminal
                          </button>
                        </div>
                      );
                    return (
                      <TerminalView
                        key={t.id}
                        id={t.id}
                        name={t.name}
                        visible={visible}
                        active={!settings && t.id === terminal?.id}
                        onFocus={() => {
                          if (terminal?.id !== t.id)
                            select(workspace!.id, session.id, t.id);
                        }}
                        config={config}
                        generation={generations[t.id] ?? 0}
                        rect={rect}
                        accent={t.color ? accentHex(t.color) : undefined}
                      />
                    );
                  })}
                  {tiled &&
                    geo.dividers.map((d) => (
                      <PaneDivider
                        key={`${d.path.join(".")}:${d.index}`}
                        divider={d}
                        onStart={() => {
                          dragging.current = true;
                          dragBase.current = root;
                        }}
                        onDrag={(fraction) => {
                          const base = dragBase.current;
                          if (!base) return;
                          const next = resizeAt(
                            base,
                            d.path,
                            d.index,
                            fraction,
                          );
                          dragRoot.current = next;
                          setDraft({ sessionId: session.id, root: next });
                        }}
                        onCommit={() => {
                          dragging.current = false;
                          const settled = dragRoot.current;
                          const base = dragBase.current;
                          dragBase.current = null;
                          dragRoot.current = null;
                          setDraft(null);
                          // A click that never moved must not cost a write.
                          if (
                            settled &&
                            JSON.stringify(settled) !== JSON.stringify(base)
                          )
                            safe(
                              act({
                                op: "setLayoutTree",
                                sessionId: session.id,
                                root: settled,
                              }),
                            );
                        }}
                      />
                    ))}
                  {terminal && statuses[terminal.id]?.state === "exited" && (
                    <div className="exit-banner">
                      Process exited with code{" "}
                      {statuses[terminal.id].exitCode ?? 0}
                      <button onClick={() => run("restart-terminal")}>
                        <RotateCcw size={13} />
                        Restart
                      </button>
                    </div>
                  )}
                  {!terminal && (
                    <div className="empty-state compact">
                      <TerminalSquare size={34} />
                      <h2>A clear deck.</h2>
                      <p>Open a terminal to start working in {session.name}.</p>
                      <button
                        className="primary"
                        onClick={() => run("new-terminal")}
                      >
                        <Plus size={15} />
                        Open terminal<kbd>{mod} T</kbd>
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="welcome">
                <div className="welcome-art">
                  <div className="orbit orbit-one" />
                  <div className="orbit orbit-two" />
                  <div className="orbit orbit-three" />
                  <div className="compass-point north">N</div>
                  <div className="welcome-anchor">
                    <Anchor size={48} strokeWidth={1.15} />
                  </div>
                  <span className="orbit-dot" />
                </div>
                <span className="eyebrow">A HOME PORT FOR YOUR WORK</span>
                <h1>
                  Less switching.
                  <br />
                  <span>More making.</span>
                </h1>
                <p>
                  Your projects, shells, and coding agents.
                  <br />
                  Together in one calm, persistent workspace.
                </p>
                <button
                  className="primary"
                  disabled={connection !== "online"}
                  onClick={() =>
                    run(workspace ? "new-session" : "new-workspace")
                  }
                >
                  {workspace
                    ? "Create your first session"
                    : "Create a workspace"}
                  <ArrowRight size={16} />
                </button>
                <div className="welcome-steps">
                  <div>
                    <span>01</span>
                    <strong>Choose a context</strong>
                    <small>A company, client, or personal space.</small>
                  </div>
                  <div>
                    <span>02</span>
                    <strong>Start a session</strong>
                    <small>A repository, worktree, or directory.</small>
                  </div>
                  <div>
                    <span>03</span>
                    <strong>Stay in flow</strong>
                    <small>Real terminals. Ready when you are.</small>
                  </div>
                </div>
                {!desktop && (
                  <div className="desktop-hint">
                    <TerminalSquare size={16} />
                    <span>
                      This is the desktop UI preview. Run{" "}
                      <code>npm run desktop</code> to use real terminals.
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </main>
      </div>
      <footer className="statusbar">
        <div>
          <span
            className={`status-dot ${connection === "online" ? "live" : ""}`}
          />
          <span>
            {connection === "online"
              ? "Local daemon connected"
              : connection === "connecting"
                ? "Connecting…"
                : "Offline"}
          </span>
          <span className="status-separator" />
          {session?.branch && (
            <>
              <GitBranch size={12} />
              <span>{session.branch}</span>
            </>
          )}
        </div>
        <div>
          <span>
            {running} {running === 1 ? "process" : "processes"} running
          </span>
          <span className="status-separator" />
          <span>{config.theme}</span>
          <button onClick={() => run("palette")}>
            <Command size={12} />
            <span>Commands</span>
          </button>
        </div>
      </footer>
      {error && desktop && (
        <div role="alert" className="error-toast">
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            <X size={15} />
          </button>
        </div>
      )}
      {dialog && (
        <DialogView
          dialog={dialog}
          workspaceId={workspace?.id}
          busy={busy}
          close={() => setDialog(null)}
          submit={async (ops) => {
            for (const op of ops) await act(op);
            setDialog(null);
          }}
        />
      )}
      {palette && (
        <div
          className="overlay palette-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPalette(false);
          }}
        >
          <div
            className="palette"
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
          >
            <div className="palette-input">
              <ChevronRight size={20} />
              <input
                autoFocus
                placeholder="What would you like to do?"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPaletteIndex(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setPaletteIndex((i) =>
                      Math.min(i + 1, commands.length - 1),
                    );
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setPaletteIndex((i) => Math.max(i - 1, 0));
                  }
                  if (e.key === "Enter" && commands[paletteIndex])
                    run(commands[paletteIndex].id);
                }}
              />
              <kbd>esc</kbd>
            </div>
            <div className="palette-results">
              <span className="eyebrow">COMMANDS</span>
              {commands.map((c, i) => (
                <button
                  className={i === paletteIndex ? "selected" : ""}
                  key={c.id}
                  onMouseMove={() => setPaletteIndex(i)}
                  onClick={() => run(c.id)}
                >
                  <Command size={15} />
                  <div>
                    <strong>{c.label}</strong>
                    <small>{c.hint}</small>
                  </div>
                  <kbd>{displayKey(config.keybindings[c.id] ?? c.key)}</kbd>
                </button>
              ))}
              {!commands.length && <p>No matching commands.</p>}
            </div>
            <div className="palette-footer">
              <span>↑ ↓ to navigate</span>
              <span>↵ to select</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
function DialogView({
  dialog,
  workspaceId,
  busy,
  close,
  submit,
}: {
  dialog: NonNullable<Dialog>;
  workspaceId?: string;
  busy: boolean;
  close: () => void;
  submit: (ops: Record<string, unknown>[]) => Promise<void>;
}) {
  const colorable =
    dialog.kind === "rename" &&
    (dialog.entity === "workspace" || dialog.entity === "terminal");
  const destructive =
    dialog.kind === "close" ||
    dialog.kind === "delete-workspace" ||
    dialog.kind === "delete-session";
  const [color, setColor] = useState(dialog.color ?? null);
  const [name, setName] = useState(dialog.name ?? ""),
    [path, setPath] = useState(""),
    [mode, setMode] = useState("none"),
    [branch, setBranch] = useState(""),
    [worktree, setWorktree] = useState(""),
    [newBranch, setNewBranch] = useState(true),
    [git, setGit] = useState<GitInfo | null>(null),
    [error, setError] = useState(""),
    [checking, setChecking] = useState(true),
    [resolvedPath, setResolvedPath] = useState(""),
    [pathError, setPathError] = useState("");
  const title =
    dialog.kind === "workspace"
      ? "A space for your work."
      : dialog.kind === "session"
        ? "Start a new session."
        : dialog.kind === "close"
          ? "Close this terminal?"
          : dialog.kind === "delete-workspace"
            ? "Delete this workspace?"
            : dialog.kind === "delete-session"
              ? "Delete this session?"
              : colorable
                ? `Name and color`
                : `Rename ${dialog.entity}`;
  useEffect(() => {
    if (dialog.kind !== "session") return;
    let cancelled = false;
    setChecking(true);
    setGit(null);
    setResolvedPath("");
    setPathError("");
    const timer = setTimeout(() => {
      void rpc<{ path: string; git: GitInfo | null }>({
        op: "inspectDirectory",
        path,
      })
        .then((info) => {
          if (!cancelled) {
            setGit(info.git);
            setResolvedPath(info.path);
          }
        })
        .catch(() => {
          if (!cancelled)
            setPathError(
              "Choose an existing directory, or complete a path from the suggestions.",
            );
        })
        .finally(() => {
          if (!cancelled) setChecking(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path, dialog.kind]);
  function changePath(value: string) {
    setPath(value);
    setMode("none");
    setWorktree("");
    setBranch("");
    setResolvedPath("");
    setGit(null);
    setChecking(true);
  }
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (
      busy ||
      (dialog.kind === "session" && (checking || !resolvedPath || pathError))
    )
      return;
    setError("");
    try {
      const ops: Record<string, unknown>[] =
        dialog.kind === "workspace"
          ? [{ op: "createWorkspace", name }]
          : dialog.kind === "rename"
            ? [{ op: "rename", id: dialog.id, kind: dialog.entity, name }]
            : dialog.kind === "close"
              ? [{ op: "closeTerminal", id: dialog.id }]
              : dialog.kind === "delete-workspace"
                ? [{ op: "deleteWorkspace", id: dialog.id }]
                : dialog.kind === "delete-session"
                  ? [{ op: "deleteSession", id: dialog.id }]
                  : [
                      {
                        op: "createSession",
                        workspaceId,
                        name,
                        path,
                        mode,
                        branch,
                        worktreePath: worktree,
                        newBranch,
                      },
                    ];
      if (colorable && color !== (dialog.color ?? null))
        ops.push({ op: "setColor", id: dialog.id, kind: dialog.entity, color });
      await submit(ops);
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
    >
      <form
        className={`dialog ${dialog.kind === "session" ? "session-dialog" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onSubmit={onSubmit}
      >
        <div className="dialog-heading">
          <div className="dialog-icon">
            {dialog.kind === "workspace" ? (
              <Compass size={22} />
            ) : dialog.kind === "delete-workspace" ||
              dialog.kind === "delete-session" ? (
              <Trash2 size={22} />
            ) : (
              <Layers size={22} />
            )}
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close dialog"
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>
        <h2 id="dialog-title">{title}</h2>
        <p>
          {dialog.kind === "workspace"
            ? "Keep each company, client, or personal project in its own context."
            : dialog.kind === "session"
              ? "Bring the terminals for one task together."
              : dialog.kind === "close"
                ? `This ends the process in “${dialog.name}”. Closing the window instead keeps it running.`
                : dialog.kind === "delete-workspace"
                  ? `This removes “${dialog.name}”, every session inside it, and ends their running terminals. Repositories and worktrees on disk are left untouched.`
                  : dialog.kind === "delete-session"
                    ? `This removes “${dialog.name}” and ends every terminal running in it. The repository and any worktree on disk are left untouched.`
                    : colorable
                      ? `A familiar name and a color make this ${dialog.entity} easy to pick out at a glance.`
                      : "A familiar name makes it easier to find your way back."}
        </p>
        {!destructive && (
          <label>
            Name
            <input
              autoFocus
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={
                dialog.kind === "workspace"
                  ? "e.g. Personal"
                  : "e.g. Billing refactor"
              }
            />
          </label>
        )}
        {colorable && (
          <fieldset className="color-picker">
            <legend>Color</legend>
            <div className="color-options">
              <button
                type="button"
                className={`color-swatch ${color === null ? "selected" : ""}`}
                title="Default"
                aria-label="Default color"
                aria-pressed={color === null}
                onClick={() => setColor(null)}
              >
                <Ban size={14} />
              </button>
              {accents.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`color-swatch ${color === a.id ? "selected" : ""}`}
                  style={{ "--swatch": a.hex } as CSSProperties}
                  title={a.label}
                  aria-label={a.label}
                  aria-pressed={color === a.id}
                  onClick={() => setColor(a.id)}
                >
                  {color === a.id && <Check size={14} />}
                </button>
              ))}
            </div>
          </fieldset>
        )}
        {dialog.kind === "session" && (
          <>
            <DirectoryField
              label="Repository or directory"
              value={path}
              onChange={changePath}
              placeholder="~/code/project · leave empty for home"
            />
            <div
              className={`directory-status ${pathError ? "invalid" : ""}`}
              role="status"
            >
              {checking ? (
                <span>Checking directory…</span>
              ) : pathError ? (
                <span>{pathError}</span>
              ) : git ? (
                <>
                  <GitBranch size={13} />
                  <span>{git.branch}</span>
                  <span className="status-detail">
                    {git.worktrees.length}{" "}
                    {git.worktrees.length === 1 ? "worktree" : "worktrees"}{" "}
                    available
                  </span>
                </>
              ) : (
                <>
                  <Folder size={13} />
                  <span>Local directory</span>
                  <span className="status-detail">Git optional</span>
                </>
              )}
            </div>
            <fieldset className="directory-modes">
              <legend>Working directory</legend>
              <div className="directory-mode-options">
                {[
                  {
                    id: "none",
                    title: "Use directory",
                    detail: "Work here",
                    icon: Folder,
                  },
                  {
                    id: "create",
                    title: "New worktree",
                    detail: "Isolate a task",
                    icon: Plus,
                  },
                  {
                    id: "existing",
                    title: "Existing worktree",
                    detail: "Pick up work",
                    icon: GitBranch,
                  },
                ].map(({ id, title, detail, icon: Icon }) => (
                  <label
                    key={id}
                    className={`directory-mode ${mode === id ? "selected" : ""} ${id !== "none" && !git ? "unavailable" : ""}`}
                  >
                    <input
                      type="radio"
                      name="directory-mode"
                      value={id}
                      checked={mode === id}
                      disabled={id !== "none" && !git}
                      onChange={() => {
                        setMode(id);
                        setWorktree("");
                        setBranch("");
                      }}
                    />
                    <Icon size={17} />
                    <strong>{title}</strong>
                    <small>{detail}</small>
                    {mode === id && <Check className="mode-check" size={12} />}
                  </label>
                ))}
              </div>
            </fieldset>
            {mode === "none" && (
              <div className="directory-summary">
                <Folder size={14} />
                <div>
                  <strong>
                    {git
                      ? "Work in the repository directly"
                      : "Use this directory for your terminals"}
                  </strong>
                  <span title={resolvedPath}>
                    {resolvedPath || "Select a directory above"}
                  </span>
                </div>
              </div>
            )}
            {!git && !checking && !pathError && (
              <p className="picker-help">
                Choose a Git repository to create or attach a worktree.
              </p>
            )}
            {mode === "create" && (
              <div className="worktree-details">
                <div
                  className="branch-choice"
                  role="group"
                  aria-label="Branch type"
                >
                  <button
                    type="button"
                    aria-pressed={newBranch}
                    className={newBranch ? "selected" : ""}
                    onClick={() => {
                      setNewBranch(true);
                      setBranch("");
                    }}
                  >
                    New branch
                  </button>
                  <button
                    type="button"
                    aria-pressed={!newBranch}
                    className={!newBranch ? "selected" : ""}
                    onClick={() => {
                      setNewBranch(false);
                      setBranch("");
                    }}
                  >
                    Existing branch
                  </button>
                </div>
                <label>
                  Branch
                  {newBranch ? (
                    <input
                      required
                      placeholder="feature/billing"
                      value={branch}
                      onChange={(e) => setBranch(e.target.value)}
                    />
                  ) : (
                    <Select
                      required
                      value={branch}
                      onChange={(e) => setBranch(e.target.value)}
                    >
                      <option value="">Choose a branch…</option>
                      {git?.branches.map((b) => (
                        <option key={b}>{b}</option>
                      ))}
                    </Select>
                  )}
                </label>
                <DirectoryField
                  label="New worktree location"
                  required
                  value={worktree}
                  onChange={setWorktree}
                  placeholder="Absolute path to a new directory"
                />
                <p className="picker-help">
                  Git will create this directory. Your repository stays in
                  place.
                </p>
              </div>
            )}
            {mode === "existing" && (
              <fieldset className="worktree-list">
                <legend>Choose a worktree</legend>
                {git?.worktrees.map((w) => (
                  <label
                    className={`worktree-option ${worktree === w.path ? "selected" : ""}`}
                    key={w.path}
                  >
                    <input
                      type="radio"
                      name="worktree"
                      required
                      checked={worktree === w.path}
                      onChange={() => setWorktree(w.path)}
                    />
                    <GitBranch size={15} />
                    <div>
                      <strong>{w.branch ?? "Detached HEAD"}</strong>
                      <span>{w.path}</span>
                    </div>
                    {worktree === w.path && <Check size={14} />}
                  </label>
                ))}
              </fieldset>
            )}
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-footer">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button
            className={destructive ? "danger" : "primary"}
            disabled={
              busy ||
              (dialog.kind === "session" &&
                (checking || !resolvedPath || !!pathError))
            }
          >
            {busy
              ? "Working…"
              : dialog.kind === "close"
                ? "Close terminal"
                : dialog.kind === "delete-workspace"
                  ? "Delete workspace"
                  : dialog.kind === "delete-session"
                    ? "Delete session"
                    : dialog.kind === "rename"
                      ? "Save"
                      : dialog.kind === "workspace"
                        ? "Create workspace"
                        : "Create session"}
            {!destructive && <ArrowRight size={14} />}
          </button>
        </div>
      </form>
    </div>
  );
}
const settingsSections = [
  ["Appearance", Compass],
  ["Terminal", TerminalSquare],
  ["Shortcuts", Keyboard],
  ["Shell", Command],
  ["Sounds", Volume2],
  ["Notifications", Bell],
  ["Advanced", SlidersHorizontal],
] as const;
function SettingsView({
  config,
  path,
  save,
  close,
}: {
  config: Config;
  path: string;
  save: (c: Config) => Promise<unknown>;
  close: () => void;
}) {
  const [section, setSection] = useState("Appearance"),
    [draft, setDraft] = useState(config),
    [message, setMessage] = useState(""),
    [saving, setSaving] = useState(false),
    [shellOptions, setShellOptions] = useState<ShellOption[]>([]),
    [shellLoading, setShellLoading] = useState(true);
  useEffect(() => setDraft(config), [config]);
  useEffect(() => {
    let live = true;
    void listShells(config.shell)
      .then((options) => {
        if (live) setShellOptions(options);
      })
      .catch((e) => {
        if (live) setMessage(String(e));
      })
      .finally(() => {
        if (live) setShellLoading(false);
      });
    return () => {
      live = false;
    };
  }, [config.shell]);
  const update = <K extends keyof Config>(key: K, value: Config[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  async function persist() {
    setSaving(true);
    try {
      await save(draft);
      setMessage("Settings saved");
    } catch (e) {
      setMessage(String(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="settings-view">
      <div className="settings-header">
        <button
          className="icon-button"
          aria-label="Back to terminal"
          onClick={close}
        >
          <ArrowLeft size={18} />
        </button>
        <h2>Settings</h2>
        <span>Make yourself at home.</span>
      </div>
      <div className="settings-layout">
        <nav aria-label="Settings categories">
          {settingsSections.map(([name, Icon]) => (
            <button
              key={name}
              className={section === name ? "selected" : ""}
              onClick={() => {
                setSection(name);
                setMessage("");
              }}
            >
              <Icon size={16} />
              {name}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          <div className="settings-title">
            <span className="eyebrow">PREFERENCES</span>
            <h1>{section}</h1>
            <p>
              {section === "Appearance"
                ? "A familiar space, in your own colors."
                : section === "Terminal"
                  ? "Comfortable for the long run."
                  : section === "Shortcuts"
                    ? "Keep your hands on the keyboard."
                    : section === "Sounds"
                      ? "Quiet by default, audible when it matters."
                      : section === "Notifications"
                        ? "Know when something finished without watching it."
                        : "Your local development environment."}
            </p>
          </div>
          {section === "Appearance" && (
            <>
              <h3>Color theme</h3>
              <div className="theme-grid">
                {Object.entries(themes).map(([name, t]) => (
                  <button
                    key={name}
                    className={`theme-card ${draft.theme === name ? "selected" : ""}`}
                    onClick={() => update("theme", name)}
                  >
                    <div
                      className="theme-preview"
                      style={{ background: t.bg, color: t.accent }}
                    >
                      <div
                        className="mini-sidebar"
                        style={{ background: t.panel }}
                      />
                      <div className="mini-code">
                        <span style={{ width: "65%", background: t.accent }} />
                        <span style={{ width: "85%", background: t.muted }} />
                        <span style={{ width: "45%", background: t.text }} />
                        <span style={{ width: "60%", background: t.muted }} />
                      </div>
                      <div className="color-dots">
                        {[t.accent, "#df8e91", "#dfc58e", "#8eb4da"].map(
                          (c) => (
                            <i key={c} style={{ background: c }} />
                          ),
                        )}
                      </div>
                    </div>
                    <div className="theme-label">
                      {name}
                      {draft.theme === name && <Check size={14} />}
                    </div>
                  </button>
                ))}
              </div>
              <p className="settings-help">
                One palette for your workspace and terminal.
              </p>
            </>
          )}
          {section === "Terminal" && (
            <>
              <label>
                Font family
                <input
                  value={draft.fontFamily}
                  onChange={(e) => update("fontFamily", e.target.value)}
                />
              </label>
              <div className="settings-columns">
                <label>
                  Font size
                  <input
                    type="number"
                    min={9}
                    max={32}
                    value={draft.fontSize}
                    onChange={(e) => update("fontSize", +e.target.value)}
                  />
                </label>
                <label>
                  Line height
                  <input
                    type="number"
                    min={1}
                    max={2}
                    step={0.05}
                    value={draft.lineHeight}
                    onChange={(e) => update("lineHeight", +e.target.value)}
                  />
                </label>
              </div>
              <label>
                Scrollback lines
                <input
                  type="number"
                  min={0}
                  max={50000}
                  step={1000}
                  value={draft.scrollback}
                  onChange={(e) => update("scrollback", +e.target.value)}
                />
              </label>
              <p className="settings-help">
                Each terminal keeps bounded history. Output is never saved to
                disk.
              </p>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={draft.copyJoinWrapped}
                  onChange={(e) => update("copyJoinWrapped", e.target.checked)}
                />
                Copy wrapped rows as whole lines
              </label>
              <p className="settings-help">
                A program that wraps its own output, as Claude Code and Codex
                do, hands the terminal one row per line, and nothing in the
                stream says which breaks it meant. With this on, copying rejoins
                the rows the next word could not have fitted on and leaves
                lists, quotes, headings and anything short enough to have ended
                on its own alone.
              </p>
              <div
                className="font-preview"
                style={{
                  fontFamily: draft.fontFamily,
                  fontSize: draft.fontSize,
                  lineHeight: draft.lineHeight,
                }}
              >
                The quick brown fox jumps over the lazy dog.
                <br />
                <span>0123456789 {"{} [] () => !="}</span>
              </div>
            </>
          )}
          {section === "Shortcuts" && (
            <>
              <p className="settings-help">
                Use Mod for {mod}, plus Shift or Alt. Example: Mod+Shift+T
              </p>
              {commandDefinitions.map((c) => (
                <label className="shortcut-row" key={c.id}>
                  <span>{c.label}</span>
                  <input
                    aria-label={c.label}
                    value={draft.keybindings[c.id] ?? c.key}
                    onChange={(e) =>
                      update("keybindings", {
                        ...draft.keybindings,
                        [c.id]: e.target.value,
                      })
                    }
                  />
                </label>
              ))}
            </>
          )}
          {section === "Shell" && (
            <>
              <label>
                Shell for new terminals
                <Select
                  aria-label="Shell for new terminals"
                  value={
                    draft.shell &&
                    shellOptions.some((shell) => shell.path === draft.shell)
                      ? draft.shell
                      : draft.shell
                        ? "__custom__"
                        : ""
                  }
                  onChange={(e) => {
                    const selected = e.target.value;
                    if (selected === "__custom__") {
                      if (
                        !draft.shell ||
                        shellOptions.some((shell) => shell.path === draft.shell)
                      )
                        update("shell", "");
                    } else update("shell", selected);
                  }}
                >
                  {shellOptions.map((shell) => (
                    <option key={shell.path || "default"} value={shell.path}>
                      {shell.label}
                      {shell.path ? ` · ${shell.path}` : ""}
                    </option>
                  ))}
                  <option value="__custom__">Custom executable path…</option>
                </Select>
              </label>
              {draft.shell &&
                !shellOptions.some((shell) => shell.path === draft.shell) && (
                  <label>
                    Custom shell path
                    <input
                      aria-label="Custom shell path"
                      autoFocus
                      placeholder="/path/to/zsh"
                      value={draft.shell}
                      onChange={(e) => update("shell", e.target.value)}
                    />
                  </label>
                )}
              {draft.shell &&
                shellOptions.some((shell) => shell.path === draft.shell) && (
                  <p className="shell-path">{draft.shell}</p>
                )}
              <p className="settings-help">
                System default follows $SHELL on macOS/Linux and %COMSPEC% on
                Windows. The choice applies to new terminals. Start Claude Code
                or other tools as commands inside your shell.
              </p>
              {shellLoading && (
                <p className="settings-help">Finding installed shells…</p>
              )}
              <div className="settings-note">
                <Layers size={18} />
                <div>
                  <strong>Your environment stays familiar</strong>
                  <p>
                    Vessel keeps shell startup files enabled while passing a
                    small allowlist of system variables. Your shell
                    configuration loads its own aliases and tools.
                  </p>
                </div>
              </div>
            </>
          )}
          {section === "Sounds" && (
            <>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={draft.soundEnabled}
                  onChange={(e) => update("soundEnabled", e.target.checked)}
                />
                Play a sound when a command finishes
              </label>
              <div className="settings-columns">
                <label>
                  Sound
                  <Select
                    aria-label="Completion sound"
                    value={draft.soundName}
                    onChange={(e) =>
                      update("soundName", e.target.value as SoundName)
                    }
                  >
                    {soundNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </Select>
                </label>
                <label>
                  Wait between sounds (seconds)
                  <input
                    type="number"
                    min={0}
                    max={3600}
                    value={draft.soundCooldownSeconds}
                    onChange={(e) =>
                      update("soundCooldownSeconds", +e.target.value)
                    }
                  />
                </label>
                <label>
                  Volume · {draft.soundVolume}%
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={draft.soundVolume}
                    onChange={(e) => update("soundVolume", +e.target.value)}
                  />
                </label>
              </div>
              <button
                className="secondary sound-preview"
                onClick={() => playSound(draft.soundName, draft.soundVolume)}
              >
                <Volume2 size={14} />
                Play sound
              </button>
              <p className="settings-help">
                The terminal you are looking at stays silent; a sound is for the
                ones you are not. The wait is shared by every terminal, so a
                program ringing in a loop cannot become a siren; the preview
                below ignores it. Tones are synthesized locally, so nothing is
                downloaded or stored. The Notifications threshold applies here
                too.
              </p>
            </>
          )}
          {section === "Notifications" && (
            <>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={draft.notifyEnabled}
                  onChange={(e) => update("notifyEnabled", e.target.checked)}
                />
                Mark the terminal, session and workspace when a command finishes
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={draft.notifyOnBell}
                  onChange={(e) => update("notifyOnBell", e.target.checked)}
                />
                Also mark when a program rings the terminal bell
              </label>
              <label>
                Ignore commands shorter than (seconds)
                <input
                  type="number"
                  min={0}
                  max={3600}
                  value={draft.notifyAfterSeconds}
                  onChange={(e) =>
                    update("notifyAfterSeconds", +e.target.value)
                  }
                />
              </label>
              <p className="settings-help">
                Vessel watches the foreground process group of each terminal, so
                anything you run counts and no shell integration is needed. The
                mark clears when you look at the terminal. macOS and Linux only:
                ConPTY exposes no equivalent on Windows.
              </p>
              <p className="settings-help">
                A tool that stays open between turns, such as Claude Code or
                Codex, never hands the terminal back, so it never finishes a
                command. The bell is what it rings when your turn comes around,
                and the threshold does not apply to it. Shells also ring for an
                ambiguous completion.
              </p>
              <div className="settings-note">
                <Bell size={18} />
                <div>
                  <strong>Vessel marks its own tabs.</strong>
                  <p>
                    Native system notifications and agent status adapters are
                    not enabled in this build. Nothing is sent to the operating
                    system notification centre.
                  </p>
                </div>
              </div>
            </>
          )}
          {section === "Advanced" && (
            <>
              <h3>Local configuration</h3>
              <p className="settings-help">
                Human-readable TOML, ready for your dotfiles. Changes made
                outside Vessel are loaded on daemon restart.
              </p>
              <code className="config-path">
                {path || "Available in the desktop application"}
              </code>
              <h3>Process persistence</h3>
              <div className="settings-note">
                <Radio size={18} />
                <div>
                  <strong>Closing the window detaches the UI.</strong>
                  <p>
                    The local Rust daemon keeps your shells running. After a
                    computer restart, session metadata is restored and terminals
                    must be started again.
                  </p>
                </div>
              </div>
            </>
          )}
          {section !== "Advanced" && (
            <div className="settings-save">
              <span role="status">{message}</span>
              <button
                className="primary"
                onClick={() => void persist()}
                disabled={saving}
              >
                {saving ? "Saving…" : "Save preferences"}
                <Check size={14} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
