//! Prints everything the app reads about this machine, without driving the UI.
//!
//! Exists because the interesting failures here are about the machine's real
//! state - a service that is loaded but crashing, a harness whose config moved
//! - and those are not reachable by clicking through a menu bar in a test.
fn main() {
    let (services, harnesses, root) = agent_deck_desktop_lib::inspect();
    println!("services:   {}", serde_json::to_string(&services).unwrap());
    println!(
        "repo root:  {}",
        root.map(|p| p.display().to_string())
            .unwrap_or("NOT FOUND".into())
    );
    println!("harnesses:  {}", serde_json::to_string(&harnesses).unwrap());
}
