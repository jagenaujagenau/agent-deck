//! Menu bar control for the Agent Deck services.

mod harness;
mod service;

use service::{Health, ServiceStatus};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

/// Everything the app reads about this machine, in one call.
///
/// Exposed so the real states - a crash-looping service, a harness that moved -
/// can be checked against the machine rather than inferred from the UI.
pub fn inspect() -> (
    Vec<ServiceStatus>,
    Vec<harness::Harness>,
    Option<std::path::PathBuf>,
) {
    (service::statuses(), harness::list(), harness::repo_root())
}

#[tauri::command]
fn service_status() -> Vec<ServiceStatus> {
    service::statuses()
}

#[tauri::command]
fn service_start(name: String) -> Result<(), String> {
    service::start(&name)
}

#[tauri::command]
fn service_stop(name: String) -> Result<(), String> {
    service::stop(&name)
}

#[tauri::command]
fn service_restart(name: String) -> Result<(), String> {
    service::restart(&name)
}

#[tauri::command]
fn harness_list() -> Vec<harness::Harness> {
    harness::list()
}

#[tauri::command]
fn harness_install(id: String) -> Result<String, String> {
    harness::install(&id)
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// One glyph per state, because a menu bar has room for exactly one.
///
/// Text rather than a coloured dot: the menu bar is monochrome under most
/// themes, and a status told only in colour is a status not told at all to
/// anyone who cannot separate the hues.
fn tray_glyph(health: &Health) -> &'static str {
    match health {
        Health::Serving => "◉",
        Health::Starting => "◍",
        Health::Failing => "◎",
        Health::Stopped => "○",
        Health::NotInstalled => "◌",
    }
}

/// One line naming what is wrong, or what is right when nothing is.
///
/// Names the service in every unhealthy case. A tray that says "failing"
/// without saying which job leaves you opening the window to find out, which is
/// what a tray exists to save you.
fn tray_summary(statuses: &[ServiceStatus]) -> String {
    let unwell: Vec<&ServiceStatus> = statuses
        .iter()
        .filter(|entry| entry.health != Health::Serving)
        .collect();
    if unwell.is_empty() {
        let version = statuses
            .iter()
            .find_map(|entry| entry.version.as_deref())
            .unwrap_or("?");
        return format!("Bridge {version} · all services running");
    }
    unwell
        .iter()
        .map(|entry| match entry.health {
            Health::Failing => match entry.last_exit_code {
                Some(code) => format!("{} failing (exit {code})", entry.name),
                None => format!("{} failing to start", entry.name),
            },
            Health::Starting => format!("{} starting", entry.name),
            Health::Stopped => format!("{} stopped", entry.name),
            Health::NotInstalled => format!("{} not installed", entry.name),
            Health::Serving => format!("{} running", entry.name),
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

/// Polls the jobs and keeps the menu bar honest about them.
///
/// The window may be closed for days at a time - that is the point of a tray
/// app - so the poll belongs here rather than in the page, which only exists
/// while someone is looking at it.
fn watch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut previous: Option<String> = None;
        loop {
            let statuses = service::statuses();
            let title = format!("{} ", tray_glyph(&service::worst(&statuses)));
            let tooltip = tray_summary(&statuses);
            if let Some(tray) = app.tray_by_id("main") {
                let _ = tray.set_title(Some(&title));
                let _ = tray.set_tooltip(Some(&tooltip));
            }
            // Only wake the window when something actually changed: a page that
            // re-renders every two seconds is a page that cannot be read.
            let pids: Vec<Option<u32>> = statuses.iter().map(|entry| entry.pid).collect();
            let fingerprint = format!("{tooltip}{pids:?}");
            if previous.as_deref() != Some(fingerprint.as_str()) {
                previous = Some(fingerprint);
                let _ = app.emit("service-status", &statuses);
            }
            tokio_sleep(Duration::from_secs(2)).await;
        }
    });
}

async fn tokio_sleep(duration: Duration) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration))
        .await
        .ok();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            service_status,
            service_start,
            service_stop,
            service_restart,
            harness_list,
            harness_install,
            app_version
        ])
        .setup(|app| {
            // A menu bar app with a dock icon is two ways to reach one window.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let open = MenuItem::with_id(app, "open", "Open Agent Deck", true, None::<&str>)?;
            let restart =
                MenuItem::with_id(app, "restart", "Restart services", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&open, &restart, &separator, &quit])?;

            TrayIconBuilder::with_id("main")
                .menu(&menu)
                .icon_as_template(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "restart" => {
                        // Everything, because a menu item that silently restarted
                        // only the bridge would be the wrong half of the fix.
                        for definition in service::SERVICES.iter() {
                            let _ = service::restart(definition.name);
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Starts hidden: a menu bar app that seizes the screen on login is
            // a menu bar app people quit.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
            watch(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing hides rather than exits, so the tray survives the window.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Agent Deck");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(name: &str, health: Health, version: Option<&str>) -> ServiceStatus {
        ServiceStatus {
            name: name.into(),
            summary: String::new(),
            health,
            pid: None,
            last_exit_code: None,
            version: version.map(str::to_string),
            port_taken_by_other: false,
        }
    }

    #[test]
    fn all_well_reports_the_bridge_version() {
        let statuses = [
            at("bridge", Health::Serving, Some("0.1.0")),
            at("herdr", Health::Serving, None),
        ];
        assert_eq!(
            tray_summary(&statuses),
            "Bridge 0.1.0 · all services running"
        );
    }

    #[test]
    fn an_unhealthy_service_is_named() {
        // "failing" without saying which job sends you to the window to find
        // out, which is what the tray exists to save you.
        let statuses = [
            at("bridge", Health::Serving, Some("0.1.0")),
            at("herdr", Health::Stopped, None),
        ];
        assert_eq!(tray_summary(&statuses), "herdr stopped");
    }

    #[test]
    fn two_unhealthy_services_are_both_named() {
        let statuses = [
            at("bridge", Health::Failing, None),
            at("herdr", Health::Stopped, None),
        ];
        assert_eq!(
            tray_summary(&statuses),
            "bridge failing to start · herdr stopped"
        );
    }

    #[test]
    fn a_failing_service_carries_its_exit_code() {
        let mut failing = at("bridge", Health::Failing, None);
        failing.last_exit_code = Some(1);
        assert_eq!(tray_summary(&[failing]), "bridge failing (exit 1)");
    }
}
