use crate::model::ShellOption;
use anyhow::{bail, Context, Result};
use portable_pty::{CommandBuilder, PtyPair, PtySize};
use std::path::{Path, PathBuf};

pub trait PtyBackend: Send + Sync {
    fn open(&self, rows: u16, cols: u16) -> Result<PtyPair>;
}
pub struct NativePtyBackend;
impl PtyBackend for NativePtyBackend {
    fn open(&self, rows: u16, cols: u16) -> Result<PtyPair> {
        portable_pty::native_pty_system().openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
    }
}
pub trait ShellProvider {
    fn command(&self, configured: &str, cwd: &Path) -> Result<CommandBuilder>;
}
pub struct NativeShellProvider;
impl ShellProvider for NativeShellProvider {
    fn command(&self, configured: &str, cwd: &Path) -> Result<CommandBuilder> {
        let shell = if !configured.trim().is_empty() {
            configured.to_owned()
        } else if cfg!(windows) {
            std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
        } else {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
        };
        let mut cmd = CommandBuilder::new(shell);
        cmd.env_clear();
        // Never copy the complete GUI environment into another workspace.
        for key in [
            "PATH",
            "HOME",
            "USER",
            "LOGNAME",
            "SHELL",
            "LANG",
            "LC_ALL",
            "LC_CTYPE",
            "TMPDIR",
            "TMP",
            "TEMP",
            "SystemRoot",
            "SYSTEMROOT",
            "WINDIR",
            "COMSPEC",
            "USERPROFILE",
            "HOMEDRIVE",
            "HOMEPATH",
            "APPDATA",
            "LOCALAPPDATA",
            "PATHEXT",
            "SystemDrive",
            "ProgramData",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "USERNAME",
            "COMPUTERNAME",
            "NUMBER_OF_PROCESSORS",
            "PROCESSOR_ARCHITECTURE",
            "OS",
        ] {
            if let Some(v) = std::env::var_os(key) {
                cmd.env(key, v);
            }
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "Vessel");
        cmd.cwd(cwd);
        Ok(cmd)
    }
}
pub trait PathProvider {
    fn directory(&self, raw: &str) -> Result<PathBuf>;
}
pub struct NativePathProvider;
impl PathProvider for NativePathProvider {
    fn directory(&self, raw: &str) -> Result<PathBuf> {
        let home = directories::BaseDirs::new()
            .context("Home directory unavailable")?
            .home_dir()
            .to_owned();
        let path = if raw.is_empty() || raw == "~" {
            home
        } else if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
            home.join(rest)
        } else {
            PathBuf::from(raw)
        };
        let path = path
            .canonicalize()
            .with_context(|| format!("Directory does not exist: {}", path.display()))?;
        if !path.is_dir() {
            bail!("Choose a directory");
        }
        Ok(path)
    }
}

/// Explicit program launch for local API consumers. Arguments never pass through a shell.
/// The command and arguments are deliberately not persisted.
pub fn program_command(program: &str, args: &[String], cwd: &Path) -> Result<CommandBuilder> {
    if program.trim().is_empty() {
        bail!("Program must not be empty");
    }
    let mut command = NativeShellProvider.command(program, cwd)?;
    command.args(args);
    Ok(command)
}
pub fn detach_daemon(cmd: &mut std::process::Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x00000008 | 0x00000200);
    }
}
/// The foreground process group of a PTY, which is the shell's own at a prompt and the
/// command's while one runs. ConPTY has no equivalent, so Windows always answers None.
pub fn foreground_group(master: &dyn portable_pty::MasterPty) -> Option<i32> {
    #[cfg(unix)]
    {
        master.process_group_leader()
    }
    #[cfg(windows)]
    {
        let _ = master;
        None
    }
}
/// The daemon leads its own session, so the group signal takes its shells with it.
pub fn stop_process(pid: u32) {
    #[cfg(unix)]
    unsafe {
        if libc::kill(-(pid as i32), libc::SIGTERM) != 0 {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
}
/// Signals are kept behind the platform boundary. The PTY shell owns its jobs.
pub trait ProcessProvider {
    fn terminate(
        &self,
        master: &dyn portable_pty::MasterPty,
        killer: &mut dyn portable_pty::ChildKiller,
        pid: Option<u32>,
    ) -> Result<()>;
}
pub struct NativeProcessProvider;
impl ProcessProvider for NativeProcessProvider {
    fn terminate(
        &self,
        master: &dyn portable_pty::MasterPty,
        killer: &mut dyn portable_pty::ChildKiller,
        pid: Option<u32>,
    ) -> Result<()> {
        #[cfg(unix)]
        {
            if let Some(group) = master.process_group_leader() {
                if group > 0 {
                    unsafe {
                        libc::kill(-group, libc::SIGHUP);
                    }
                }
            }
            let _ = pid;
            killer.kill()?;
        }
        #[cfg(windows)]
        {
            let _ = master;
            if let Some(pid) = pid {
                let status = std::process::Command::new("taskkill.exe")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()?;
                if !status.success() {
                    killer.kill()?;
                }
            } else {
                killer.kill()?;
            }
        }
        Ok(())
    }
}

/// Return only shell executables present on the host. The default entry deliberately
/// uses the parent environment's normal SHELL/COMSPEC detection.
pub fn available_shells(configured: &str) -> Vec<ShellOption> {
    let system = if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    };
    let system_label = std::path::Path::new(&system)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&system);
    let mut shells = vec![ShellOption {
        label: format!("System default ({system_label})"),
        path: String::new(),
    }];
    let candidates: &[(&str, &str)] = if cfg!(windows) {
        &[
            ("PowerShell 7", "pwsh.exe"),
            ("Windows PowerShell", "powershell.exe"),
            ("Command Prompt", "cmd.exe"),
        ]
    } else {
        &[
            ("zsh", "zsh"),
            ("bash", "bash"),
            ("fish", "fish"),
            ("sh", "sh"),
        ]
    };
    for (label, name) in candidates {
        if let Some(path) = find_executable(name) {
            let path = path.to_string_lossy().into_owned();
            if !shells.iter().any(|shell| shell.path == path) {
                shells.push(ShellOption {
                    label: (*label).into(),
                    path,
                });
            }
        }
    }
    if !configured.is_empty() && !shells.iter().any(|shell| shell.path == configured) {
        let label = Path::new(configured)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(configured);
        shells.push(ShellOption {
            label: format!("Custom ({label})"),
            path: configured.into(),
        });
    }
    shells
}
fn find_executable(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    #[cfg(windows)]
    let extensions = std::env::var("PATHEXT")
        .ok()
        .map(|v| v.split(';').map(str::to_owned).collect::<Vec<_>>())
        .unwrap_or_else(|| vec![".EXE".into(), ".CMD".into(), ".BAT".into()]);
    for dir in std::env::split_paths(&path) {
        #[cfg(windows)]
        let candidates = if Path::new(name).extension().is_some() {
            vec![dir.join(name)]
        } else {
            extensions
                .iter()
                .map(|ext| dir.join(format!("{name}{ext}")))
                .collect()
        };
        #[cfg(not(windows))]
        let candidates = vec![dir.join(name)];
        for candidate in candidates {
            if let Ok(meta) = candidate.metadata() {
                if meta.is_file() {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        if meta.permissions().mode() & 0o111 == 0 {
                            continue;
                        }
                    }
                    return Some(candidate);
                }
            }
        }
    }
    None
}
