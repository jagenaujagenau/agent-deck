//! Reading and steering the launchd jobs Agent Deck runs.
//!
//! Deliberately native rather than shelling out to `scripts/agent-deck-service.ts`
//! for reads: the tray polls this every few seconds, and paying a Bun start-up
//! per poll to learn two facts is not a trade worth making. Writes do shell
//! out, because installing the service means writing a plist and that logic
//! should exist once.

use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

/// The bridge's label, still named here because the repository path is read
/// from its plist.
pub const LABEL: &str = "dev.agentdeck.bridge";
const HEALTH_URL: &str = "http://127.0.0.1:3000/";
/// What the bridge calls itself. Anything else on the port is somebody else.
const BRIDGE_NAME: &str = "agent-deck-bridge";

/// One background job, described the same way `scripts/agent-deck-service.ts`
/// describes it. Kept in step by hand for now; the script is the source of the
/// plists, this is only how they are read back.
pub struct ServiceDefinition {
    pub name: &'static str,
    pub label: &'static str,
    pub summary: &'static str,
    /// Whether the job answers for itself beyond holding a pid.
    pub answers: bool,
}

pub const SERVICES: [ServiceDefinition; 2] = [
    ServiceDefinition {
        name: "bridge",
        label: "dev.agentdeck.bridge",
        summary: "Serves the phone, watch and adapters",
        answers: true,
    },
    ServiceDefinition {
        name: "herdr",
        label: "dev.agentdeck.herdr",
        summary: "Reports terminal prompts the hooks cannot see",
        answers: false,
    },
];

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
pub struct ServiceStatus {
    pub name: String,
    pub summary: String,
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
fn service_target(label: &str) -> String {
    format!("gui/{}/{}", uid(), label)
}

fn plist_path_for(label: &str) -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
        .join("Library/LaunchAgents")
        .join(format!("{label}.plist"))
}

fn field<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    text.lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix(key)?.split_whitespace().next())
}

/// Reads one job. `None` for `answered` means the job has nothing to answer on,
/// which is not the same as answering badly.
pub fn status_of(definition: &ServiceDefinition) -> ServiceStatus {
    let target = service_target(definition.label);
    let printed = Command::new("launchctl").arg("print").arg(&target).output();
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
    let mut port_taken_by_other = false;
    let answered = if definition.answers {
        match ureq::get(HEALTH_URL)
            .timeout(std::time::Duration::from_millis(1500))
            .call()
        {
            Ok(response) => match response.into_json::<serde_json::Value>() {
                Ok(body) if body.get("name").and_then(|v| v.as_str()) == Some(BRIDGE_NAME) => {
                    version = body
                        .get("version")
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                    Some(true)
                }
                // Something is serving the port and it is not the bridge. Worth
                // saying: it is the reason a start will appear to fail.
                _ => {
                    port_taken_by_other = true;
                    Some(false)
                }
            },
            Err(_) => Some(false),
        }
    } else {
        None
    };

    ServiceStatus {
        name: definition.name.to_string(),
        summary: definition.summary.to_string(),
        health: classify(
            plist_path_for(definition.label).is_file(),
            loaded,
            pid.is_some(),
            answered,
        ),
        pid,
        last_exit_code,
        version,
        port_taken_by_other,
    }
}

pub fn statuses() -> Vec<ServiceStatus> {
    SERVICES.iter().map(status_of).collect()
}

/// The single state a menu bar has room for: the worst any job is in.
///
/// Aggregated rather than showing only the bridge, because a Herdr bridge that
/// has quietly stopped is exactly the kind of thing this app exists to notice -
/// it was dormant for a week without anything saying so.
pub fn worst(statuses: &[ServiceStatus]) -> Health {
    let rank = |health: &Health| match health {
        Health::Failing => 0,
        Health::NotInstalled => 1,
        Health::Stopped => 2,
        Health::Starting => 3,
        Health::Serving => 4,
    };
    statuses
        .iter()
        .map(|entry| entry.health.clone())
        .min_by_key(rank)
        .unwrap_or(Health::NotInstalled)
}

/// What the observable facts add up to.
///
/// The case that motivated separating this out is a held job with no pid while
/// the port still answers as the bridge. That is not health - it is a crash
/// loop beside a stray process holding the port, which is exactly the state
/// this machine was in while reporting healthy through 3,691 failed launches.
/// A service with no pid is failing whatever the port says.
///
/// `installed` is the plist on disk, which separates a service someone stopped
/// from one that was never set up. `answered` is `None` for a job with nothing
/// to answer on, where holding a pid is the whole claim available.
pub fn classify(installed: bool, loaded: bool, has_pid: bool, answered: Option<bool>) -> Health {
    match (installed, loaded, has_pid, answered) {
        (_, true, true, Some(true) | None) => Health::Serving,
        (_, true, true, Some(false)) => Health::Starting,
        (_, true, false, _) => Health::Failing,
        (true, false, _, _) => Health::Stopped,
        (false, false, _, _) => Health::NotInstalled,
    }
}

/// Runs launchctl, returning its stderr as the error so a refusal explains
/// itself rather than arriving as a bare exit code.
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

fn definition(name: &str) -> Result<&'static ServiceDefinition, String> {
    SERVICES
        .iter()
        .find(|entry| entry.name == name)
        .ok_or_else(|| format!("Unknown service: {name}"))
}

/// Loads the job, or kicks it if launchd already holds it.
///
/// Bootstrap is attempted first and kickstart is the fallback, rather than
/// asking which state we are in and branching. Asking loses a race: `bootout`
/// returns before launchd has finished unloading, so a start right after a stop
/// still sees the job held, takes the kickstart path, and kicks a job that is
/// on its way out - reporting success while the service stays down.
pub fn start(name: &str) -> Result<(), String> {
    let definition = definition(name)?;
    let plist = plist_path_for(definition.label);
    if !plist.is_file() {
        return Err("No service installed. Run: bun scripts/agent-deck-service.ts install".into());
    }
    if launchctl(&[
        "bootstrap",
        &format!("gui/{}", uid()),
        &plist.to_string_lossy(),
    ])
    .is_ok()
    {
        return Ok(());
    }
    launchctl(&["kickstart", &service_target(definition.label)])
}

/// Unloads the job.
///
/// Not a signal. `kill SIGTERM` left the bridge running with its listener gone,
/// and any exit clean enough to stick would be undone by KeepAlive. Unloading
/// is the only stop that stays stopped, and the plist survives, so this is
/// reversible from the same menu.
pub fn stop(name: &str) -> Result<(), String> {
    launchctl(&["bootout", &service_target(definition(name)?.label)])
}

pub fn restart(name: &str) -> Result<(), String> {
    launchctl(&["kickstart", "-k", &service_target(definition(name)?.label)])
}

/// Where the bridge's service definition lives. Written by
/// `scripts/agent-deck-service.ts`, and read here for the repository path.
pub fn plist_path() -> PathBuf {
    plist_path_for(LABEL)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(name: &str, health: Health) -> ServiceStatus {
        ServiceStatus {
            name: name.into(),
            summary: String::new(),
            health,
            pid: None,
            last_exit_code: None,
            version: None,
            port_taken_by_other: false,
        }
    }

    #[test]
    fn a_running_service_answering_as_itself_is_serving() {
        assert_eq!(classify(true, true, true, Some(true)), Health::Serving);
    }

    #[test]
    fn a_job_with_nothing_to_answer_on_is_serving_once_it_has_a_pid() {
        // The Herdr bridge works in bursts and listens on nothing. A held pid is
        // the whole claim available, and demanding more would report a healthy
        // service as broken forever.
        assert_eq!(classify(true, true, true, None), Health::Serving);
    }

    #[test]
    fn a_pid_without_an_answer_yet_is_still_starting() {
        assert_eq!(classify(true, true, true, Some(false)), Health::Starting);
    }

    #[test]
    fn a_held_job_with_no_pid_is_failing_even_when_the_port_answers() {
        // The 3,691-launch case: something else was holding the port.
        assert_eq!(classify(true, true, false, Some(true)), Health::Failing);
        assert_eq!(classify(true, true, false, None), Health::Failing);
    }

    #[test]
    fn an_unloaded_job_whose_plist_remains_is_merely_stopped() {
        assert_eq!(classify(true, false, false, None), Health::Stopped);
    }

    #[test]
    fn a_job_with_no_plist_at_all_is_not_installed() {
        assert_eq!(classify(false, false, false, None), Health::NotInstalled);
    }

    #[test]
    fn the_tray_shows_the_worst_job_not_the_first() {
        // A healthy bridge must not hide a Herdr bridge that has stopped -
        // being dormant without anything saying so is the bug this app is for.
        let statuses = [at("bridge", Health::Serving), at("herdr", Health::Failing)];
        assert_eq!(worst(&statuses), Health::Failing);
    }

    #[test]
    fn everything_serving_reads_as_serving() {
        let statuses = [at("bridge", Health::Serving), at("herdr", Health::Serving)];
        assert_eq!(worst(&statuses), Health::Serving);
    }

    #[test]
    fn a_stopped_job_outranks_a_starting_one() {
        let statuses = [at("bridge", Health::Starting), at("herdr", Health::Stopped)];
        assert_eq!(worst(&statuses), Health::Stopped);
    }

    #[test]
    fn reads_pid_and_exit_code_out_of_launchctl_output() {
        let printed = "\tstate = running\n\tpid = 60617\n\tlast exit code = 0\n";
        assert_eq!(field(printed, "pid ="), Some("60617"));
        assert_eq!(field(printed, "last exit code ="), Some("0"));
        assert_eq!(field(printed, "absent ="), None);
    }

    #[test]
    fn every_defined_service_is_addressable_by_name() {
        for definition in SERVICES.iter() {
            assert!(super::definition(definition.name).is_ok());
        }
        assert!(super::definition("nonexistent").is_err());
    }
}
