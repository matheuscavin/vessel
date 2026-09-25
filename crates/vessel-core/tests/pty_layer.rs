//! The pty crate used exactly as it documents itself, with nothing of Vessel in it. When
//! terminals are silent on a platform, this separates the layer underneath from the way
//! the daemon drives it, and says whether a working directory is what breaks it.
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::{io::Read, path::PathBuf, sync::mpsc::channel, thread, time::Duration};

const NEEDLE: &str = "PTY_LAYER_READY";

fn echo_through_a_pty(cwd: Option<PathBuf>) -> String {
    let pair = NativePtySystem::default()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut command = if cfg!(windows) {
        let mut command = CommandBuilder::new("cmd.exe");
        command.args(["/c", "echo PTY_LAYER_READY"]);
        command
    } else {
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "printf 'PTY_LAYER_READY\\n'"]);
        command
    };
    if let Some(cwd) = cwd {
        command.cwd(cwd);
    }
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let _writer = pair.master.take_writer().unwrap();
    let (tx, rx) = channel();
    thread::spawn(move || {
        let mut text = String::new();
        let mut buf = [0u8; 1024];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            text.push_str(&String::from_utf8_lossy(&buf[..n]));
            if text.contains(NEEDLE) {
                break;
            }
        }
        let _ = tx.send(text);
    });
    let text = rx.recv_timeout(Duration::from_secs(15)).unwrap_or_default();
    let _ = child.kill();
    let _ = child.wait();
    text
}

#[test]
fn a_program_launched_on_a_pty_is_heard() {
    let inherited = echo_through_a_pty(None);
    assert!(
        inherited.contains(NEEDLE),
        "with the inherited directory the pty delivered {inherited:?}"
    );
    let chosen = echo_through_a_pty(Some(std::env::temp_dir()));
    assert!(
        chosen.contains(NEEDLE),
        "with a chosen directory the pty delivered {chosen:?}"
    );
}
