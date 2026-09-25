# Architecture, files and privacy

```text
React: metadata, navigation, commands, preferences
  └─ xterm.js: imperative byte writes, WebGL for the visible terminal
       └─ Tauri Rust bridge: commands and raw binary responses
            └─ authenticated, loopback-only daemon protocol
                 └─ native PTY or ConPTY, process lifecycle, bounded output
```

The desktop binary launches a separate copy of itself with `--daemon`, detached from the window. The daemon owns the PTYs and the child processes; React mounting and unmounting never spawns or kills anything. `vessel-daemon` also runs on its own: `cargo run -p vessel-core --bin vessel-daemon`.

The daemon fingerprints its own executable and replaces a daemon that an earlier build left running, so a newly installed version never talks to one that cannot answer the operations it added. That ends the terminals the old daemon owned; the saved sessions come back as **Start terminal**.

Each terminal keeps a 1 MiB volatile byte ring and a VT screen snapshot. Readers take at most 32 KiB at a time and acknowledge offsets, so the PTY reader can apply backpressure before unconsumed bytes leave the ring; a reader idle for two seconds is dropped from that accounting, so a closed window cannot block a process forever. Reattaching restores the visible screen, not the full scrollback: this is a compatibility baseline, not tmux parity.

Platform concerns sit behind `PtyBackend`, `ShellProvider`, `PathProvider` and `ProcessProvider`. Shell startup passes a system-variable allowlist; explicit program launches take an executable and argv, never interpolated shell text; Git always takes argument arrays.

## Finished commands

A terminal reports a finished command from the PTY's foreground process group: the shell owns the terminal at a prompt and the command owns it while it runs, so a return to the shell is a command that ended. It needs no shell integration and covers anything the user runs, but it does rely on the shell's job control, which every interactive shell enables. ConPTY exposes no equivalent, so Windows terminals never report that kind.

A program that stays open between turns never hands the terminal back. It rings the terminal bell instead, which is reported the same way and ignores the duration threshold.

## Files and privacy

`config.toml` and `state.json` live in the platform configuration directory, and Settings → Advanced shows the exact path: `~/.config/vessel` on Linux, `~/Library/Application Support/dev.vessel.Vessel` on macOS, the roaming application data directory on Windows. `VESSEL_DATA_DIR` points an instance somewhere else, which is what the tests use.

Saved state is names, directories, branches, ordering and selections. Terminal output, command arguments and arbitrary environment variables are never written down. The daemon endpoint is owner-only on Unix and relies on the profile directory ACL on Windows, so do not point `VESSEL_DATA_DIR` at a shared directory. Workspace separation is organization and environment hygiene, not an OS sandbox: shell startup files and the programs you run can still load secrets and write history of their own.

The local protocol is documented in [protocol.md](protocol.md), and what is and is not implemented in [milestone.md](milestone.md).
