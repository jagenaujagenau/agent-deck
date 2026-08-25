//! Which agent harnesses are wired into the bridge, and wiring them up.
//!
//! Detection is read natively; installing shells out to the repository's own
//! installers. Those scripts already know the hook event list, the settings
//! shapes, and the backup behaviour, and a second implementation here would be
//! a copy that silently drifts the first time one of them changes.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Serialize, Clone, Debug)]
pub struct Harness {
    pub id: String,
    pub name: String,
    /// Where its configuration lives, shown so the wiring is inspectable.
    pub config_path: String,
    pub installed: bool,
    /// False when the harness itself is not on this machine, which is a
    /// different thing from being installable and not yet installed.
    pub present: bool,
}

fn home() -> PathBuf {
    std::env::var("HOME").map(PathBuf::from).unwrap_or_default()
}

/// The repository the bridge is served from.
///
/// Taken from the installed launchd plist rather than compiled in: the plist
/// names the server directory because that is where the service runs, which
/// makes it the one place on the machine that already knows this path.
pub fn repo_root() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("AGENT_DECK_REPO") {
        return Some(PathBuf::from(explicit));
    }
    let plist = home()
        .join("Library/LaunchAgents")
        .join(format!("{}.plist", super::bridge::LABEL));
    let out = Command::new("plutil")
        .args(["-extract", "WorkingDirectory", "raw", "-o", "-"])
        .arg(&plist)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let server_dir = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim().to_string());
    // <repo>/apps/server -> <repo>
    server_dir.parent()?.parent().map(Path::to_path_buf)
}

/// Whether a settings file already routes events at the bridge's hook entry.
fn mentions_hook(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .map(|text| text.contains("integrations/runtime-hooks/index.ts"))
        .unwrap_or(false)
}

pub fn list() -> Vec<Harness> {
    let home = home();
    let claude = home.join(".claude/settings.json");
    let codex = home.join(".codex/hooks.json");
    let pi_link = home.join(".pi/agent/extensions/agent-deck");
    vec![
        Harness {
            id: "claude".into(),
            name: "Claude Code".into(),
            installed: mentions_hook(&claude),
            present: home.join(".claude").is_dir(),
            config_path: claude.to_string_lossy().into(),
        },
        Harness {
            id: "codex".into(),
            name: "Codex".into(),
            installed: mentions_hook(&codex),
            present: home.join(".codex").is_dir(),
            config_path: codex.to_string_lossy().into(),
        },
        Harness {
            id: "opencode".into(),
            name: "OpenCode".into(),
            // A plugin, like Pi - so the installed artifact is what "installed"
            // means, not a line in a settings file.
            installed: home
                .join(".config/opencode/plugins/agent-deck.js")
                .is_file(),
            present: home.join(".config/opencode").is_dir(),
            config_path: home
                .join(".config/opencode/plugins/agent-deck.js")
                .to_string_lossy()
                .into(),
        },
        Harness {
            id: "pi".into(),
            name: "Pi".into(),
            // Pi loads an extension rather than firing hooks, so the symlink
            // the installer creates is what "installed" means here.
            installed: pi_link.symlink_metadata().is_ok(),
            present: home.join(".pi/agent").is_dir(),
            config_path: pi_link.to_string_lossy().into(),
        },
    ]
}

fn installer_for(id: &str) -> Option<&'static str> {
    match id {
        "claude" | "codex" => Some("integrations/runtime-hooks/install.ts"),
        "opencode" => Some("integrations/opencode/install.ts"),
        "pi" => Some("integrations/pi/install.ts"),
        _ => None,
    }
}

pub fn install(id: &str) -> Result<String, String> {
    let script = installer_for(id).ok_or_else(|| format!("Unknown harness: {id}"))?;
    let root = repo_root().ok_or("Cannot find the Agent Deck repository this bridge runs from")?;
    let mut command = Command::new("bun");
    command.arg("run").arg(root.join(script)).current_dir(&root);
    // The runtime-hooks installer writes both harnesses unless told which.
    if script.contains("runtime-hooks") {
        command.arg(id);
    }
    let out = command
        .output()
        .map_err(|error| format!("Could not run bun: {error}"))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
    }
    Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
}
