//! Menu bar control for the Agent Deck bridge.

mod bridge;
mod harness;

use bridge::{BridgeStatus, Health};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

/// Everything the app reads about this machine, in one call.
///
/// Exposed so the real states - a crash-looping service, a harness that moved -
/// can be checked against the machine rather than inferred from the UI.
pub fn inspect() -> (
    BridgeStatus,
    Vec<harness::Harness>,
    Option<std::path::PathBuf>,
) {
    (bridge::status(), harness::list(), harness::repo_root())
}

#[tauri::command]
fn bridge_status() -> BridgeStatus {
    bridge::status()
}

#[tauri::command]
fn bridge_start() -> Result<(), String> {
    bridge::start()
}

#[tauri::command]
fn bridge_stop() -> Result<(), String> {
    bridge::stop()
}

#[tauri::command]
fn bridge_restart() -> Result<(), String> {
    bridge::restart()
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

fn tray_summary(status: &BridgeStatus) -> String {
    match status.health {
        Health::Serving => match &status.version {
            Some(version) => format!("Bridge {version} · serving"),
            None => "Bridge serving".into(),
        },
        Health::Starting => "Bridge starting".into(),
        Health::Failing => match status.last_exit_code {
            Some(code) => format!("Bridge failing to start (exit {code})"),
            None => "Bridge failing to start".into(),
        },
        Health::Stopped => "Bridge stopped".into(),
        Health::NotInstalled => "Bridge service not installed".into(),
    }
}

/// Polls the service and keeps the menu bar honest about it.
///
/// The window may be closed for days at a time - that is the point of a tray
/// app - so the poll belongs here rather than in the page, which only exists
/// while someone is looking at it.
fn watch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut previous: Option<String> = None;
        loop {
            let status = bridge::status();
            let title = format!("{} ", tray_glyph(&status.health));
            let tooltip = tray_summary(&status);
            if let Some(tray) = app.tray_by_id("main") {
                let _ = tray.set_title(Some(&title));
                let _ = tray.set_tooltip(Some(&tooltip));
            }
            // Only wake the window when something actually changed: a page that
            // re-renders every two seconds is a page that cannot be read.
            let fingerprint = format!("{tooltip}{:?}{:?}", status.pid, status.port_taken_by_other);
            if previous.as_deref() != Some(fingerprint.as_str()) {
                previous = Some(fingerprint);
                let _ = app.emit("bridge-status", &status);
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
            bridge_status,
            bridge_start,
            bridge_stop,
            bridge_restart,
            harness_list,
            harness_install,
            app_version
        ])
        .setup(|app| {
            // A menu bar app with a dock icon is two ways to reach one window.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let open = MenuItem::with_id(app, "open", "Open Agent Deck", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "Restart bridge", true, None::<&str>)?;
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
                        let _ = bridge::restart();
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
