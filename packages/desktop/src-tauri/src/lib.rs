mod config;
mod server;
mod tray;
mod windows;

use tauri::Manager;

#[tauri::command]
fn get_config() -> Result<config::AppConfig, String> {
    Ok(config::load_config())
}

#[tauri::command]
fn save_app_config(cfg: config::AppConfig) -> Result<(), String> {
    config::save_config(&cfg)
}

#[tauri::command]
fn get_data_dir() -> String {
    config::data_dir().to_string_lossy().to_string()
}

/// Returns the dev directory path if `YEP_DEV_DIR` is set, or null otherwise.
#[tauri::command]
fn is_dev_mode() -> Option<String> {
    config::dev_dir().map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
async fn quit_app(app: tauri::AppHandle) {
    let _ = server::stop_server(app.clone()).await;
    app.exit(0);
}

pub fn run() {
    let mut builder = tauri::Builder::default();

    // Desktop-only plugins
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = windows::show_dashboard_window(&handle).await {
                        eprintln!("Failed to activate dashboard: {error}");
                        let _ = windows::show_main_window(&handle);
                    }
                });
            }))
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ))
            .plugin(
                tauri_plugin_window_state::Builder::default()
                    .skip_initial_state("main")
                    .build(),
            );
    }

    builder
        .manage(server::ServerState::new())
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_app_config,
            get_data_dir,
            is_dev_mode,
            server::start_server,
            server::stop_server,
            server::get_server_status,
            server::get_server_error,
            server::get_dashboard_url,
            server::get_server_output_buffer,
            windows::open_dashboard_window,
            windows::open_server_output_window,
            windows::open_diagnostics_window,
            quit_app,
        ])
        .setup(|app| {
            // The packaged main window hosts updater and recovery UI. It is
            // never an ordinary startup surface, even if an older build saved
            // it as visible through the window-state plugin.
            if let Some(main) = app.get_webview_window("main") {
                main.hide()?;
            }

            let mut cfg = config::load_config();
            if !cfg.setup_complete {
                cfg.setup_complete = true;
                config::save_config(&cfg).map_err(std::io::Error::other)?;
            }

            // Setup system tray
            tray::setup_tray(app.handle())?;

            let handle = app.handle().clone();
            let startup_view = cfg.startup_view;
            tauri::async_runtime::spawn(async move {
                let result = if startup_view == config::StartupView::Dashboard {
                    windows::show_dashboard_window(&handle).await
                } else {
                    server::start_server(handle.clone()).await
                };
                match result {
                    Ok(()) => {}
                    Err(error) => {
                        eprintln!("Failed to start bundled server: {error}");
                        let _ = windows::show_main_window(&handle);
                    }
                }
            });

            match cfg.startup_view {
                config::StartupView::Dashboard => {}
                config::StartupView::ServerOutput => {
                    windows::show_server_output_window(app.handle())?;
                }
                config::StartupView::TrayOnly => {}
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let label = window.label();
                let is_primary_surface = matches!(
                    label,
                    "main" | "dashboard" | "server-output" | "diagnostics"
                );
                if !is_primary_surface {
                    return;
                }

                if config::load_config().run_in_background {
                    // Close to tray instead of quitting.
                    let _ = window.hide();
                    api.prevent_close();
                    return;
                }

                // Fully quit when background mode is disabled.
                api.prevent_close();
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = server::stop_server(app.clone()).await;
                    app.exit(0);
                });
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app_handle.state::<server::ServerState>();
                state.kill_sync();
            }
        });
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    fn tauri_config() -> Value {
        serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json should be valid JSON")
    }

    #[test]
    fn updater_endpoint_uses_desktop_update_route() {
        let conf = tauri_config();
        let endpoint = conf["plugins"]["updater"]["endpoints"][0]
            .as_str()
            .expect("updater endpoint must be a string");

        assert_eq!(
            endpoint,
            "https://updates.yepanywhere.com/desktop/tauri/{{target}}/{{arch}}/{{current_version}}",
        );
    }

    #[test]
    fn remote_dashboard_has_no_native_capability() {
        let capability: Value = serde_json::from_str(include_str!("../capabilities/default.json"))
            .expect("default capability should be valid JSON");
        let windows = capability["windows"]
            .as_array()
            .expect("capability windows must be an array");
        let permissions = capability["permissions"]
            .as_array()
            .expect("capability permissions must be an array");

        assert!(!windows.iter().any(|window| window == "dashboard"));
        for permission in permissions {
            let permission = permission
                .as_str()
                .expect("capability permission must be a string");
            assert!(!permission.starts_with("shell:"));
            assert!(!permission.starts_with("opener:"));
            assert!(!permission.starts_with("dialog:"));
        }
    }

    #[test]
    fn packaged_pages_have_an_explicit_csp() {
        let conf = tauri_config();
        let csp = conf["app"]["security"]["csp"]
            .as_str()
            .expect("packaged-page CSP must be a string");

        assert!(csp.contains("default-src 'self'"));
        assert!(csp.contains("object-src 'none'"));
        assert!(!csp.contains("script-src 'self' 'unsafe-inline'"));
    }
}
