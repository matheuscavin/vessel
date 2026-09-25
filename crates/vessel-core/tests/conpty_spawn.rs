#![cfg(windows)]
//! A pseudoconsole spawn written the way Microsoft documents it, with nothing of Vessel
//! or of the pty crate in it. Terminals there stay silent: the child is created, writes
//! nothing into the console pipe and never exits. The one difference between this and the
//! crate's spawn is whether CreateProcessW is told the application path as well as the
//! command line, so this measures exactly that.
use std::{
    ffi::c_void,
    ptr,
    sync::mpsc::channel,
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    Storage::FileSystem::ReadFile,
    System::{
        Console::{ClosePseudoConsole, CreatePseudoConsole, COORD, HPCON},
        Pipes::CreatePipe,
        Threading::{
            CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
            UpdateProcThreadAttribute, EXTENDED_STARTUPINFO_PRESENT, PROCESS_INFORMATION,
            STARTUPINFOEXW,
        },
    },
};

const NEEDLE: &str = "CONPTY_READY";
const COMMAND: &str = "cmd.exe /c echo CONPTY_READY";
const APPLICATION: &str = r"C:\Windows\System32\cmd.exe";
const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x0002_0016;

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Runs `COMMAND` on a fresh pseudoconsole and answers what reached the output pipe.
/// `application` is the `lpApplicationName` argument: `None` leaves it null, which is what
/// the documented sample does.
fn echo_through_a_pseudoconsole(application: Option<&str>) -> String {
    unsafe {
        let mut input_read: HANDLE = ptr::null_mut();
        let mut input_write: HANDLE = ptr::null_mut();
        let mut output_read: HANDLE = ptr::null_mut();
        let mut output_write: HANDLE = ptr::null_mut();
        assert!(CreatePipe(&mut input_read, &mut input_write, ptr::null(), 0) != 0);
        assert!(CreatePipe(&mut output_read, &mut output_write, ptr::null(), 0) != 0);

        let mut console: HPCON = 0;
        let size = COORD { X: 80, Y: 24 };
        let created = CreatePseudoConsole(size, input_read, output_write, 0, &mut console);
        assert_eq!(created, 0, "CreatePseudoConsole failed with {created:#x}");
        // The console holds its own copies of the ends it was given.
        CloseHandle(input_read);
        CloseHandle(output_write);

        let mut size_needed: usize = 0;
        InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut size_needed);
        let mut attributes = vec![0u8; size_needed];
        let list = attributes.as_mut_ptr() as *mut c_void;
        assert!(InitializeProcThreadAttributeList(list, 1, 0, &mut size_needed) != 0);
        assert!(
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                console as *const c_void,
                std::mem::size_of::<HPCON>(),
                ptr::null_mut(),
                ptr::null(),
            ) != 0
        );

        let mut startup: STARTUPINFOEXW = std::mem::zeroed();
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        startup.lpAttributeList = list;

        let mut process: PROCESS_INFORMATION = std::mem::zeroed();
        let mut command = wide(COMMAND);
        let mut application_name = application.map(wide);
        let spawned = CreateProcessW(
            application_name
                .as_mut()
                .map(|name| name.as_ptr())
                .unwrap_or(ptr::null()),
            command.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            0,
            EXTENDED_STARTUPINFO_PRESENT,
            ptr::null(),
            ptr::null(),
            &startup.StartupInfo,
            &mut process,
        );
        assert!(
            spawned != 0,
            "CreateProcessW failed: {}",
            std::io::Error::last_os_error()
        );

        let (tx, rx) = channel();
        // A raw handle is not Send; its numeric value is.
        let readable = output_read as usize;
        thread::spawn(move || {
            let output_read = readable as HANDLE;
            let mut text = String::new();
            let mut buf = [0u8; 1024];
            let deadline = Instant::now();
            loop {
                let mut read = 0u32;
                if ReadFile(
                    output_read,
                    buf.as_mut_ptr(),
                    buf.len() as u32,
                    &mut read,
                    ptr::null_mut(),
                ) == 0
                    || read == 0
                {
                    break;
                }
                text.push_str(&String::from_utf8_lossy(&buf[..read as usize]));
                if text.contains(NEEDLE) || deadline.elapsed() > Duration::from_secs(10) {
                    break;
                }
            }
            let _ = tx.send(text);
        });
        let text = rx.recv_timeout(Duration::from_secs(12)).unwrap_or_default();

        DeleteProcThreadAttributeList(list);
        ClosePseudoConsole(console);
        CloseHandle(input_write);
        CloseHandle(process.hProcess);
        CloseHandle(process.hThread);
        text
    }
}

#[test]
fn a_pseudoconsole_delivers_what_its_child_writes() {
    let bare = echo_through_a_pseudoconsole(None);
    let named = echo_through_a_pseudoconsole(Some(APPLICATION));
    assert!(
        bare.contains(NEEDLE) && named.contains(NEEDLE),
        "from the command line alone the pseudoconsole delivered {bare:?}, and naming the application as well delivered {named:?}"
    );
}
