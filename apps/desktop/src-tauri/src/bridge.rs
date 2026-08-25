//! Reading and steering the launchd service that runs the bridge.
//!
//! Deliberately native rather than shelling out to `scripts/bridge-service.ts`
//! for reads: the tray polls this every few seconds, and paying a Bun start-up
//! per poll to learn two facts is not a trade worth making. Writes do shell
//! out, because installing the service means writing a plist and that logic
//! should exist once.

use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

pub const LABEL: &str = "dev.agentdeck.bridge";
const HEALTH_URL: &str = "http://127.0.0.1:3000/";
/// What the bridge calls itself. Anything else on the port is somebody else.
const BRIDGE_NAME: &str = "agent-deck-bridge";

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub enum Health {
    /// Running, answering, and identifying itself as the bridge.
    Serving,
    /// launchd holds the job and it has a pid, but the port says nothing useful.
    Starting,
    /// Held by launchd, no pid: it is crashing on every attempt.
    Failing,
    /// launchd does not hold the job at all.
    NotInstalled,
    /// Installed and deliberately not running.
    Stopped,
}

#[derive(Serialize, Clone, Debug)]
pub struct BridgeStatus {
    pub health: Health,
    pub pid: Option<u32>,
    pub last_exit_code: Option<i32>,
    pub version: Option<String>,
    /// Set when something answers the port that is not this bridge.
    pub port_taken_by_other: bool,
}

/// The console user's id. `id -u` rather than a libc dependency for one number.
fn uid() -> String {
    Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .unwrap_or_default()
}

/// The service name launchctl addresses this job by, in the GUI domain that
/// owns login-session agents.
fn service() -> String {
    format!("gui/{}/{}", uid(), LABEL)
}

fn field<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    text.lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix(key)?.split_whitespace().next())
}

pub fn status() -> BridgeStatus {
    let printed = Command::new("launchctl")
        .arg("print")
        .arg(service())
        .output();
    let (loaded, text) = match printed {
        Ok(out) => (
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).to_string(),
        ),
        Err(_) => (false, String::new()),
    };
    let pid = field(&text, "pid =").and_then(|v| v.parse::<u32>().ok());
    let last_exit_code = field(&text, "last exit code =").and_then(|v| v.parse::<i32>().ok());

    let mut version = None;
    let mut answered_as_bridge = false;
    let mut port_taken_by_other = false;
    if let Ok(response) = ureq::get(HEALTH_URL)
        .timeout(std::time::Duration::from_millis(1500))
        .call()
    {
        match response.into_json::<serde_json::Value>() {
            Ok(body) if body.get("name").and_then(|v| v.as_str()) == Some(BRIDGE_NAME) => {
                answered_as_bridge = true;
                version = body
                    .get("version")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
            }
            // Something is serving the port and it is not the bridge. Worth
            // saying out loud: it is the reason a start will appear to fail.
            _ => port_taken_by_other = true,
        }
    }

    BridgeStatus {
        health: classify(
            plist_path().is_file(),
            loaded,
            pid.is_some(),
            answered_as_bridge,
        ),
        pid,
        last_exit_code,
        version,
        port_taken_by_other,
    }
}

/// What the observable facts add up to.
///
/// The case that motivated separating this out is a held job with no pid while
/// the port still answers as the bridge. That is not health - it is a crash
/// loop beside a stray process holding the port, which is exactly the state
/// this machine was in while reporting healthy through 3,691 failed launches.
/// A service with no pid is failing whatever the port says.
///
/// `installed` is the plist on disk, which is what separates a service someone
/// stopped from one that was never set up. Without it a deliberate stop reads
/// as "not installed" and sends people off to run an installer they already ran.
pub fn classify(installed: bool, loaded: bool, has_pid: bool, answered_as_bridge: bool) -> Health {
    match (installed, loaded, has_pid, answered_as_bridge) {
        (_, true, true, true) => Health::Serving,
        (_, true, true, false) => Health::Starting,
        (_, true, false, _) => Health::Failing,
        (true, false, _, _) => Health::Stopped,
        (false, false, _, _) => Health::NotInstalled,
    }
}

fn launchctl(args: &[&str]) -> Result<(), String> {
    let out = Command::new("launchctl")
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
}

/// Where the service definition lives. Written by `scripts/bridge-service.ts`.
pub fn plist_path() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
        .join("Library/LaunchAgents")
        .join(format!("{LABEL}.plist"))
}

/// Loads the job, or kicks it if launchd already holds it.
///
/// Bootstrap is attempted first and kickstart is the fallback, rather than
/// asking which state we are in and branching. Asking loses a race: `bootout`
/// returns before launchd has finished unloading, so a start right after a stop
/// still sees the job held, takes the kickstart path, and kicks a job that is
/// on its way out - reporting success while the service stays down. Trying the
/// load first has no such window, because whichever call is wrong for the
/// current state simply fails and the other one runs.
pub fn start() -> Result<(), String> {
    let plist = plist_path();
    if !plist.is_file() {
        return Err("No service installed. Run: bun scripts/bridge-service.ts install".into());
    }
    let bootstrapped = launchctl(&[
        "bootstrap",
        &format!("gui/{}", uid()),
        &plist.to_string_lossy(),
    ]);
    if bootstrapped.is_ok() {
        return Ok(());
    }
    // Already loaded, which bootstrap reports as an error. Kick it instead.
    launchctl(&["kickstart", &service()])
}

/// Unloads the job.
///
/// Not a signal. `kill SIGTERM` left the process running with its listener
/// gone - a bridge that answers nothing while launchd still reports a pid -
/// and any exit clean enough to stick would be undone by KeepAlive anyway.
/// Unloading is the only stop that stays stopped. The plist survives, so this
/// is reversible from the same menu.
pub fn stop() -> Result<(), String> {
    launchctl(&["bootout", &service()])
}

pub fn restart() -> Result<(), String> {
    launchctl(&["kickstart", "-k", &service()])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_running_service_answering_as_itself_is_serving() {
        assert_eq!(classify(true, true, true, true), Health::Serving);
    }

    #[test]
    fn a_pid_without_an_answer_yet_is_still_starting() {
        assert_eq!(classify(true, true, true, false), Health::Starting);
    }

    #[test]
    fn a_held_job_with_no_pid_is_failing_even_when_the_port_answers() {
        // The 3,691-launch case: something else was holding the port.
        assert_eq!(classify(true, true, false, true), Health::Failing);
        assert_eq!(classify(true, true, false, false), Health::Failing);
    }

    #[test]
    fn an_unloaded_job_whose_plist_remains_is_merely_stopped() {
        // Stopping unloads the job and leaves the plist, so this is the state
        // the Stop button produces. It must not read as "never installed".
        assert_eq!(classify(true, false, false, false), Health::Stopped);
    }

    #[test]
    fn a_job_with_no_plist_at_all_is_not_installed() {
        assert_eq!(classify(false, false, false, false), Health::NotInstalled);
        assert_eq!(classify(false, false, false, true), Health::NotInstalled);
    }

    #[test]
    fn reads_pid_and_exit_code_out_of_launchctl_output() {
        let printed = "\tstate = running\n\tpid = 60617\n\tlast exit code = 0\n";
        assert_eq!(field(printed, "pid ="), Some("60617"));
        assert_eq!(field(printed, "last exit code ="), Some("0"));
        assert_eq!(field(printed, "absent ="), None);
    }
}
