use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::{path::Path, process::Command};
pub fn run(path: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()?;
    if !out.status.success() {
        bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(String::from_utf8(out.stdout)?.trim().into())
}
pub fn inspect(path: &Path) -> Result<Value> {
    let root = run(path, &["rev-parse", "--show-toplevel"])?;
    let branch = run(path, &["symbolic-ref", "--short", "-q", "HEAD"])
        .unwrap_or_else(|_| "detached HEAD".into());
    let branches = run(
        path,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
    )?;
    let trees = run(path, &["worktree", "list", "--porcelain"])?;
    let mut worktrees = Vec::new();
    let mut current = json!({});
    for line in trees.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            if current.get("path").is_some() {
                worktrees.push(current);
            }
            current = json!({"path":p});
        } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
            current["branch"] = json!(b);
        }
    }
    if current.get("path").is_some() {
        worktrees.push(current);
    }
    Ok(
        json!({"root":root,"branch":branch,"branches":branches.lines().collect::<Vec<_>>(),"worktrees":worktrees}),
    )
}
pub fn create(repo: &Path, path: &str, branch: &str, new_branch: bool) -> Result<()> {
    if branch.starts_with('-') || branch.trim().is_empty() {
        bail!("Invalid branch name");
    }
    run(repo, &["check-ref-format", "--branch", branch])?;
    let target = std::path::PathBuf::from(path);
    if !target.is_absolute() {
        bail!("Worktree destination must be an absolute path");
    }
    let target = target.to_string_lossy();
    if new_branch {
        run(repo, &["worktree", "add", "-b", branch, "--", &target])?;
    } else {
        run(repo, &["worktree", "add", "--", &target, branch])?;
    }
    Ok(())
}
