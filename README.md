# Vessel

A local-first desktop terminal and session manager. Tauri 2, React, TypeScript, xterm.js, and a Rust PTY daemon. Vessel runs arbitrary CLI programs; it is not an AI agent or orchestrator.

The v4 preview informed the maritime palette. This implementation replaces its simulated four-terminal grid with real terminal tabs and nested tiling, a restrained session sidebar, workspace tabs, keyboard commands, and full-page settings.

## What you get

- Real system shells over the OS PTY, or ConPTY on Windows. No emulation, no simulated output.
- A detached daemon owns every process, so closing the window leaves your work running and reopening reattaches to it.
- Workspaces hold sessions, sessions hold terminals. A session can be a directory, a repository, or a Git worktree it creates for you.
- Terminal tabs, and panes that nest in either direction with the proportions saved per session.
- A mark on the tab, the session and the workspace when a command finishes while you were elsewhere, with an optional sound.
- Local files only: human-readable TOML configuration and a JSON state file under your platform's configuration directory. Nothing leaves the machine.

## Download and install

There is no prebuilt release yet, so you build it once and copy the result where you keep your applications. Most of the few minutes it takes is Rust compiling.

### Prerequisites

- **Node 22 or newer**, to build the interface. The finished application does not need Node.
- **A stable Rust toolchain**, through [rustup](https://rustup.rs).
- **Git**, for the repository and worktree features.
- The [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system. Linux additionally needs WebKitGTK 4.1; Windows uses the system WebView2.

### Build

```sh
git clone https://github.com/matheuscavin/vessel.git
cd vessel
npm ci
npm run desktop:build
```

### Install

On macOS the bundle lands at `target/release/bundle/macos/Vessel.app`:

```sh
cp -R target/release/bundle/macos/Vessel.app /Applications/
open -a /Applications/Vessel.app
```

For the application bundle alone, without a disk image: `npm run desktop:build -- --bundles app`.

The build is **unsigned and not notarized**, so macOS refuses the first open. Either right-click the application and choose **Open**, or clear the quarantine attribute yourself:

```sh
xattr -dr com.apple.quarantine /Applications/Vessel.app
```

On Linux and Windows the same command writes the native packages under `target/release/bundle/` (`deb`, `rpm` and `AppImage`; `msi` and `nsis`). Those platforms build in CI but have not been exercised at runtime, so treat them as untested.

### Updating

Pull, rebuild, and replace the installed application. Vessel compares the daemon's executable with its own when it starts and replaces a daemon left running by an earlier build. That ends the terminals the old daemon owned; workspaces, sessions and terminal metadata survive and come back as **Start terminal**.

## Run from source

```sh
npm ci
npm run desktop
```

The desktop starts its detached daemon automatically. `npm run dev` alone serves a UI preview, which deliberately cannot create terminals. It does not simulate terminal output.

## Working with Vessel

1. Create a workspace for a company, client, or personal context.
2. Create a session with a repository or directory. `~` and `~/...` are supported. Directory paths autocomplete as you type (arrows to navigate, Tab/Enter to complete). Git is detected automatically; choose **Use directory**, **New worktree**, or **Existing worktree**.
3. Open a terminal. It is a real system shell with ANSI colors, Unicode, keyboard/mouse input, alternate screens, and resize support via xterm.js and the OS PTY.
4. Add more terminal tabs. Double-click a tab, session or workspace to rename it; tabs and workspaces also take a color there. Drag terminal tabs to reorder. Use the terminal actions menu or command palette to split the focused pane right or down, as many times as you like and in either direction: panes nest, and dragging a divider resizes them with the proportions saved to the session. Switch back to tabs whenever you like. The terminal actions menu also provides duplicate and restart.
5. Delete a session or workspace from the × on its row, or from the command palette. That ends the terminals inside it and leaves every repository and worktree on disk alone.
6. Leave a long command running and go elsewhere. When it hands the terminal back to its shell, its tab, its session and its workspace carry a mark until you look at it, and Vessel can play a short sound. Both live in Settings, under Notifications and Sounds: the threshold hides commands too short to have lost your attention, and one wait shared by every terminal keeps a program that rings in a loop from becoming a siren. The foreground process group of the PTY is what says a command finished, so nothing needs shell integration; it does rely on the shell's job control, which every interactive shell enables, and Windows has no equivalent to read at all. A tool that stays open between turns, such as Claude Code or Codex, never hands the terminal back; it rings the terminal bell instead, which is marked the same way and ignores the threshold.
7. Copying from a program that wraps its own output, such as Claude Code, gives you one line per row, because that is all the terminal was ever sent. **Copy wrapped rows as whole lines** in Settings → Terminal rejoins the rows the following word could not have fitted on, and leaves lists, quotes, headings and short lines alone. It is off by default: the join is inferred, never recorded.
8. Close the window to detach. Reopen Vessel to reconnect. Explicitly closing a terminal ends its process. After a daemon or OS restart, saved terminals show **Start terminal** rather than silently rerunning commands.

`Cmd` on macOS, `Ctrl` on Windows/Linux:

| Shortcut | Action |
| --- | --- |
| Mod+N | New session |
| Mod+T | New terminal |
| Mod+W | Close terminal |
| Mod+1…9 | Select terminal |
| Mod+Shift+P | Command palette |
| Mod+, | Settings |
| Mod+Shift+R | Rename session |
| Mod+Alt+Down | Next session |
| Mod+Alt+Right | Next workspace |

Shortcuts are configurable in Settings. Ocean, Deep Sea, Coral, Navy, Amber and Mono themes coordinate terminal and application colors. Font family, size, line height, scrollback and shell executable are configurable.

## Architecture

```text
React: metadata, navigation, commands, preferences
  └─ xterm.js: imperative byte writes, WebGL for visible terminal
       └─ Tauri Rust bridge: commands + raw binary responses
            └─ authenticated, loopback-only daemon protocol
                 ├─ native PTY / Windows ConPTY
                 ├─ process lifecycle, bounded output, screen snapshot
                 ├─ workspace/session/terminal metadata
                 ├─ controlled Git subprocesses
                 └─ platform configuration directory
```

The desktop binary launches a separate copy with `--daemon`, detached from the desktop process. The daemon owns PTYs and child processes; React mounting/unmounting never spawns or kills them. `vessel-daemon` is also independently runnable with `cargo run -p vessel-core --bin vessel-daemon`.

Each terminal has a 1 MiB volatile byte ring and a VT screen snapshot. Readers request at most 32 KiB of incremental data. The frontend waits for xterm's write callback before requesting another chunk, bounding its input queue. Active readers acknowledge offsets; the PTY reader applies backpressure before their unconsumed bytes leave the ring. A reader inactive for two seconds is detached from backpressure, so closing a window cannot indefinitely block a process. A stale reader receives a current-screen reset. Full historical scrollback is **not** restored after UI reconnect. The screen snapshot is a compatibility baseline, not full tmux protocol parity; both alternate/normal buffer histories and every xterm extension are not preserved across reattach.

Platform concerns are behind `PtyBackend`, `ShellProvider`, `PathProvider`, and `ProcessProvider`. `portable-pty` selects Unix PTYs or ConPTY. Shell startup uses a system-variable allowlist; explicit API process launches use an executable and argv, never interpolated shell text. Git always uses argument arrays. See [protocol](docs/protocol.md).

## Local files and privacy

`config.toml` and `state.json` are under the platform config directory; Settings → Advanced shows the exact location. Common defaults are `~/.config/vessel` (Linux), `~/Library/Application Support/dev.vessel.Vessel` (macOS), and the roaming application-data directory (Windows). Set `VESSEL_DATA_DIR` to use an isolated instance, particularly for tests.

Persistent state includes names, directories, branches, ordering and selections. Terminal output, command argv and arbitrary environment variables are not persisted. The authenticated endpoint has owner-only file/directory permissions on Unix; Windows relies on the user's profile-directory ACL. Do not point `VESSEL_DATA_DIR` at a shared directory. Workspace separation is organizational and environment hygiene, not an OS sandbox. Shell startup files and CLI applications can independently load secrets or write command history.

## Verification

```sh
npm run build
cargo test -p vessel-core
cargo clippy --workspace --all-targets -- -D warnings
cargo build -p vessel-core
npx playwright install chromium
npm test
```

The Rust integration tests launch a real daemon: PTY input, resize, screen reattach, ANSI true color, Unicode, alternate screen transitions, an actual Vim edit/save, explicit process launch, process exit, metadata restoration, environment filtering, workspace ownership checks and real Git worktrees. Vim/ANSI-specific checks run on Unix; Windows runs the ConPTY shell lifecycle test. CI defines macOS, Linux and Windows build/test jobs. The core also passes cross-target compilation for Windows x86_64 and Linux x86_64. Only macOS runtime tests were executed locally during this implementation; CI results are required before claiming Windows/Linux release readiness.

The browser test harness replaces only Tauri's transport with a test binding to the **real Rust daemon**. It verifies UI creation, real terminal input, tabs, rename, reload/reconnect, preferences and command palette. It does not replace PTYs or provide fake output. It also writes screenshots to `docs/screenshots`, which are generated locally and not kept in the repository.

Unix throughput probe:

```sh
cargo build --release -p vessel-core
node scripts/benchmark.mjs
```

This measures generated log bytes through the daemon and local protocol, not GPU rendering. It reports elapsed time, received bytes and ring resets; resets indicate dropped historical bytes with screen resynchronization. See [validation and remaining work](docs/milestone.md).
