use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter,
};
use tauri_plugin_autostart::ManagerExt as _;

use crate::config::{self, DashboardCloseBehavior, StartupView};

fn sync_startup_view_items(
    view: StartupView,
    dashboard_item: &CheckMenuItem<tauri::Wry>,
    server_output_item: &CheckMenuItem<tauri::Wry>,
    tray_only_item: &CheckMenuItem<tauri::Wry>,
) {
    let _ = dashboard_item.set_checked(view == StartupView::Dashboard);
    let _ = server_output_item.set_checked(view == StartupView::ServerOutput);
    let _ = tray_only_item.set_checked(view == StartupView::TrayOnly);
}

fn sync_dashboard_close_items(
    behavior: DashboardCloseBehavior,
    unload_item: &CheckMenuItem<tauri::Wry>,
    keep_loaded_item: &CheckMenuItem<tauri::Wry>,
    quit_item: &CheckMenuItem<tauri::Wry>,
) {
    let _ = unload_item.set_checked(behavior == DashboardCloseBehavior::UnloadAfterDelay);
    let _ = keep_loaded_item.set_checked(behavior == DashboardCloseBehavior::KeepLoaded);
    let _ = quit_item.set_checked(behavior == DashboardCloseBehavior::Quit);
}

#[allow(clippy::too_many_arguments)]
fn save_startup_view(
    app: &AppHandle,
    view: StartupView,
    dashboard_item: &CheckMenuItem<tauri::Wry>,
    server_output_item: &CheckMenuItem<tauri::Wry>,
    tray_only_item: &CheckMenuItem<tauri::Wry>,
    unload_item: &CheckMenuItem<tauri::Wry>,
    keep_loaded_item: &CheckMenuItem<tauri::Wry>,
    quit_item: &CheckMenuItem<tauri::Wry>,
) {
    let mut cfg = config::load_config();
    let previous = cfg.startup_view;
    let previous_close_behavior = cfg.dashboard_close_behavior;
    cfg.startup_view = view;
    cfg.start_minimized = view == StartupView::TrayOnly;
    if view == StartupView::TrayOnly && cfg.dashboard_close_behavior == DashboardCloseBehavior::Quit
    {
        cfg.dashboard_close_behavior = DashboardCloseBehavior::UnloadAfterDelay;
    }
    match config::save_config(&cfg) {
        Ok(()) => {
            sync_startup_view_items(view, dashboard_item, server_output_item, tray_only_item);
            sync_dashboard_close_items(
                cfg.dashboard_close_behavior,
                unload_item,
                keep_loaded_item,
                quit_item,
            );
            if cfg.dashboard_close_behavior != previous_close_behavior {
                crate::windows::refresh_hidden_dashboard_policy(app);
            }
        }
        Err(err) => {
            eprintln!("Failed to save startup view setting: {err}");
            sync_startup_view_items(previous, dashboard_item, server_output_item, tray_only_item);
            sync_dashboard_close_items(
                previous_close_behavior,
                unload_item,
                keep_loaded_item,
                quit_item,
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn save_dashboard_close_behavior(
    app: &AppHandle,
    behavior: DashboardCloseBehavior,
    unload_item: &CheckMenuItem<tauri::Wry>,
    keep_loaded_item: &CheckMenuItem<tauri::Wry>,
    quit_item: &CheckMenuItem<tauri::Wry>,
    startup_dashboard_item: &CheckMenuItem<tauri::Wry>,
    startup_server_output_item: &CheckMenuItem<tauri::Wry>,
    startup_tray_only_item: &CheckMenuItem<tauri::Wry>,
) {
    let mut cfg = config::load_config();
    let previous_behavior = cfg.dashboard_close_behavior;
    let previous_startup_view = cfg.startup_view;
    cfg.dashboard_close_behavior = behavior;
    if behavior == DashboardCloseBehavior::Quit && cfg.startup_view == StartupView::TrayOnly {
        cfg.startup_view = StartupView::Dashboard;
        cfg.start_minimized = false;
    }
    match config::save_config(&cfg) {
        Ok(()) => {
            sync_dashboard_close_items(behavior, unload_item, keep_loaded_item, quit_item);
            sync_startup_view_items(
                cfg.startup_view,
                startup_dashboard_item,
                startup_server_output_item,
                startup_tray_only_item,
            );
            crate::windows::refresh_hidden_dashboard_policy(app);
        }
        Err(err) => {
            eprintln!("Failed to save dashboard-close setting: {err}");
            sync_dashboard_close_items(previous_behavior, unload_item, keep_loaded_item, quit_item);
            sync_startup_view_items(
                previous_startup_view,
                startup_dashboard_item,
                startup_server_output_item,
                startup_tray_only_item,
            );
        }
    }
}

pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let cfg = config::load_config();

    let open = MenuItem::with_id(app, "open", "Open Dashboard", true, None::<&str>)?;
    let server_output = MenuItem::with_id(
        app,
        "server-output",
        "Open Server Output",
        true,
        None::<&str>,
    )?;
    let diagnostics = MenuItem::with_id(
        app,
        "diagnostics",
        "Desktop Diagnostics",
        true,
        None::<&str>,
    )?;
    let check_updates = MenuItem::with_id(
        app,
        "check-updates",
        "Check for Updates",
        true,
        None::<&str>,
    )?;
    let restart = MenuItem::with_id(app, "restart", "Restart Server", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "Start at Login",
        true,
        app.autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )?;
    let close_unload = CheckMenuItem::with_id(
        app,
        "close-unload",
        "Unload Dashboard After 5 Minutes",
        true,
        cfg.dashboard_close_behavior == DashboardCloseBehavior::UnloadAfterDelay,
        None::<&str>,
    )?;
    let close_keep_loaded = CheckMenuItem::with_id(
        app,
        "close-keep-loaded",
        "Keep Dashboard Loaded",
        true,
        cfg.dashboard_close_behavior == DashboardCloseBehavior::KeepLoaded,
        None::<&str>,
    )?;
    let close_quit = CheckMenuItem::with_id(
        app,
        "close-quit",
        "Quit Yep Anywhere",
        true,
        cfg.dashboard_close_behavior == DashboardCloseBehavior::Quit,
        None::<&str>,
    )?;
    let startup_dashboard = CheckMenuItem::with_id(
        app,
        "startup-dashboard",
        "Dashboard",
        true,
        cfg.startup_view == StartupView::Dashboard,
        None::<&str>,
    )?;
    let startup_server_output = CheckMenuItem::with_id(
        app,
        "startup-server-output",
        "Server Output",
        true,
        cfg.startup_view == StartupView::ServerOutput,
        None::<&str>,
    )?;
    let startup_tray_only = CheckMenuItem::with_id(
        app,
        "startup-tray-only",
        "Tray Only",
        true,
        cfg.startup_view == StartupView::TrayOnly,
        None::<&str>,
    )?;
    let startup_view = SubmenuBuilder::new(app, "Startup View")
        .item(&startup_dashboard)
        .item(&startup_server_output)
        .item(&startup_tray_only)
        .build()?;
    let dashboard_close = SubmenuBuilder::new(app, "When Dashboard Closes")
        .item(&close_unload)
        .item(&close_keep_loaded)
        .item(&close_quit)
        .build()?;
    let settings = SubmenuBuilder::new(app, "Settings")
        .item(&autostart)
        .item(&dashboard_close)
        .item(&startup_view)
        .build()?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[
            &open,
            &server_output,
            &diagnostics,
            &check_updates,
            &restart,
            &sep1,
            &settings,
            &sep2,
            &quit,
        ],
    )?;

    let autostart_item = autostart.clone();
    let close_unload_item = close_unload.clone();
    let close_keep_loaded_item = close_keep_loaded.clone();
    let close_quit_item = close_quit.clone();
    let startup_dashboard_item = startup_dashboard.clone();
    let startup_server_output_item = startup_server_output.clone();
    let startup_tray_only_item = startup_tray_only.clone();

    let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .tooltip("Yep Anywhere")
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = crate::windows::show_dashboard_window(&app).await {
                        eprintln!("Failed to open dashboard: {error}");
                        let _ = crate::windows::show_main_window(&app);
                    }
                });
            }
            "server-output" => {
                let _ = crate::windows::show_server_output_window(app);
            }
            "diagnostics" => {
                let _ = crate::windows::show_diagnostics_window(app);
            }
            "check-updates" => {
                let _ = app.emit("check-for-updates", ());
            }
            "autostart" => {
                let was_enabled = app.autolaunch().is_enabled().unwrap_or(false);
                let should_enable = !was_enabled;
                let result = if should_enable {
                    app.autolaunch().enable()
                } else {
                    app.autolaunch().disable()
                };
                match result {
                    Ok(()) => {
                        let _ = autostart_item.set_checked(should_enable);
                    }
                    Err(err) => {
                        eprintln!("Failed to update autostart: {err}");
                        let _ = autostart_item.set_checked(was_enabled);
                    }
                }
            }
            "close-unload" => save_dashboard_close_behavior(
                app,
                DashboardCloseBehavior::UnloadAfterDelay,
                &close_unload_item,
                &close_keep_loaded_item,
                &close_quit_item,
                &startup_dashboard_item,
                &startup_server_output_item,
                &startup_tray_only_item,
            ),
            "close-keep-loaded" => save_dashboard_close_behavior(
                app,
                DashboardCloseBehavior::KeepLoaded,
                &close_unload_item,
                &close_keep_loaded_item,
                &close_quit_item,
                &startup_dashboard_item,
                &startup_server_output_item,
                &startup_tray_only_item,
            ),
            "close-quit" => save_dashboard_close_behavior(
                app,
                DashboardCloseBehavior::Quit,
                &close_unload_item,
                &close_keep_loaded_item,
                &close_quit_item,
                &startup_dashboard_item,
                &startup_server_output_item,
                &startup_tray_only_item,
            ),
            "startup-dashboard" => {
                save_startup_view(
                    app,
                    StartupView::Dashboard,
                    &startup_dashboard_item,
                    &startup_server_output_item,
                    &startup_tray_only_item,
                    &close_unload_item,
                    &close_keep_loaded_item,
                    &close_quit_item,
                );
            }
            "startup-server-output" => {
                save_startup_view(
                    app,
                    StartupView::ServerOutput,
                    &startup_dashboard_item,
                    &startup_server_output_item,
                    &startup_tray_only_item,
                    &close_unload_item,
                    &close_keep_loaded_item,
                    &close_quit_item,
                );
            }
            "startup-tray-only" => {
                save_startup_view(
                    app,
                    StartupView::TrayOnly,
                    &startup_dashboard_item,
                    &startup_server_output_item,
                    &startup_tray_only_item,
                    &close_unload_item,
                    &close_keep_loaded_item,
                    &close_quit_item,
                );
            }
            "restart" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::server::stop_server(app.clone()).await;
                    match crate::server::start_server(app.clone()).await {
                        Ok(()) => {
                            let _ = crate::windows::show_dashboard_window(&app).await;
                        }
                        Err(error) => {
                            eprintln!("Failed to restart bundled server: {error}");
                            let _ = crate::windows::show_main_window(&app);
                        }
                    }
                });
            }
            "quit" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::server::stop_server(app.clone()).await;
                    app.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = crate::windows::show_dashboard_window(&app).await {
                        eprintln!("Failed to open dashboard: {error}");
                        let _ = crate::windows::show_main_window(&app);
                    }
                });
            }
        })
        .build(app)?;

    Ok(())
}
