//! Read-only directory suggestions for the session picker; never invokes a shell.
use crate::platform::{NativePathProvider, PathProvider};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::path::PathBuf;

pub fn complete(raw: &str) -> Result<Value> {
    let home = directories::BaseDirs::new()
        .context("Home directory unavailable")?
        .home_dir()
        .to_owned();
    let raw = if raw.is_empty() { "~/" } else { raw };
    let expanded = if raw == "~" {
        home.clone()
    } else if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        home.join(rest)
    } else {
        PathBuf::from(raw)
    };
    let trailing = raw.ends_with(std::path::MAIN_SEPARATOR) || raw.ends_with('/') || raw == "~";
    let (parent, prefix) = if trailing {
        (expanded.clone(), String::new())
    } else {
        (
            expanded.parent().unwrap_or(&expanded).to_path_buf(),
            expanded
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
        )
    };
    let display_parent = if trailing {
        format!("{}{}", raw, if raw == "~" { "/" } else { "" })
    } else {
        raw[..raw.len() - prefix.len()].to_string()
    };
    let entries = match std::fs::read_dir(&parent) {
        Ok(entries) => entries,
        Err(_) => return Ok(json!([])),
    };
    let mut suggestions = Vec::new();
    for entry in entries.take(4096).flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') && !prefix.starts_with('.') {
            continue;
        }
        let matches = if cfg!(windows) {
            name.to_lowercase().starts_with(&prefix.to_lowercase())
        } else {
            name.starts_with(&prefix)
        };
        if matches && entry.path().is_dir() {
            suggestions.push(json!({"name":name,"path":format!("{display_parent}{name}{}",std::path::MAIN_SEPARATOR)}));
        }
    }
    suggestions.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    suggestions.truncate(20);
    Ok(json!(suggestions))
}

pub fn inspect(raw: &str) -> Result<Value> {
    let path = NativePathProvider.directory(raw)?;
    Ok(json!({"path":path.to_string_lossy(),"git":crate::git::inspect(&path).ok()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn completes_only_directories_and_handles_spaces_and_unicode() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["project alpha", "project beta", "界面", ".hidden"] {
            std::fs::create_dir(dir.path().join(name)).unwrap();
        }
        std::fs::write(dir.path().join("project.txt"), "not a directory").unwrap();
        let prefix = dir.path().join("project").to_string_lossy().into_owned();
        let result = complete(&prefix).unwrap();
        assert_eq!(result.as_array().unwrap().len(), 2);
        assert_eq!(result[0]["name"], "project alpha");
        assert!(PathBuf::from(result[0]["path"].as_str().unwrap()).is_dir());
        assert_eq!(
            complete(&dir.path().join("界").to_string_lossy()).unwrap()[0]["name"],
            "界面"
        );
        assert!(complete(&dir.path().join("absent/child").to_string_lossy())
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        assert!(inspect(&dir.path().to_string_lossy()).unwrap()["git"].is_null());
        assert!(inspect(&dir.path().join("missing").to_string_lossy()).is_err());
    }
}
