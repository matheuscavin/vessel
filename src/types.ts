export interface Workspace {
  id: string;
  name: string;
  color: string | null;
}
export interface Session {
  id: string;
  workspaceId: string;
  name: string;
  repository: string | null;
  branch: string | null;
  worktree: string | null;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  layout: SessionLayout;
}
export type Axis = "row" | "column";
export type Pane =
  | { type: "leaf"; terminalId: string }
  | { type: "split"; direction: Axis; children: PaneChild[] };
export interface PaneChild {
  size: number;
  pane: Pane;
}
/** `root` is the truth; `direction`/`terminalIds` are its two-pane projection. */
export interface SessionLayout {
  direction: "tabs" | "horizontal" | "vertical";
  terminalIds: string[];
  root?: Pane | null;
}
export interface ShellOption {
  label: string;
  path: string;
}
export interface TerminalMeta {
  id: string;
  sessionId: string;
  name: string;
  color: string | null;
}
export interface Config {
  theme: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  scrollback: number;
  shell: string;
  keybindings: Record<string, string>;
  copyJoinWrapped: boolean;
  notifyEnabled: boolean;
  notifyOnBell: boolean;
  notifyAfterSeconds: number;
  soundEnabled: boolean;
  soundName: SoundName;
  soundCooldownSeconds: number;
  /** Percent. */
  soundVolume: number;
}
export type SoundName = "Chime" | "Ping" | "Knock";
export interface Snapshot {
  state: {
    workspaces: Workspace[];
    sessions: Session[];
    terminals: TerminalMeta[];
    selectedWorkspace: string | null;
    selectedSession: string | null;
    selectedTerminal: string | null;
    workspaceSessions: Record<string, string>;
    sessionTerminals: Record<string, string>;
  };
  config: Config;
  statuses: Record<
    string,
    {
      state: "running" | "exited" | "stopped";
      exitCode?: number;
      pid?: number;
      /** A command that finished while nobody was watching this terminal. */
      attention?: { at: number; seconds: number; kind: "command" | "bell" };
    }
  >;
  configPath: string;
  protocolVersion: number;
}
export interface GitInfo {
  root: string;
  branch: string;
  branches: string[];
  worktrees: { path: string; branch?: string }[];
}
