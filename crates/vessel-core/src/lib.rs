pub mod directories;
pub mod git;
pub mod layout;
pub mod model;
pub mod platform;
use anyhow::{bail, Context, Result};
use fs2::FileExt;
use model::*;
use platform::*;
use portable_pty::{ChildKiller, MasterPty};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{Arc, Condvar, Mutex, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
const MAX_FRAME: usize = 1024 * 1024;
const HISTORY: usize = 1024 * 1024;
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
static BUILD: OnceLock<String> = OnceLock::new();
/// Fingerprints the executable behind the daemon. A daemon left running by an earlier
/// build answers operations this one added with "Unknown operation", so the app has to
/// recognize it rather than keep talking to it. Read once, before the file can change
/// underneath a running daemon.
fn build_id() -> &'static str {
    BUILD.get_or_init(|| {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        if let Ok(bytes) = std::env::current_exe().and_then(fs::read) {
            for b in bytes {
                hash ^= u64::from(b);
                hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
            }
        }
        format!("{hash:016x}")
    })
}
pub fn data_dir() -> Result<PathBuf> {
    let dir = if let Some(p) = std::env::var_os("VESSEL_DATA_DIR") {
        PathBuf::from(p)
    } else {
        ::directories::ProjectDirs::from("dev", "vessel", "Vessel")
            .context("Config directory unavailable")?
            .config_dir()
            .to_owned()
    };
    fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}
fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension(format!("{}.tmp", id()));
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    // Windows rename does not overwrite destinations. Keep a backup for crash recovery.
    #[cfg(windows)]
    if path.exists() {
        let backup = path.with_extension("bak");
        let _ = fs::remove_file(&backup);
        fs::rename(path, backup)?;
    }
    fs::rename(tmp, path)?;
    Ok(())
}
fn read_saved(path: &std::path::Path) -> Result<Option<String>> {
    if path.exists() {
        return Ok(Some(fs::read_to_string(path)?));
    }
    let backup = path.with_extension("bak");
    if backup.exists() {
        return Ok(Some(fs::read_to_string(backup)?));
    }
    Ok(None)
}
struct Output {
    bytes: VecDeque<u8>,
    end: u64,
    parser: vt100::Parser,
    exit: Option<u32>,
    eof: bool,
    readers: HashMap<String, (u64, Instant)>,
    bells: usize,
}
struct Live {
    /// ConPTY keeps its session only while the slave side stays open, so the drop that is
    /// right after spawning on Unix would tear the console down here.
    #[cfg(windows)]
    _slave: Mutex<Box<dyn portable_pty::SlavePty + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    output: Arc<(Mutex<Output>, Condvar)>,
    pid: Option<u32>,
    activity: Arc<Mutex<Activity>>,
}
/// What the terminal has been doing while nobody was watching it. The foreground process
/// group of the PTY is the shell's own while it sits at a prompt and the command's while
/// one runs, so a return to the shell is a command that finished. No shell integration,
/// no guessing from output.
#[derive(Default)]
struct Activity {
    busy_since: Option<Instant>,
    /// The last command to finish, until a client acknowledges it.
    finished: Option<Finished>,
}
#[derive(Clone, Copy)]
struct Finished {
    at: u64,
    seconds: u64,
    /// `command` returned the terminal to the shell; `bell` asked for attention while
    /// keeping it. Long-lived TUIs never do the first, which is why both are read.
    kind: &'static str,
}
struct Core {
    state: State,
    config: Config,
    live: HashMap<String, Arc<Live>>,
    dir: PathBuf,
}
impl Core {
    fn load() -> Result<Self> {
        let dir = data_dir()?;
        let mut state: State = read_saved(&dir.join("state.json"))?
            .map(|s| serde_json::from_str(&s))
            .transpose()?
            .unwrap_or_default();
        // One-shot import of the pre-tree display store, which is then retired so it can
        // never resurrect a layout the user has since changed.
        let retired = dir.join("display-state.json");
        let imported = read_saved(&retired)?
            .and_then(|s| serde_json::from_str::<HashMap<String, SessionLayout>>(&s).ok());
        if imported.is_some() {
            let _ = fs::rename(&retired, dir.join("display-state.imported.json"));
        }
        let terminals = state.terminals.clone();
        for session in &mut state.sessions {
            if let Some(stored) = imported.as_ref().and_then(|l| l.get(&session.id)) {
                if session.layout.root.is_none() && session.layout.direction == "tabs" {
                    session.layout = stored.clone();
                }
            }
            if session.layout.root.is_none() {
                session.layout.root =
                    layout::from_legacy(&session.layout.direction, &session.layout.terminal_ids);
            }
            let owned: HashSet<&str> = terminals
                .iter()
                .filter(|t| t.session_id == session.id)
                .map(|t| t.id.as_str())
                .collect();
            // Repair rather than discard: the old boot filter silently dropped any layout
            // that was not exactly two panes.
            session.layout.root = session
                .layout
                .root
                .take()
                .and_then(|r| layout::repair(r, &owned));
            session.layout.project();
        }
        let config = read_saved(&dir.join("config.toml"))?
            .map(|s| toml::from_str(&s))
            .transpose()?
            .unwrap_or_default();
        Ok(Self {
            state,
            config,
            live: HashMap::new(),
            dir,
        })
    }
    /// The only place a session layout is assigned. Validates, stores, and refreshes the
    /// legacy projection so those fields can never drift from the tree.
    fn apply_layout(&mut self, sid: &str, root: Option<layout::Pane>) -> Result<()> {
        let owned: Vec<String> = self
            .state
            .terminals
            .iter()
            .filter(|t| t.session_id == sid)
            .map(|t| t.id.clone())
            .collect();
        if let Some(root) = &root {
            layout::validate(root, &owned.iter().map(String::as_str).collect())?;
        }
        let session = self
            .state
            .sessions
            .iter_mut()
            .find(|s| s.id == sid)
            .context("Session not found")?;
        session.layout.root = root;
        session.layout.project();
        session.updated_at = now();
        Ok(())
    }
    fn save(&self) -> Result<()> {
        write_private(
            &self.dir.join("state.json"),
            &serde_json::to_vec_pretty(&self.state)?,
        )?;
        write_private(
            &self.dir.join("config.toml"),
            toml::to_string_pretty(&self.config)?.as_bytes(),
        )
    }
    fn snapshot(&mut self) -> Value {
        if let Some(session) = self
            .state
            .sessions
            .iter_mut()
            .find(|s| Some(&s.id) == self.state.selected_session.as_ref())
        {
            if session.repository.is_some() {
                session.branch = Some(
                    git::run(
                        std::path::Path::new(&session.cwd),
                        &["symbolic-ref", "--short", "-q", "HEAD"],
                    )
                    .unwrap_or_else(|_| "detached HEAD".into()),
                );
            }
        }
        let threshold = u64::from(self.config.notify_after_seconds);
        let notify = self.config.notify_enabled;
        let bells = self.config.notify_on_bell;
        let statuses:HashMap<_,_>=self.state.terminals.iter().map(|t|{
            let status=if let Some(l)=self.live.get(&t.id){let o=l.output.0.lock().unwrap();let mut status=json!({"state":if o.exit.is_some(){"exited"}else{"running"},"exitCode":o.exit,"pid":l.pid});if let Some(f)=l.activity.lock().unwrap().finished.filter(|f|notify&&if f.kind=="bell"{bells}else{f.seconds>=threshold}){status["attention"]=json!({"at":f.at,"seconds":f.seconds,"kind":f.kind});}status}else{json!({"state":"stopped"})};(t.id.clone(),status)
        }).collect();
        json!({"state":self.state,"config":self.config,"statuses":statuses,"configPath":self.dir.join("config.toml"),"protocolVersion":1})
    }
    fn start(&mut self, tid: &str, program: Option<(&str, Vec<String>)>) -> Result<()> {
        if let Some(l) = self.live.get(tid) {
            if l.output.0.lock().unwrap().exit.is_none() {
                bail!("Terminal is already running");
            }
        }
        let meta = self
            .state
            .terminals
            .iter()
            .find(|t| t.id == tid)
            .context("Terminal not found")?;
        let session = self
            .state
            .sessions
            .iter()
            .find(|s| s.id == meta.session_id)
            .context("Session not found")?;
        let cwd = NativePathProvider.directory(&session.cwd)?;
        let pair = NativePtyBackend.open(30, 100)?;
        let mut command = NativeShellProvider.command(&self.config.shell, &cwd)?;
        if let Some((program, args)) = program {
            command = platform::program_command(program, &args, &cwd)?;
        }
        let mut child = pair.slave.spawn_command(command)?;
        #[cfg(unix)]
        drop(pair.slave);
        let pid = child.process_id();
        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let output = Arc::new((
            Mutex::new(Output {
                bytes: VecDeque::new(),
                end: 0,
                parser: vt100::Parser::new(30, 100, 0),
                exit: None,
                eof: false,
                readers: HashMap::new(),
                bells: 0,
            }),
            Condvar::new(),
        ));
        let activity: Arc<Mutex<Activity>> = Default::default();
        let live = Arc::new(Live {
            #[cfg(windows)]
            _slave: Mutex::new(pair.slave),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            output: output.clone(),
            pid,
            activity: activity.clone(),
        });
        self.live.insert(tid.into(), live.clone());
        watch_foreground(live, activity.clone(), pid);
        let read_output = output.clone();
        let read_activity = activity.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 32768];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let mut out = read_output.0.lock().unwrap();
                loop {
                    out.readers
                        .retain(|_, (_, seen)| seen.elapsed() < Duration::from_secs(2));
                    let slowest = out.readers.values().map(|(cursor, _)| *cursor).min();
                    if slowest.is_none_or(|cursor| {
                        out.end.saturating_sub(cursor) + (n as u64) <= HISTORY as u64
                    }) {
                        break;
                    }
                    out = read_output
                        .1
                        .wait_timeout(out, Duration::from_millis(100))
                        .unwrap()
                        .0;
                }
                out.parser.process(&buf[..n]);
                // A program that rings the bell is asking for you by name, however long it
                // has been running and whether or not it ever gives the terminal back.
                let bells = out.parser.screen().audible_bell_count();
                if bells > out.bells {
                    read_activity.lock().unwrap().finished = Some(Finished {
                        at: now(),
                        seconds: 0,
                        kind: "bell",
                    });
                }
                out.bells = bells;
                out.end += n as u64;
                out.bytes.extend(&buf[..n]);
                let extra = out.bytes.len().saturating_sub(HISTORY);
                out.bytes.drain(..extra);
                read_output.1.notify_all();
            }
            read_output.0.lock().unwrap().eof = true;
            read_output.1.notify_all();
        });
        thread::spawn(move || {
            let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
            output.0.lock().unwrap().exit = Some(code);
            output.1.notify_all();
        });
        Ok(())
    }
    fn dispatch(&mut self, v: &Value) -> Result<Value> {
        let op = field(v, "op")?;
        match op {
            "ping" => return Ok(json!({"version":1,"build":build_id()})),
            "shutdown" => {
                for tid in self.live.keys().cloned().collect::<Vec<_>>() {
                    if let Some(l) = self.live.get(&tid) {
                        if l.output.0.lock().unwrap().exit.is_none() {
                            let _ = NativeProcessProvider.terminate(
                                &**l.master.lock().unwrap(),
                                &mut **l.killer.lock().unwrap(),
                                l.pid,
                            );
                        }
                    }
                    self.live.remove(&tid);
                }
                self.save()?;
                return Ok(json!({"stopped":true}));
            }
            "acknowledge" => {
                if let Some(l) = self.live.get(field(v, "id")?) {
                    l.activity.lock().unwrap().finished = None;
                }
                return Ok(self.snapshot());
            }
            "listShells" => return Ok(json!(platform::available_shells(&self.config.shell))),
            "snapshot" => return Ok(self.snapshot()),
            "listSessions" => {
                return Ok(json!(self
                    .state
                    .sessions
                    .iter()
                    .filter(|s| v["workspaceId"]
                        .as_str()
                        .is_none_or(|w| w == s.workspace_id))
                    .collect::<Vec<_>>()))
            }
            "listTerminals" => {
                return Ok(json!(self
                    .state
                    .terminals
                    .iter()
                    .filter(|t| v["sessionId"].as_str().is_none_or(|s| s == t.session_id))
                    .collect::<Vec<_>>()))
            }
            "getTerminalStatus" => {
                let tid = field(v, "id")?;
                return self.snapshot()["statuses"]
                    .get(tid)
                    .cloned()
                    .context("Terminal not found");
            }
            "startProcess" => {
                let tid = field(v, "id")?;
                let program = field(v, "program")?;
                let args: Vec<String> =
                    serde_json::from_value(v.get("args").cloned().unwrap_or(json!([])))?;
                self.start(tid, Some((program, args)))?;
            }
            "createWorkspace" => {
                let name = name(v)?;
                let wid = id();
                self.state.workspaces.push(Workspace {
                    id: wid.clone(),
                    name,
                    color: None,
                });
                self.state.selected_workspace = Some(wid);
                self.state.selected_session = None;
                self.state.selected_terminal = None;
            }
            "deleteWorkspace" => {
                let wid = field(v, "id")?.to_string();
                if !self.state.workspaces.iter().any(|w| w.id == wid) {
                    bail!("Workspace not found");
                }
                let sessions: Vec<String> = self
                    .state
                    .sessions
                    .iter()
                    .filter(|s| s.workspace_id == wid)
                    .map(|s| s.id.clone())
                    .collect();
                let terminals: Vec<String> = self
                    .state
                    .terminals
                    .iter()
                    .filter(|t| sessions.contains(&t.session_id))
                    .map(|t| t.id.clone())
                    .collect();
                // Best effort: a process that refuses to die must not leave the workspace half deleted.
                for tid in &terminals {
                    if let Some(l) = self.live.get(tid) {
                        if l.output.0.lock().unwrap().exit.is_none() {
                            let _ = NativeProcessProvider.terminate(
                                &**l.master.lock().unwrap(),
                                &mut **l.killer.lock().unwrap(),
                                l.pid,
                            );
                        }
                    }
                    self.live.remove(tid);
                }
                self.state.terminals.retain(|t| !terminals.contains(&t.id));
                self.state.sessions.retain(|s| s.workspace_id != wid);
                self.state.workspaces.retain(|w| w.id != wid);
                self.state.workspace_sessions.remove(&wid);
                for sid in &sessions {
                    self.state.session_terminals.remove(sid);
                }
                if self
                    .state
                    .selected_workspace
                    .as_deref()
                    .is_some_and(|w| w == wid)
                {
                    let next = self.state.workspaces.first().map(|w| w.id.clone());
                    let session = next.as_ref().and_then(|w| {
                        self.state
                            .workspace_sessions
                            .get(w)
                            .cloned()
                            .filter(|s| self.state.sessions.iter().any(|x| &x.id == s))
                            .or_else(|| {
                                self.state
                                    .sessions
                                    .iter()
                                    .find(|s| &s.workspace_id == w)
                                    .map(|s| s.id.clone())
                            })
                    });
                    let terminal = session.as_ref().and_then(|s| {
                        self.state
                            .session_terminals
                            .get(s)
                            .cloned()
                            .filter(|t| self.state.terminals.iter().any(|x| &x.id == t))
                            .or_else(|| {
                                self.state
                                    .terminals
                                    .iter()
                                    .find(|t| &t.session_id == s)
                                    .map(|t| t.id.clone())
                            })
                    });
                    self.state.selected_workspace = next;
                    self.state.selected_session = session;
                    self.state.selected_terminal = terminal;
                } else {
                    if self
                        .state
                        .selected_session
                        .as_ref()
                        .is_some_and(|s| sessions.contains(s))
                    {
                        self.state.selected_session = None;
                    }
                    if self
                        .state
                        .selected_terminal
                        .as_ref()
                        .is_some_and(|t| terminals.contains(t))
                    {
                        self.state.selected_terminal = None;
                    }
                }
            }
            "deleteSession" => {
                let sid = field(v, "id")?.to_string();
                let wid = self
                    .state
                    .sessions
                    .iter()
                    .find(|s| s.id == sid)
                    .context("Session not found")?
                    .workspace_id
                    .clone();
                let terminals: Vec<String> = self
                    .state
                    .terminals
                    .iter()
                    .filter(|t| t.session_id == sid)
                    .map(|t| t.id.clone())
                    .collect();
                // Best effort: a process that refuses to die must not leave the session half deleted.
                for tid in &terminals {
                    if let Some(l) = self.live.get(tid) {
                        if l.output.0.lock().unwrap().exit.is_none() {
                            let _ = NativeProcessProvider.terminate(
                                &**l.master.lock().unwrap(),
                                &mut **l.killer.lock().unwrap(),
                                l.pid,
                            );
                        }
                    }
                    self.live.remove(tid);
                }
                self.state.terminals.retain(|t| t.session_id != sid);
                self.state.sessions.retain(|s| s.id != sid);
                self.state.session_terminals.remove(&sid);
                if self.state.workspace_sessions.get(&wid) == Some(&sid) {
                    self.state.workspace_sessions.remove(&wid);
                }
                if self.state.selected_session.as_deref() == Some(sid.as_str()) {
                    let next = self
                        .state
                        .sessions
                        .iter()
                        .find(|s| s.workspace_id == wid)
                        .map(|s| s.id.clone());
                    let terminal = next.as_ref().and_then(|s| {
                        self.state
                            .session_terminals
                            .get(s)
                            .cloned()
                            .filter(|t| self.state.terminals.iter().any(|x| &x.id == t))
                            .or_else(|| {
                                self.state
                                    .terminals
                                    .iter()
                                    .find(|t| &t.session_id == s)
                                    .map(|t| t.id.clone())
                            })
                    });
                    if let Some(next) = &next {
                        self.state
                            .workspace_sessions
                            .insert(wid.clone(), next.clone());
                    }
                    self.state.selected_session = next;
                    self.state.selected_terminal = terminal;
                } else if self
                    .state
                    .selected_terminal
                    .as_ref()
                    .is_some_and(|t| terminals.contains(t))
                {
                    self.state.selected_terminal = None;
                }
            }
            "createSession" => {
                let wid = field(v, "workspaceId")?.to_string();
                if !self.state.workspaces.iter().any(|w| w.id == wid) {
                    bail!("Workspace not found");
                }
                let name = name(v)?;
                let repo = NativePathProvider.directory(v["path"].as_str().unwrap_or("~"))?;
                let mode = v["mode"].as_str().unwrap_or("none");
                let cwd = if mode == "create" {
                    let dest = field(v, "worktreePath")?;
                    git::create(
                        &repo,
                        dest,
                        field(v, "branch")?,
                        v["newBranch"].as_bool().unwrap_or(true),
                    )?;
                    NativePathProvider.directory(dest)?
                } else if mode == "existing" {
                    let dest = NativePathProvider.directory(field(v, "worktreePath")?)?;
                    let info = git::inspect(&repo)?;
                    if !info["worktrees"].as_array().unwrap().iter().any(|w| {
                        NativePathProvider
                            .directory(w["path"].as_str().unwrap_or(""))
                            .ok()
                            .as_ref()
                            == Some(&dest)
                    }) {
                        bail!("Selected worktree does not belong to this repository");
                    }
                    dest
                } else {
                    repo.clone()
                };
                let info = git::inspect(&cwd).ok();
                let sid = id();
                self.state.sessions.push(Session {
                    id: sid.clone(),
                    workspace_id: wid.clone(),
                    name,
                    repository: info
                        .as_ref()
                        .and_then(|i| i["root"].as_str().map(String::from)),
                    branch: info
                        .as_ref()
                        .and_then(|i| i["branch"].as_str().map(String::from)),
                    worktree: if mode == "none" {
                        None
                    } else {
                        Some(cwd.to_string_lossy().into())
                    },
                    cwd: cwd.to_string_lossy().into(),
                    created_at: now(),
                    updated_at: now(),
                    layout: SessionLayout::default(),
                });
                self.state.selected_workspace = Some(wid.clone());
                self.state
                    .workspace_sessions
                    .insert(wid.clone(), sid.clone());
                self.state.selected_session = Some(sid);
                self.state.selected_terminal = None;
            }
            "createTerminal" => {
                let sid = field(v, "sessionId")?.to_owned();
                if !self.state.sessions.iter().any(|s| s.id == sid) {
                    bail!("Session not found");
                }
                let tid = id();
                self.state.terminals.push(TerminalMeta {
                    id: tid.clone(),
                    session_id: sid.clone(),
                    name: v["name"].as_str().unwrap_or("Shell").into(),
                    color: None,
                });
                if v["launch"].as_bool().unwrap_or(true) {
                    if let Err(e) = self.start(&tid, None) {
                        self.state.terminals.retain(|t| t.id != tid);
                        return Err(e);
                    }
                }
                self.state.session_terminals.insert(sid, tid.clone());
                self.state.selected_terminal = Some(tid);
            }
            "restartTerminal" => {
                let tid = field(v, "id")?;
                if let Some(l) = self.live.get(tid) {
                    if l.output.0.lock().unwrap().exit.is_none() {
                        NativeProcessProvider.terminate(
                            &**l.master.lock().unwrap(),
                            &mut **l.killer.lock().unwrap(),
                            l.pid,
                        )?;
                        let (lock, notify) = &*l.output;
                        let output = lock.lock().unwrap();
                        let (output, _) = notify
                            .wait_timeout_while(output, Duration::from_secs(3), |o| {
                                o.exit.is_none()
                            })
                            .unwrap();
                        if output.exit.is_none() {
                            bail!("Process did not exit after hangup; stop it from the terminal before restarting");
                        }
                    }
                }
                self.start(tid, None)?;
            }
            "closeTerminal" => {
                let tid = field(v, "id")?;
                if let Some(l) = self.live.get(tid) {
                    if l.output.0.lock().unwrap().exit.is_none() {
                        // Best effort: the process may exit between that check and this
                        // signal, and a terminal must never be left half closed.
                        let _ = NativeProcessProvider.terminate(
                            &**l.master.lock().unwrap(),
                            &mut **l.killer.lock().unwrap(),
                            l.pid,
                        );
                    }
                }
                self.live.remove(tid);
                let sid = self
                    .state
                    .terminals
                    .iter()
                    .find(|t| t.id == tid)
                    .map(|t| t.session_id.clone());
                self.state.terminals.retain(|t| t.id != tid);
                if let Some(sid) = sid {
                    let root = self
                        .state
                        .sessions
                        .iter_mut()
                        .find(|s| s.id == sid)
                        .and_then(|s| s.layout.root.take());
                    let pruned = root.and_then(|r| layout::prune(r, &|id| id != tid));
                    self.apply_layout(&sid, pruned)?;
                }
                if self.state.selected_terminal.as_deref() == Some(tid) {
                    self.state.selected_terminal = None;
                }
            }
            "rename" => {
                let target = field(v, "id")?;
                let name = name(v)?;
                match field(v, "kind")? {
                    "session" => {
                        let s = self
                            .state
                            .sessions
                            .iter_mut()
                            .find(|s| s.id == target)
                            .context("Session not found")?;
                        s.name = name;
                        s.updated_at = now();
                    }
                    "terminal" => {
                        self.state
                            .terminals
                            .iter_mut()
                            .find(|t| t.id == target)
                            .context("Terminal not found")?
                            .name = name
                    }
                    "workspace" => {
                        self.state
                            .workspaces
                            .iter_mut()
                            .find(|w| w.id == target)
                            .context("Workspace not found")?
                            .name = name
                    }
                    _ => bail!("Unknown entity"),
                }
            }
            "setColor" => {
                let target = field(v, "id")?;
                let color = match v["color"].as_str() {
                    Some(c) if !crate::model::COLORS.contains(&c) => bail!("Unknown color: {c}"),
                    Some(c) => Some(c.to_string()),
                    None => None,
                };
                match field(v, "kind")? {
                    "workspace" => {
                        self.state
                            .workspaces
                            .iter_mut()
                            .find(|w| w.id == target)
                            .context("Workspace not found")?
                            .color = color
                    }
                    "terminal" => {
                        self.state
                            .terminals
                            .iter_mut()
                            .find(|t| t.id == target)
                            .context("Terminal not found")?
                            .color = color
                    }
                    _ => bail!("Unknown entity"),
                }
            }
            // Retained for clients that predate the pane tree; folds into the same tree.
            "setLayout" => {
                let sid = field(v, "sessionId")?.to_owned();
                let direction = field(v, "direction")?;
                if !["tabs", "horizontal", "vertical"].contains(&direction) {
                    bail!("Unknown terminal layout");
                }
                let ids: Vec<String> =
                    serde_json::from_value(v.get("terminalIds").cloned().unwrap_or(json!([])))?;
                self.apply_layout(&sid, layout::from_legacy(direction, &ids))?;
            }
            "setLayoutTree" => {
                let sid = field(v, "sessionId")?.to_owned();
                let root = match v.get("root") {
                    None | Some(Value::Null) => None,
                    Some(root) => Some(serde_json::from_value(root.clone())?),
                };
                self.apply_layout(&sid, root)?;
            }
            "select" => {
                let wid = field(v, "workspaceId")?;
                if !self.state.workspaces.iter().any(|w| w.id == wid) {
                    bail!("Workspace not found");
                }
                let sid = v["sessionId"].as_str();
                let tid = v["terminalId"].as_str();
                if let Some(s) = sid {
                    if !self
                        .state
                        .sessions
                        .iter()
                        .any(|x| x.id == s && x.workspace_id == wid)
                    {
                        bail!("Session belongs to another workspace");
                    }
                }
                if let Some(t) = tid {
                    if !self
                        .state
                        .terminals
                        .iter()
                        .any(|x| x.id == t && Some(x.session_id.as_str()) == sid)
                    {
                        bail!("Terminal belongs to another session");
                    }
                }
                // Point the pane showing the previously selected terminal at the new one.
                if let (Some(session_id), Some(terminal_id)) = (sid, tid) {
                    let previous = self.state.selected_terminal.clone();
                    if let Some(session) =
                        self.state.sessions.iter_mut().find(|s| s.id == session_id)
                    {
                        if let Some(root) = session.layout.root.as_mut() {
                            if !layout::leaves(root).contains(&terminal_id) {
                                layout::replace_leaf(root, previous.as_deref(), terminal_id);
                            }
                        }
                        session.layout.project();
                    }
                }
                self.state.selected_workspace = Some(wid.into());
                self.state.selected_session = sid.map(String::from);
                self.state.selected_terminal = tid.map(String::from);
                if let Some(sid) = sid {
                    self.state.workspace_sessions.insert(wid.into(), sid.into());
                    if let Some(tid) = tid {
                        self.state.session_terminals.insert(sid.into(), tid.into());
                    }
                }
            }
            "reorderTerminals" => {
                let ids = v["ids"].as_array().context("Terminal IDs required")?;
                let sid = field(v, "sessionId")?;
                let existing: Vec<_> = self
                    .state
                    .terminals
                    .iter()
                    .filter(|t| t.session_id == sid)
                    .cloned()
                    .collect();
                if ids.len() != existing.len() {
                    bail!("Invalid terminal order");
                }
                let mut ordered = Vec::new();
                for i in ids {
                    let t = existing
                        .iter()
                        .find(|t| Some(t.id.as_str()) == i.as_str())
                        .context("Invalid terminal")?;
                    if ordered.iter().any(|x: &TerminalMeta| x.id == t.id) {
                        bail!("Duplicate terminal");
                    }
                    ordered.push(t.clone());
                }
                self.state.terminals.retain(|t| t.session_id != sid);
                self.state.terminals.extend(ordered);
            }
            "configure" => {
                let cfg: Config = serde_json::from_value(v["config"].clone())?;
                if !(9..=32).contains(&cfg.font_size)
                    || !(1.0..=2.0).contains(&cfg.line_height)
                    || cfg.scrollback > 50000
                    || cfg.sound_volume > 100
                    || cfg.notify_after_seconds > 3600
                    || cfg.sound_cooldown_seconds > 3600
                    || !SOUNDS.contains(&cfg.sound_name.as_str())
                {
                    bail!("Invalid terminal settings");
                }
                self.config = cfg;
            }
            "completeDirectory" => return crate::directories::complete(field(v, "path")?),
            "inspectDirectory" => return crate::directories::inspect(field(v, "path")?),
            "inspectGit" => return git::inspect(&NativePathProvider.directory(field(v, "path")?)?),
            _ => bail!("Unknown operation: {op}"),
        }
        self.save()?;
        Ok(self.snapshot())
    }
}
/// Polls the PTY's foreground process group. Unix only: ConPTY has no equivalent, so
/// Windows terminals simply never report a finished command.
fn watch_foreground(live: Arc<Live>, activity: Arc<Mutex<Activity>>, shell: Option<u32>) {
    if !cfg!(unix) {
        return;
    }
    let busy = move |live: &Live| match (
        platform::foreground_group(&**live.master.lock().unwrap()),
        shell,
    ) {
        (Some(group), Some(shell)) => group > 0 && group as u32 != shell,
        _ => false,
    };
    // Read before this terminal can have been given any input: the shell owns the
    // terminal at that point. Waiting for the first quiet reading instead would discard
    // whatever was typed in the first fraction of a second, which on a loaded machine is
    // often the command the terminal was opened for.
    let mut settled = !busy(&live);
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(300));
        if Arc::strong_count(&live) == 1 || live.output.0.lock().unwrap().exit.is_some() {
            break;
        }
        let running = busy(&live);
        let mut activity = activity.lock().unwrap();
        if running {
            if settled && activity.busy_since.is_none() {
                activity.busy_since = Some(Instant::now());
            }
            continue;
        }
        settled = true;
        if let Some(since) = activity.busy_since.take() {
            activity.finished = Some(Finished {
                at: now(),
                // The poll interval costs the measurement up to a tick either way.
                seconds: since.elapsed().as_secs_f64().round() as u64,
                kind: "command",
            });
        }
    });
}
fn field<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key].as_str().with_context(|| format!("Missing {key}"))
}
fn name(v: &Value) -> Result<String> {
    let s = field(v, "name")?.trim();
    if s.is_empty() || s.chars().count() > 120 {
        bail!("Name must contain 1–120 characters");
    }
    Ok(s.into())
}
fn receive(s: &mut TcpStream) -> Result<Vec<u8>> {
    let mut size = [0; 4];
    s.read_exact(&mut size)?;
    let n = u32::from_be_bytes(size) as usize;
    if n > MAX_FRAME {
        bail!("Frame exceeds limit");
    }
    let mut data = vec![0; n];
    s.read_exact(&mut data)?;
    Ok(data)
}
fn send(s: &mut TcpStream, data: &[u8]) -> Result<()> {
    s.write_all(&(data.len() as u32).to_be_bytes())?;
    s.write_all(data)?;
    Ok(())
}
fn handle(mut socket: TcpStream, core: Arc<Mutex<Core>>, token: &str) -> Result<()> {
    socket.set_read_timeout(Some(Duration::from_secs(5)))?;
    socket.set_write_timeout(Some(Duration::from_secs(5)))?;
    let request: Value = serde_json::from_slice(&receive(&mut socket)?)?;
    if request["token"].as_str() != Some(token) {
        bail!("Unauthorized");
    }
    let v = &request["request"];
    let op = field(v, "op")?;
    let result: Result<Vec<u8>> = (|| {
        if matches!(op, "read" | "input" | "resize") {
            let live = core
                .lock()
                .unwrap()
                .live
                .get(field(v, "id")?)
                .cloned()
                .context("Terminal is stopped")?;
            match op {
                "input" => {
                    let bytes = field(v, "data")?.as_bytes();
                    if bytes.len() > 65536 {
                        bail!("Input exceeds 64 KiB");
                    }
                    live.writer.lock().unwrap().write_all(bytes)?;
                    return Ok(serde_json::to_vec(&json!({"ok":true}))?);
                }
                "resize" => {
                    let rows = v["rows"].as_u64().unwrap_or(30).clamp(2, 500) as u16;
                    let cols = v["cols"].as_u64().unwrap_or(100).clamp(2, 1000) as u16;
                    live.master.lock().unwrap().resize(portable_pty::PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })?;
                    live.output.0.lock().unwrap().parser.set_size(rows, cols);
                    return Ok(serde_json::to_vec(&json!({"ok":true}))?);
                }
                _ => {
                    let cursor = v["cursor"].as_u64();
                    let (lock, notify) = &*live.output;
                    let mut out = lock.lock().unwrap();
                    if cursor == Some(out.end) && !out.eof {
                        out = notify
                            .wait_timeout(out, Duration::from_millis(150))
                            .unwrap()
                            .0;
                    }
                    if let Some(reader) = v["readerId"].as_str() {
                        if reader.len() > 128
                            || (out.readers.len() >= 64 && !out.readers.contains_key(reader))
                        {
                            bail!("Too many output readers");
                        }
                        let acknowledged = cursor.unwrap_or(out.end).min(out.end);
                        out.readers
                            .insert(reader.into(), (acknowledged, Instant::now()));
                        notify.notify_all();
                    }
                    let start = out.end - out.bytes.len() as u64;
                    let reset =
                        cursor.is_none() || cursor.is_some_and(|c| c < start || c > out.end);
                    let (end, data) = if reset {
                        (out.end, out.parser.screen().state_formatted())
                    } else {
                        let from = cursor.unwrap();
                        let n = ((out.end - from) as usize).min(32768);
                        (
                            from + n as u64,
                            out.bytes
                                .iter()
                                .skip((from - start) as usize)
                                .take(n)
                                .copied()
                                .collect(),
                        )
                    };
                    let mut bytes = Vec::with_capacity(data.len() + 10);
                    bytes.extend(end.to_be_bytes());
                    bytes.push(u8::from(reset));
                    bytes.push(u8::from(out.exit.is_some() && out.eof && end == out.end));
                    bytes.extend(data);
                    return Ok(bytes);
                }
            }
        }
        Ok(serde_json::to_vec(&core.lock().unwrap().dispatch(v)?)?)
    })();
    match result {
        Ok(bytes) => {
            socket.write_all(&[0])?;
            send(&mut socket, &bytes)?;
            if op == "shutdown" {
                std::process::exit(0);
            }
        }
        Err(e) => {
            socket.write_all(&[1])?;
            send(&mut socket, e.to_string().as_bytes())?;
        }
    }
    Ok(())
}
pub fn serve() -> Result<()> {
    build_id();
    let dir = data_dir()?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("daemon.lock"))?;
    lock.try_lock_exclusive()
        .context("Vessel daemon already running")?;
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let token = format!("{}{}", id(), id());
    let core = Arc::new(Mutex::new(Core::load()?));
    core.lock().unwrap().save()?;
    write_private(
        &dir.join("endpoint.json"),
        &serde_json::to_vec(
            &json!({"version":1,"port":listener.local_addr()?.port(),"token":token,"pid":std::process::id()}),
        )?,
    )?;
    for socket in listener.incoming() {
        let socket = socket?;
        let core = core.clone();
        let token = token.clone();
        thread::spawn(move || {
            let _ = handle(socket, core, &token);
        });
    }
    Ok(())
}
pub fn client_raw(request: Value) -> Result<Vec<u8>> {
    let endpoint: Value = serde_json::from_slice(
        &fs::read(data_dir()?.join("endpoint.json")).context("Vessel daemon is not running")?,
    )?;
    let port = endpoint["port"]
        .as_u64()
        .context("Invalid daemon endpoint")? as u16;
    let mut socket = TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_secs(2),
    )
    .context("Cannot connect to Vessel daemon")?;
    socket.set_read_timeout(Some(Duration::from_secs(30)))?;
    socket.set_write_timeout(Some(Duration::from_secs(5)))?;
    socket.set_nodelay(true)?;
    send(
        &mut socket,
        &serde_json::to_vec(&json!({"token":endpoint["token"],"request":request}))?,
    )?;
    let mut status = [0];
    socket.read_exact(&mut status)?;
    let bytes = receive(&mut socket)?;
    if status[0] != 0 {
        bail!("{}", String::from_utf8_lossy(&bytes));
    }
    Ok(bytes)
}
pub fn client_json(request: Value) -> Result<Value> {
    Ok(serde_json::from_slice(&client_raw(request)?)?)
}
fn daemon_pid() -> Option<u32> {
    let endpoint: Value =
        serde_json::from_slice(&fs::read(data_dir().ok()?.join("endpoint.json")).ok()?).ok()?;
    endpoint["pid"].as_u64().map(|p| p as u32)
}
fn daemon_gone() -> bool {
    for _ in 0..60 {
        if client_json(json!({"op":"ping"})).is_err() {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    false
}
pub fn ensure_daemon() -> Result<()> {
    if let Ok(pong) = client_json(json!({"op":"ping"})) {
        if pong["build"].as_str() == Some(build_id()) {
            return Ok(());
        }
        // Terminals belong to the daemon, so this ends them; the saved session survives
        // and reopens with Start terminal, exactly as after an OS restart.
        let pid = daemon_pid();
        let _ = client_json(json!({"op":"shutdown"}));
        if !daemon_gone() {
            if let Some(pid) = pid {
                platform::stop_process(pid);
            }
            if !daemon_gone() {
                bail!("A Vessel daemon from another build is still running. Quit it and reopen Vessel.");
            }
        }
    }
    let mut cmd = std::process::Command::new(std::env::current_exe()?);
    cmd.arg("--daemon")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    platform::detach_daemon(&mut cmd);
    cmd.spawn()?;
    for _ in 0..60 {
        if client_json(json!({"op":"ping"})).is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
    bail!("Daemon did not start. Run vessel-daemon to see the startup error.")
}
