# Vessel local protocol, version 1

This is a versioned local execution interface for the desktop and future tools such as Sailor. There is no orchestration logic or agent-specific behavior in Vessel.

## Discovery and authentication

Read `endpoint.json` in the same platform config directory as `config.toml`. It contains `version`, loopback TCP `port`, a random `token` and daemon `pid`. Clients must verify version 1 and connect only to `127.0.0.1`. Never copy this token into logs or persistent workspace configuration. A file lock prevents competing daemon instances for one directory. `ping` also reports the `build` fingerprint of the executable serving the daemon: a client whose own executable differs is talking to a daemon from another build, which cannot answer operations added since, and must call `shutdown` before starting its own. After restart, discover the new endpoint and token again.

One request/response per connection. All lengths and offsets are unsigned big-endian. Request frame: `u32 length` followed by UTF-8 JSON:

```json
{"token":"<endpoint token>","request":{"op":"snapshot"}}
```

Response: `u8 status` (`0` success, `1` error), `u32 length`, payload. Errors are UTF-8 text. Success payloads are JSON except `read`, which returns raw binary. Frames are capped at 1 MiB. Request sockets have 5-second read/write timeouts. This protocol is local-only and is not a remote-access security boundary.

## Finished commands

A terminal status carries `attention` (`at`, `seconds`, `kind`) when the terminal has something to report. `kind` is `command` once a foreground command has run and handed the terminal back to its shell, read from the PTY's foreground process group: no shell integration, and anything the user runs counts. It depends on the shell's job control, which every interactive shell enables; a shell started without it never moves the foreground group and so never reports this kind. ConPTY exposes no equivalent, so Windows terminals never report it at all. `kind` is `bell` when a program rang the terminal bell, which is the only signal a tool that stays open between turns can give. `notifyAfterSeconds` filters short commands and never applies to a bell, `notifyOnBell` drops bells, `notifyEnabled` drops both, and `acknowledge` clears the mark when a client shows that terminal.

## Operations

| Operation | Parameters | Result |
| --- | --- | --- |
| `ping` | — | Protocol `version` and the `build` fingerprint of the daemon executable |
| `snapshot` | — | Structural state, config, live statuses, config path |
| `acknowledge` | terminal `id` | Snapshot; clears the terminal's finished-command mark |
| `createWorkspace` | `name` | Snapshot |
| `createSession` | `workspaceId`, `name`, `path`, `mode` | Snapshot |
| `createTerminal` | `sessionId`, optional `name`, `launch` (default true) | Snapshot |
| `startProcess` | terminal `id`, `program`, `args: string[]` | Snapshot |
| `restartTerminal` | `id` | Snapshot; launches configured shell |
| `closeTerminal` | `id` | Snapshot; ends process and removes metadata |
| `listSessions` | optional `workspaceId` | Sessions |
| `listTerminals` | optional `sessionId` | Terminals |
| `getTerminalStatus` | `id` | `state`, `pid`, optional `exitCode` |
| `rename` | `kind` (workspace/session/terminal), `id`, `name` | Snapshot |
| `setColor` | `kind` (workspace/terminal), `id`, nullable `color` | Snapshot; color must be a known palette token |
| `deleteSession` | `id` | Snapshot; ends the session's terminals, leaves disk untouched |
| `deleteWorkspace` | `id` | Snapshot; ends every terminal under it, leaves disk untouched |
| `select` | `workspaceId`, nullable `sessionId`, nullable `terminalId` | Snapshot |
| `setLayoutTree` | `sessionId`, nullable `root` | Save the session's pane tree, or return to tabs with `null` |
| `setLayout` | `sessionId`, `direction` (`tabs`, `horizontal`, `vertical`), `terminalIds` | Older two-pane form, folded into the same tree |
| `reorderTerminals` | `sessionId`, `ids` (exact permutation) | Snapshot |
| `completeDirectory` | partial `path` | Up to 20 matching child directories |
| `inspectDirectory` | `path` | Resolved directory and optional Git information |
| `inspectGit` | `path` | Root, branch, local branches and worktrees |
| `configure` | full `config` object | Snapshot |
| `shutdown` | — | `{stopped:true}`, then the daemon ends its terminals and exits |
| `input` | `id`, UTF-8 `data` (≤64 KiB) | `{ok:true}` |
| `resize` | `id`, `rows`, `cols` | `{ok:true}` |
| `read` | `id`, nullable `cursor`, optional `readerId` | Binary frame below |

`createSession.mode`: `none` uses the directory directly (Git optional); `existing` requires `worktreePath` belonging to the repository; `create` requires absolute `worktreePath`, `branch`, and `newBranch` boolean. Worktree paths with spaces are supported. Git errors are returned verbatim without executing user text in a shell.

`createTerminal` with `launch:false` creates stopped terminal metadata. A future consumer can then call `startProcess` to launch any executable directly. A terminal may have one live process at a time. Each restart creates a new OS process. Commands and argv are not persisted; restarts use the configured shell. No process is classified as an AI agent by the base protocol.

A session's layout is a pane tree: `{"type":"leaf","terminalId":"…"}` or `{"type":"split","direction":"row"|"column","children":[{"size":1.0,"pane":…}]}`. `row` places children side by side, `column` stacks them. Sizes are relative weights within one split, never normalized, so removing a pane needs no arithmetic. A split needs at least two children, every leaf must be a terminal of that session, no terminal may appear twice, and the tree is capped at 8 levels and 32 panes. The `direction` and `terminalIds` fields on a layout are a two-pane projection of the tree, rewritten on every change and read only by clients older than the tree.

`select` validates workspace/session/terminal ownership. This is navigation isolation, not authorization between mutually untrusted API clients: the endpoint token authorizes the local user's whole daemon.

## Output and attachment

`read` returns:

```text
u64 next_cursor
u8  reset       // 1: reset emulator before writing payload
u8  exited      // 1: process exited and final output has been drained
u8[] bytes      // UTF-8/VT stream, never JSON/base64
```

A null cursor attaches with a screen snapshot. An offset within the 1 MiB ring returns up to 32 KiB. The daemon waits up to 150 ms for output when caught up. A stale/out-of-range cursor resets to the current screen and cursor. The frontend awaits the terminal renderer's write callback before its next request. A stable per-attachment `readerId` enables producer backpressure: the supplied cursor acknowledges bytes consumed. The PTY reader waits before overwriting an active reader's unconsumed bytes. Reader registrations expire after two seconds without a read, allowing detached processes to continue. Clients without a reader ID get bounded best-effort output.

Attach/detach requires no permanent client object: attaching means starting `read`; detaching means stopping it. Neither changes process lifetime. Multiple clients may attach, but terminal size is last-writer-wins. After `restartTerminal` or `startProcess`, attach again with null cursor; offsets belong to a single process generation.

The screen snapshot restores visible VT content and supported input modes. Persistent scrollback and exact preservation of all xterm extensions are not part of v1. Normal streaming is lossless until a reader falls behind the bounded ring. No output is saved to disk.

## Compatibility

Additive fields may be introduced in version 1. Incompatible framing/semantic changes require a version bump. An SDK, subscription transport, formal JSON schema and more complete terminal-state serialization remain future work. Clients should tolerate additional object fields and surface errors rather than infer success.
