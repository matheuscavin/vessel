use serde::{Deserialize, Serialize};
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub workspaces: Vec<Workspace>,
    pub sessions: Vec<Session>,
    pub terminals: Vec<TerminalMeta>,
    pub selected_workspace: Option<String>,
    pub selected_session: Option<String>,
    pub selected_terminal: Option<String>,
    #[serde(default)]
    pub workspace_sessions: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub session_terminals: std::collections::HashMap<String, String>,
}
/// Accent tokens an entity may carry. Stored as a token so themes keep control of the actual value.
pub const COLORS: [&str; 6] = ["anchor", "lilac", "sand", "sky", "rose", "moss"];
#[derive(Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub repository: Option<String>,
    pub branch: Option<String>,
    pub worktree: Option<String>,
    pub cwd: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub layout: SessionLayout,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMeta {
    pub id: String,
    pub session_id: String,
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub theme: String,
    pub font_family: String,
    pub font_size: u16,
    pub line_height: f32,
    pub scrollback: u32,
    pub shell: String,
    pub keybindings: std::collections::BTreeMap<String, String>,
    /// Rejoin on copy the rows a program wrapped for itself. Off by default: the join is
    /// inferred, and a terminal is never told where a wrap was.
    pub copy_join_wrapped: bool,
    pub notify_enabled: bool,
    /// Long-lived TUIs never return the terminal, so the bell is the only thing they can
    /// send when a turn ends. Shells also ring it for an ambiguous completion.
    pub notify_on_bell: bool,
    /// A command shorter than this finished before you could look away from it.
    pub notify_after_seconds: u32,
    pub sound_enabled: bool,
    pub sound_name: String,
    /// One terminal ringing in a loop must not become a siren, so the wait is shared by
    /// every terminal rather than counted per terminal.
    pub sound_cooldown_seconds: u32,
    /// Percent. An integer keeps the value exact through JSON and TOML.
    pub sound_volume: u8,
}
/// Synthesized in the client, so these are names rather than files.
pub const SOUNDS: [&str; 3] = ["Chime", "Ping", "Knock"];
impl Default for Config {
    fn default() -> Self {
        Self {
            theme: "Ocean".into(),
            font_family: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace".into(),
            font_size: 14,
            line_height: 1.25,
            scrollback: 5000,
            shell: String::new(),
            keybindings: Default::default(),
            copy_join_wrapped: false,
            notify_enabled: true,
            notify_on_bell: true,
            notify_after_seconds: 5,
            sound_enabled: false,
            sound_name: "Chime".into(),
            sound_cooldown_seconds: 30,
            sound_volume: 50,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellOption {
    pub label: String,
    pub path: String,
}

/// `root` is the truth. `direction` and `terminal_ids` are a two-pane projection of it,
/// rewritten on every mutation and read only by clients older than the pane tree.
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionLayout {
    pub direction: String,
    pub terminal_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<crate::layout::Pane>,
}
impl Default for SessionLayout {
    fn default() -> Self {
        Self {
            direction: "tabs".into(),
            terminal_ids: Vec::new(),
            root: None,
        }
    }
}
impl SessionLayout {
    /// Keeps the legacy fields in step with the tree so a downgrade still shows a split.
    pub fn project(&mut self) {
        let ids: Vec<String> = self
            .root
            .as_ref()
            .map(|r| {
                crate::layout::leaves(r)
                    .iter()
                    .map(|s| s.to_string())
                    .collect()
            })
            .unwrap_or_default();
        let axis = match &self.root {
            Some(crate::layout::Pane::Split { direction, .. }) => Some(*direction),
            _ => None,
        };
        match axis {
            Some(a) if ids.len() >= 2 => {
                self.direction = if a == crate::layout::Axis::Row {
                    "vertical".into()
                } else {
                    "horizontal".into()
                };
                self.terminal_ids = ids.into_iter().take(2).collect();
            }
            _ => {
                self.direction = "tabs".into();
                self.terminal_ids = Vec::new();
            }
        }
    }
}
