use serde_json::{json, Value};
use std::{
    process::{Child, Command},
    thread,
    time::{Duration, Instant},
};
use vessel_core::{client_json as rpc, client_raw};
struct Daemon(Child);
impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn start() -> Daemon {
    let d = Daemon(
        Command::new(env!("CARGO_BIN_EXE_vessel-daemon"))
            .spawn()
            .unwrap(),
    );
    let start = Instant::now();
    while rpc(json!({"op":"ping"})).is_err() {
        assert!(start.elapsed() < Duration::from_secs(10));
        thread::sleep(Duration::from_millis(30));
    }
    d
}
fn request(v: Value) -> Value {
    rpc(v).unwrap()
}
fn status(tid: &str) -> String {
    rpc(json!({"op":"getTerminalStatus","id":tid}))
        .map(|v| v.to_string())
        .unwrap_or_else(|e| e.to_string())
}
/// Sends `data` and waits for `needle`, resending while nothing comes back. A terminal
/// that has only just been created may still be attaching its shell to the PTY, and input
/// written before that can be dropped rather than queued.
fn run(tid: &str, data: &str, needle: &str, cursor: &mut Option<u64>) -> String {
    let start = Instant::now();
    let mut text = String::new();
    let mut sent: Option<Instant> = None;
    while !text.contains(needle) {
        if sent.is_none_or(|t| t.elapsed() >= Duration::from_secs(2)) {
            request(json!({"op":"input","id":tid,"data":data}));
            sent = Some(Instant::now());
        }
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "Missing {needle}: status {} text {text}",
            status(tid)
        );
        let bytes = client_raw(json!({"op":"read","id":tid,"cursor":cursor})).unwrap();
        *cursor = Some(u64::from_be_bytes(bytes[..8].try_into().unwrap()));
        text.push_str(&String::from_utf8_lossy(&bytes[10..]));
    }
    text
}
fn collect(tid: &str, needle: &str, cursor: &mut Option<u64>) -> String {
    let start = Instant::now();
    let mut text = String::new();
    while !text.contains(needle) {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "Missing {needle}: status {} text {text}",
            status(tid)
        );
        let bytes = client_raw(json!({"op":"read","id":tid,"cursor":cursor})).unwrap();
        *cursor = Some(u64::from_be_bytes(bytes[..8].try_into().unwrap()));
        text.push_str(&String::from_utf8_lossy(&bytes[10..]));
    }
    text
}
#[test]
fn real_pty_lifecycle_isolation_and_persistence() {
    let temp = tempfile::tempdir().unwrap();
    std::env::set_var("VESSEL_DATA_DIR", temp.path().join("config"));
    std::env::set_var("VESSEL_TEST_SECRET", "must-not-leak");
    let daemon = start();
    let snapshot = request(json!({"op":"createWorkspace","name":"Personal"}));
    let wid = snapshot["state"]["selectedWorkspace"].as_str().unwrap();
    let snapshot = request(
        json!({"op":"createSession","workspaceId":wid,"name":"Foundation","path":temp.path().to_str().unwrap()}),
    );
    let sid = snapshot["state"]["selectedSession"].as_str().unwrap();
    let snapshot = request(json!({"op":"createTerminal","sessionId":sid}));
    let tid = snapshot["state"]["selectedTerminal"]
        .as_str()
        .unwrap()
        .to_owned();
    request(json!({"op":"resize","id":tid,"rows":37,"cols":113}));
    let mut cursor = None;
    // A directly launched program shares the PTY plumbing with the shell but none of its
    // startup, so it says whether a silent terminal is the console or the shell.
    #[cfg(windows)]
    {
        let probe = request(json!({"op":"createTerminal","sessionId":sid,"launch":false}))["state"]
            ["selectedTerminal"]
            .as_str()
            .unwrap()
            .to_owned();
        request(
            json!({"op":"startProcess","id":probe,"program":"cmd.exe","args":["/c","echo PROBE_READY"]}),
        );
        let mut probe_cursor = None;
        collect(&probe, "PROBE_READY", &mut probe_cursor);
        request(json!({"op":"closeTerminal","id":probe}));
    }
    #[cfg(unix)] let command="printf '\\033[38;2;20;200;150mPTY_%s\\033[0m\\n' READY; stty size; printf 'secret=%s\\n' \"$VESSEL_TEST_SECRET\"\r";
    #[cfg(windows)]
    let command = "echo PTY_READY\r";
    let output = run(&tid, command, "PTY_READY", &mut cursor);
    #[cfg(unix)]
    {
        let all = if output.contains("37 113") {
            output
        } else {
            format!("{}{}", output, collect(&tid, "37 113", &mut cursor))
        };
        assert!(all.contains("37 113"));
        assert!(!all.contains("must-not-leak"));
    }
    // A fresh client attaches to the same daemon-owned process.
    let pid = snapshot["statuses"][&tid]["pid"].clone();
    thread::sleep(Duration::from_millis(100));
    let reconnect = request(json!({"op":"snapshot"}));
    assert_eq!(reconnect["statuses"][&tid]["pid"], pid);
    let screen = client_raw(json!({"op":"read","id":tid,"cursor":null})).unwrap();
    assert_eq!(screen[8], 1);
    assert!(String::from_utf8_lossy(&screen[10..]).contains("PTY_READY"));
    #[cfg(unix)]
    {
        // Full-screen editor, keyboard input, alternate screen and return to shell.
        request(
            json!({"op":"input","id":tid,"data":"vim -Nu NONE -i NONE vessel-editor-test.txt\r"}),
        );
        thread::sleep(Duration::from_millis(600));
        request(json!({"op":"input","id":tid,"data":"iVessel editor compatibility\u{1b}:wq\r"}));
        let deadline = Instant::now();
        while !temp.path().join("vessel-editor-test.txt").exists() {
            assert!(deadline.elapsed() < Duration::from_secs(10));
            thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(
            std::fs::read_to_string(temp.path().join("vessel-editor-test.txt")).unwrap(),
            "Vessel editor compatibility\n"
        );
        // A foreground command that runs and then hands the terminal back to the shell is
        // a command that finished, read from the PTY's foreground process group. A fresh
        // terminal keeps this clear of the editor the previous lines were driving.
        let watched = request(json!({"op":"createTerminal","sessionId":sid}))["state"]
            ["selectedTerminal"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut watched_cursor = None;
        // Job control is what hands the terminal to a command and takes it back, and every
        // interactive shell enables it. Asking for it explicitly keeps the test from
        // depending on which shell the machine happens to provide.
        run(
            &watched,
            "set -m; printf 'VESSEL_%s\\n' IDLE\r",
            "VESSEL_IDLE",
            &mut watched_cursor,
        );
        let mut config = request(json!({"op":"snapshot"}))["config"].clone();
        config["notifyAfterSeconds"] = json!(1);
        request(json!({"op":"configure","config":config.clone()}));
        request(json!({"op":"acknowledge","id":watched}));
        request(json!({"op":"input","id":watched,"data":"sleep 2\r"}));
        let deadline = Instant::now();
        let attention = loop {
            let snapshot = request(json!({"op":"snapshot"}));
            let attention = snapshot["statuses"][&watched]["attention"].clone();
            if !attention.is_null() {
                break attention;
            }
            if deadline.elapsed() >= Duration::from_secs(20) {
                let screen = client_raw(json!({"op":"read","id":watched,"cursor":null})).unwrap();
                panic!(
                    "a finished command raised no attention\nstatus: {}\nconfig: {}\nscreen: {}",
                    snapshot["statuses"][&watched],
                    snapshot["config"],
                    String::from_utf8_lossy(&screen[10..])
                );
            }
            thread::sleep(Duration::from_millis(200));
        };
        assert!(attention["seconds"].as_u64().unwrap() >= 1);
        let acknowledged = request(json!({"op":"acknowledge","id":watched}));
        assert!(acknowledged["statuses"][&watched]["attention"].is_null());
        // Commands shorter than the threshold never interrupt.
        config["notifyAfterSeconds"] = json!(3600);
        request(json!({"op":"configure","config":config.clone()}));
        request(json!({"op":"input","id":watched,"data":"sleep 2\r"}));
        thread::sleep(Duration::from_secs(4));
        assert!(request(json!({"op":"snapshot"}))["statuses"][&watched]["attention"].is_null());
        // The bell is an explicit request for attention, so the duration threshold, still
        // at an hour here, has no say over it. A long-lived TUI has nothing else to send.
        request(json!({"op":"input","id":watched,"data":"printf '\\a'\r"}));
        let deadline = Instant::now();
        let bell = loop {
            let attention =
                request(json!({"op":"snapshot"}))["statuses"][&watched]["attention"].clone();
            if !attention.is_null() {
                break attention;
            }
            assert!(
                deadline.elapsed() < Duration::from_secs(10),
                "a terminal bell raised no attention"
            );
            thread::sleep(Duration::from_millis(100));
        };
        assert_eq!(bell["kind"], "bell");
        request(json!({"op":"acknowledge","id":watched}));
        // Turning the bell off silences it without touching finished commands.
        config["notifyOnBell"] = json!(false);
        request(json!({"op":"configure","config":config.clone()}));
        request(json!({"op":"input","id":watched,"data":"printf '\\a'\r"}));
        thread::sleep(Duration::from_secs(1));
        assert!(request(json!({"op":"snapshot"}))["statuses"][&watched]["attention"].is_null());
        config["notifyOnBell"] = json!(true);
        config["notifyAfterSeconds"] = json!(5);
        config["soundName"] = json!("Gong");
        assert!(rpc(json!({"op":"configure","config":config.clone()})).is_err());
        config["soundName"] = json!("Ping");
        config["soundVolume"] = json!(140);
        assert!(rpc(json!({"op":"configure","config":config.clone()})).is_err());
        config["soundVolume"] = json!(40);
        config["soundCooldownSeconds"] = json!(7200);
        assert!(rpc(json!({"op":"configure","config":config.clone()})).is_err());
        config["soundCooldownSeconds"] = json!(45);
        let saved = request(json!({"op":"configure","config":config}));
        assert_eq!(saved["config"]["soundName"], "Ping");
        assert_eq!(saved["config"]["soundVolume"], 40);
        assert_eq!(saved["config"]["soundCooldownSeconds"], 45);
        request(json!({"op":"closeTerminal","id":watched}));
        // Direct argv launch avoids shell echo when asserting exact output sequences.
        let created = request(json!({"op":"createTerminal","sessionId":sid,"launch":false}));
        let ansi_id = created["state"]["selectedTerminal"].as_str().unwrap();
        request(
            json!({"op":"startProcess","id":ansi_id,"program":"/bin/sh","args":["-c","printf '\\033[?1049h\\033[2J\\033[38;2;20;200;150mSCREEN_界\\033[0m'; sleep 1; printf '\\033[?1049lFINISHED' "]}),
        );
        let mut ansi_cursor = Some(0);
        let ansi = collect(ansi_id, "SCREEN_界", &mut ansi_cursor);
        assert!(ansi.contains("\u{1b}[?1049h"));
        assert!(ansi.contains("\u{1b}[38;2;20;200;150m"));
        let attached = client_raw(json!({"op":"read","id":ansi_id,"cursor":null})).unwrap();
        assert!(String::from_utf8_lossy(&attached[10..]).contains("SCREEN_界"));
        let final_output = collect(ansi_id, "FINISHED", &mut ansi_cursor);
        assert!(final_output.contains("\u{1b}[?1049l"));
        request(json!({"op":"closeTerminal","id":ansi_id}));
    }
    let other = request(json!({"op":"createWorkspace","name":"Company"}));
    let other = other["state"]["selectedWorkspace"].as_str().unwrap();
    assert!(
        rpc(json!({"op":"select","workspaceId":other,"sessionId":sid,"terminalId":tid})).is_err()
    );
    request(json!({"op":"input","id":tid,"data":"exit\r"}));
    let deadline = Instant::now();
    loop {
        let s = request(json!({"op":"snapshot"}));
        if s["statuses"][&tid]["state"] == "exited" {
            break;
        }
        assert!(deadline.elapsed() < Duration::from_secs(10));
        thread::sleep(Duration::from_millis(30));
    }
    drop(daemon);
    let _daemon = start();
    let restored = request(json!({"op":"snapshot"}));
    assert_eq!(restored["state"]["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(restored["statuses"][&tid]["state"], "stopped");
    assert!(
        !std::fs::read_to_string(temp.path().join("config/state.json"))
            .unwrap()
            .contains("PTY_READY")
    );
    // A nested pane tree round-trips through the daemon and survives a restart.
    let second = request(json!({"op":"createTerminal","sessionId":sid}));
    let b = second["state"]["selectedTerminal"]
        .as_str()
        .unwrap()
        .to_owned();
    let third = request(json!({"op":"createTerminal","sessionId":sid}));
    let c = third["state"]["selectedTerminal"]
        .as_str()
        .unwrap()
        .to_owned();
    let tree = json!({
        "type":"split","direction":"row","children":[
            {"size":2.0,"pane":{"type":"leaf","terminalId":tid}},
            {"size":1.0,"pane":{"type":"split","direction":"column","children":[
                {"size":1.0,"pane":{"type":"leaf","terminalId":b}},
                {"size":1.0,"pane":{"type":"leaf","terminalId":c}}]}}]
    });
    let tiled = request(json!({"op":"setLayoutTree","sessionId":sid,"root":tree}));
    let stored = &tiled["state"]["sessions"][0]["layout"];
    assert_eq!(stored["root"]["children"][0]["size"], 2.0);
    assert_eq!(stored["root"]["children"][1]["pane"]["type"], "split");
    // The legacy projection keeps a downgraded client on a sane two-pane split.
    assert_eq!(stored["direction"], "vertical");
    assert_eq!(stored["terminalIds"][0], tid.as_str());
    // Closing a nested pane collapses its parent instead of leaving a one-child split.
    let closed = request(json!({"op":"closeTerminal","id":c}));
    let root = &closed["state"]["sessions"][0]["layout"]["root"];
    assert_eq!(root["children"].as_array().unwrap().len(), 2);
    assert_eq!(root["children"][1]["pane"]["terminalId"], b.as_str());
    // Malformed trees are refused rather than stored.
    let foreign = json!({"type":"split","direction":"row","children":[
        {"size":1.0,"pane":{"type":"leaf","terminalId":tid}},
        {"size":1.0,"pane":{"type":"leaf","terminalId":"not-a-terminal"}}]});
    assert!(rpc(json!({"op":"setLayoutTree","sessionId":sid,"root":foreign})).is_err());
    let duplicated = json!({"type":"split","direction":"row","children":[
        {"size":1.0,"pane":{"type":"leaf","terminalId":tid}},
        {"size":1.0,"pane":{"type":"leaf","terminalId":tid}}]});
    assert!(rpc(json!({"op":"setLayoutTree","sessionId":sid,"root":duplicated})).is_err());
    let zero = json!({"type":"split","direction":"row","children":[
        {"size":0.0,"pane":{"type":"leaf","terminalId":tid}},
        {"size":1.0,"pane":{"type":"leaf","terminalId":b}}]});
    assert!(rpc(json!({"op":"setLayoutTree","sessionId":sid,"root":zero})).is_err());
    // Deleting a session takes its terminals with it and leaves the directory on disk alone.
    let extra = request(
        json!({"op":"createSession","workspaceId":wid,"name":"Disposable","path":temp.path().to_str().unwrap()}),
    );
    let extra_sid = extra["state"]["selectedSession"]
        .as_str()
        .unwrap()
        .to_owned();
    let extra_tid = request(json!({"op":"createTerminal","sessionId":extra_sid}))["state"]
        ["selectedTerminal"]
        .as_str()
        .unwrap()
        .to_owned();
    let deleted = request(json!({"op":"deleteSession","id":extra_sid}));
    assert!(deleted["state"]["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["id"] != extra_sid.as_str()));
    assert!(deleted["state"]["terminals"]
        .as_array()
        .unwrap()
        .iter()
        .all(|t| t["sessionId"] != extra_sid.as_str()));
    assert!(deleted["state"]["sessionTerminals"]
        .get(&extra_sid)
        .is_none());
    assert!(deleted["statuses"].get(&extra_tid).is_none());
    // Selection falls back to the surviving session rather than going empty.
    assert_eq!(deleted["state"]["selectedSession"], sid);
    assert!(temp.path().exists());
    assert!(rpc(json!({"op":"deleteSession","id":extra_sid})).is_err());
    // Colors are stored per entity and only from the known palette.
    let colored = request(json!({"op":"setColor","kind":"workspace","id":wid,"color":"lilac"}));
    assert_eq!(colored["state"]["workspaces"][0]["color"], "lilac");
    let colored = request(json!({"op":"setColor","kind":"terminal","id":tid,"color":"rose"}));
    assert_eq!(colored["state"]["terminals"][0]["color"], "rose");
    let cleared = request(json!({"op":"setColor","kind":"terminal","id":tid,"color":null}));
    assert!(cleared["state"]["terminals"][0]["color"].is_null());
    assert!(rpc(json!({"op":"setColor","kind":"workspace","id":wid,"color":"#bada55"})).is_err());
    assert!(rpc(json!({"op":"setColor","kind":"session","id":sid,"color":"lilac"})).is_err());
    // Deleting a workspace takes its sessions and terminals with it and moves the selection.
    let deleted = request(json!({"op":"deleteWorkspace","id":other}));
    assert_eq!(deleted["state"]["workspaces"].as_array().unwrap().len(), 1);
    assert_eq!(deleted["state"]["selectedWorkspace"], wid);
    assert_eq!(deleted["state"]["selectedSession"], sid);
    let emptied = request(json!({"op":"deleteWorkspace","id":wid}));
    assert!(emptied["state"]["workspaces"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(emptied["state"]["sessions"].as_array().unwrap().is_empty());
    assert!(emptied["state"]["terminals"].as_array().unwrap().is_empty());
    assert!(emptied["state"]["selectedWorkspace"].is_null());
    assert!(emptied["state"]["selectedSession"].is_null());
    assert!(emptied["state"]["selectedTerminal"].is_null());
    assert!(rpc(json!({"op":"deleteWorkspace","id":wid})).is_err());
    // The build behind the daemon is reported so a new one never inherits an old daemon,
    // and shutdown answers before it goes.
    let pong = request(json!({"op":"ping"}));
    assert!(pong["build"].as_str().is_some_and(|b| b.len() == 16));
    assert_eq!(request(json!({"op":"shutdown"}))["stopped"], true);
    let start = Instant::now();
    while rpc(json!({"op":"ping"})).is_ok() {
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "daemon kept serving"
        );
        thread::sleep(Duration::from_millis(30));
    }
}
#[test]
fn git_worktrees_use_git_and_preserve_repository() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    let git = |args: &[&str]| {
        assert!(Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(args)
            .output()
            .unwrap()
            .status
            .success());
    };
    git(&["init"]);
    git(&[
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
    ]);
    let dest = temp.path().join("work tree");
    vessel_core::git::create(&repo, dest.to_str().unwrap(), "feature/vessel", true).unwrap();
    let info = vessel_core::git::inspect(&repo).unwrap();
    assert_eq!(info["worktrees"].as_array().unwrap().len(), 2);
    assert_eq!(
        vessel_core::git::inspect(&dest).unwrap()["branch"],
        "feature/vessel"
    );
    assert!(vessel_core::git::create(&repo, "relative", "bad", true).is_err());
}
