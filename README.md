# Vessel

![Vessel](docs/vessel-hero.png)

A local-first desktop terminal and session manager. Real shells, kept together by the work they belong to, running whether or not the window is open.

[![Checks](https://github.com/matheuscavin/vessel/actions/workflows/ci.yml/badge.svg)](https://github.com/matheuscavin/vessel/actions/workflows/ci.yml)

- Real system shells over the OS PTY, or ConPTY on Windows. No emulation.
- A detached daemon owns every process: close the window and your work keeps running.
- Workspaces hold sessions, sessions hold terminals. A session is a directory, a repository, or a Git worktree it creates for you.
- Tabs, and panes that nest in either direction.
- A mark when a command finishes while you were elsewhere, with an optional sound.
- Local files only. Nothing leaves the machine.

## Install

There is no prebuilt release yet: you build it once. Most of the few minutes it takes is Rust compiling.

### 1. Install the prerequisites

Every platform needs [Node 22+](https://nodejs.org), a stable Rust toolchain from [rustup](https://rustup.rs), and Git. The finished application needs none of them.

**macOS** also needs the Xcode command line tools:

```sh
xcode-select --install
```

**Linux** also needs the WebKit and packaging libraries. On Debian or Ubuntu:

```sh
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf build-essential curl wget file libssl-dev libxdo-dev libayatana-appindicator3-dev
```

**Windows** also needs the [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload. WebView2 already ships with Windows 11 and current Windows 10.

### 2. Build

```sh
git clone https://github.com/matheuscavin/vessel.git
cd vessel
npm ci
npm run desktop:build
```

Everything lands under `target/release/bundle/`.

### 3. Install the result

**macOS**

```sh
cp -R target/release/bundle/macos/Vessel.app /Applications/
xattr -dr com.apple.quarantine /Applications/Vessel.app
open -a /Applications/Vessel.app
```

The build is unsigned, so without that middle line macOS refuses the first open. You can instead right click the application and choose **Open**. Unsigned builds also get a fresh identity on every rebuild, so macOS asks again for any privacy permission you had granted.

**Linux**, whichever suits your distribution:

```sh
# Debian, Ubuntu
sudo dpkg -i target/release/bundle/deb/Vessel_*_amd64.deb

# Fedora, RHEL
sudo rpm -i target/release/bundle/rpm/Vessel-*.x86_64.rpm

# anything else, no installation at all
chmod +x target/release/bundle/appimage/Vessel_*_amd64.AppImage
./target/release/bundle/appimage/Vessel_*_amd64.AppImage
```

**Windows**: double click the installer the build produced, at `target\release\bundle\msi\Vessel_0.1.0_x64_en-US.msi`. The build is unsigned, so SmartScreen warns once: choose **More info**, then **Run anyway**.

To update, pull and repeat. Vessel replaces the daemon an earlier build left running, which ends its terminals; your workspaces and sessions come back as **Start terminal**.

## Getting started

1. **Make a workspace**, one per company, client or personal context. The tabs are along the top; **+** adds one and a double click renames it.
2. **Make a session** with `Mod+N`. Give it a name and a directory; paths autocomplete as you type. If it is a Git repository, choose **Use directory**, **New worktree** to get a branch of your own, or **Existing worktree**. `Mod+Shift+N` skips the dialog and starts one in your home directory.
3. **Open a terminal** with `Mod+T`. It is a real shell. `Mod+1` to `Mod+9` switch tabs, and dragging a tab reorders it.
4. **Split the view** with `Mod+Shift+Right` or `Mod+Shift+Down`. Panes nest as deep as you like, and the proportions are saved with the session.
5. **Walk away from a long command.** When it finishes, its tab, its session and its workspace carry a mark until you look at it, and Vessel can play a sound. Settings → **Notifications** and **Sounds** hold the switches and the threshold that hides commands too short to matter. A tool that stays open between turns, such as Claude Code, rings the terminal bell instead, which is marked the same way.
6. **Close the window.** The daemon keeps your shells running; reopen Vessel and it reattaches.

Deleting a session or a workspace ends the terminals inside it and leaves every repository and worktree on disk alone.

`Cmd` on macOS, `Ctrl` on Windows and Linux. All of these are configurable in Settings, along with six themes, the font, scrollback and the shell.

| Shortcut | Action |
| --- | --- |
| Mod+N | New session |
| Mod+Shift+N | Quick session |
| Mod+T | New terminal |
| Mod+W | Close terminal |
| Mod+1…9 | Select terminal |
| Mod+Shift+Right / Down | Split right / down |
| Mod+Shift+P | Command palette |
| Mod+, | Settings |

## Platform support

| Platform | State |
| --- | --- |
| macOS | Used daily. Full suite green in CI, real PTY and browser integration included. |
| Linux | Full suite green in CI, real PTY included. The desktop build has not been exercised by hand. |
| Windows | Builds, and everything that does not need a terminal passes in CI. Terminal behavior is **unverified**: the CI image delivers no pseudoconsole output at all, so those tests skip there. Run the suite on a real machine to exercise it. |

## Development

```sh
npm run desktop     # the app, with a detached daemon
npm run dev         # UI preview only, deliberately without terminals
npm run test:unit
cargo test -p vessel-core
cargo build -p vessel-core && npx playwright install chromium && npm test
```

The Rust tests drive real PTYs through a real daemon, and `npm test` puts a Chromium in front of that same daemon, replacing only Tauri's transport.

[Architecture and privacy](docs/architecture.md) · [Local protocol](docs/protocol.md) · [What is implemented](docs/milestone.md)
