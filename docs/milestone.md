# Initial implementation status

## Implemented

- Native Tauri app and self-contained React UI, with real xterm.js terminals and active-tab WebGL acceleration.
- Rust PTY/ConPTY abstractions, resize, byte I/O, lifecycle/status, bounded output and direct executable/argv launches.
- Multiple terminals; create, close, rename, reorder, duplicate and restart.
- Workspace/session ownership, creation, renaming and remembered navigation.
- Directory sessions, repository inspection, branch listing, new/existing Git worktrees.
- Persistent structural state and human-readable TOML configuration.
- Detached daemon, authenticated loopback protocol, client reconnect and stopped-state restoration after daemon restart.
- Six themes; font family/size/line-height, scrollback, shell preference; centralized configurable shortcuts; command palette.
- Finished-command marks on the terminal tab, session and workspace, read from the PTY's foreground process group on Unix and from the terminal bell for tools that stay open between turns, with a duration threshold and locally synthesized event sounds.
- macOS app bundle, cross-platform CI definition, Rust integration tests, actual-PTY browser integration and throughput probe.

## Remaining before a broader release

- Execute and review Windows and Linux CI/runtime results; test PowerShell, cmd, WSL, SSH, fzf, Neovim and agent CLIs on each platform. Local validation is macOS, including zsh, shell output and Vim.
- Full tmux-grade restoration of normal/alternate screens, historical scrollback and terminal extensions. Current reattach restores the visible VT screen; slow clients can lose old output when the ring wraps.
- Optional horizontal/vertical split layout and layout persistence. The initial UI intentionally opens one terminal at a time.
- Native system notifications with click-to-focus and optional agent status adapters. In-app marks for finished commands and configurable event sounds are implemented; nothing reaches the operating system notification centre, and no agent state is fabricated.
- CLI packaging/open/attach commands (the shared daemon API is available), secret-store references and richer per-workspace environment profiles.
- Custom ANSI palette editing, opacity, ligature/font-weight controls, configurable close-window behavior (currently always detach), and deletion/archive UX for sessions/workspaces.
- Signed/notarized release installers, auto-update strategy and extended compatibility/performance soak testing. Local macOS output is unsigned.
- Cross-platform crash-injection and process-tree tests, especially stubborn/background descendants. Explicit close uses Unix hangup/PTY teardown or Windows taskkill; arbitrary self-daemonizing children are not guaranteed to be contained.

## Test boundaries

The browser harness uses Chromium and real Rust PTYs, with a test-only transport binding. It validates the frontend/backend integration but does not substitute for exercising all shortcuts, clipboard behavior and GPU drivers in each platform's native WebView. `cargo check`, Clippy and native bundling validate the Tauri bridge on macOS. The native smoke test also passed: the WebView resized a real PTY through IPC, the shell stayed interactive after the UI was terminated, and a native reopen retained the same PID.

The daemon keeps at most 1 MiB of raw output per terminal, plus bounded screen state. The xterm scrollback limit defaults to 5,000 lines and is configurable up to 50,000. Byte output never passes through React/global state. The local byte benchmark excludes xterm rendering and should not be described as a rendering frame-rate benchmark.

## Local benchmark result

On this Apple Silicon development machine, the 16 MiB generated-log probe completed in 0.244 seconds (65.62 source MiB/s), delivered 17,027,622 PTY bytes including CRLF expansion, and reported **zero screen resets** with active-reader backpressure. This is a single-run daemon/protocol measurement, including a 50 ms producer startup delay, not a promise of renderer throughput or a cross-platform comparison.

## Cross-target checks

`cargo check -p vessel-core --target x86_64-pc-windows-gnu` and `cargo check -p vessel-core --target x86_64-unknown-linux-gnu` both passed locally. These compile the Windows/ConPTY and Linux platform code paths; they do not constitute runtime validation or complete desktop bundles for those platforms.
