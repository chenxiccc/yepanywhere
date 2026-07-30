use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{
    async_runtime::JoinHandle, AppHandle, Manager, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tokio::sync::Mutex as AsyncMutex;

const DEFAULT_DASHBOARD_UNLOAD_DELAY: Duration = Duration::from_secs(5 * 60);
const TEST_UNLOAD_DELAY_ENV: &str = "YEP_DESKTOP_TEST_UNLOAD_DELAY_MS";
const MAX_SAVED_DASHBOARD_ROUTE_BYTES: usize = 8 * 1024;

pub struct DashboardWindowState {
    gate: AsyncMutex<()>,
    server_attempt: Mutex<Option<u64>>,
    last_route: Mutex<Option<String>>,
    unload_generation: AtomicU64,
    unload_task: Mutex<Option<JoinHandle<()>>>,
}

impl DashboardWindowState {
    pub fn new() -> Self {
        Self {
            gate: AsyncMutex::new(()),
            server_attempt: Mutex::new(None),
            last_route: Mutex::new(None),
            unload_generation: AtomicU64::new(0),
            unload_task: Mutex::new(None),
        }
    }
}

fn dashboard_is_current(
    dashboard_exists: bool,
    dashboard_attempt: Option<u64>,
    server_attempt: u64,
) -> bool {
    dashboard_exists && dashboard_attempt == Some(server_attempt)
}

fn show_existing(window: &WebviewWindow) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

fn dashboard_route_from_url(url: &Url) -> Option<String> {
    let path = url.path();
    if !path.starts_with('/') || path.starts_with("//") || path.starts_with("/desktop-bootstrap/") {
        return None;
    }

    let mut route = path.to_string();
    if let Some(query) = url.query() {
        route.push('?');
        route.push_str(query);
    }
    if let Some(fragment) = url.fragment() {
        route.push('#');
        route.push_str(fragment);
    }
    (route.len() <= MAX_SAVED_DASHBOARD_ROUTE_BYTES).then_some(route)
}

fn remember_dashboard_route(state: &DashboardWindowState, window: &WebviewWindow) {
    let Some(route) = window
        .url()
        .ok()
        .as_ref()
        .and_then(dashboard_route_from_url)
    else {
        return;
    };
    if let Ok(mut last_route) = state.last_route.lock() {
        *last_route = Some(route);
    }
}

fn unload_delay_from_values(test_mode: Option<&str>, delay_ms: Option<&str>) -> Duration {
    if test_mode != Some("1") {
        return DEFAULT_DASHBOARD_UNLOAD_DELAY;
    }
    delay_ms
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_DASHBOARD_UNLOAD_DELAY)
}

pub fn dashboard_unload_delay() -> Duration {
    unload_delay_from_values(
        crate::config::test_mode_enabled().then_some("1"),
        std::env::var(TEST_UNLOAD_DELAY_ENV).ok().as_deref(),
    )
}

pub fn cancel_dashboard_unload(app: &AppHandle) {
    let state = app.state::<DashboardWindowState>();
    state.unload_generation.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut task) = state.unload_task.lock() {
        if let Some(task) = task.take() {
            task.abort();
        }
    };
}

pub fn schedule_dashboard_unload(app: &AppHandle, delay: Duration) {
    cancel_dashboard_unload(app);
    let state = app.state::<DashboardWindowState>();
    let generation = state.unload_generation.load(Ordering::SeqCst);
    let handle = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        let state = handle.state::<DashboardWindowState>();
        let _dashboard = state.gate.lock().await;
        if state.unload_generation.load(Ordering::SeqCst) != generation {
            return;
        }

        let Some(window) = handle.get_webview_window("dashboard") else {
            return;
        };
        if window.is_visible().unwrap_or(true) {
            return;
        }

        remember_dashboard_route(&state, &window);
        if let Err(error) = window.destroy() {
            eprintln!("Failed to unload hidden dashboard: {error}");
            return;
        }
        if let Ok(mut attempt) = state.server_attempt.lock() {
            *attempt = None;
        };
    });
    if let Ok(mut current_task) = state.unload_task.lock() {
        *current_task = Some(task);
    };
}

pub fn refresh_hidden_dashboard_policy(app: &AppHandle) {
    use crate::config::DashboardCloseBehavior;

    let behavior = crate::config::load_config().dashboard_close_behavior;
    if behavior != DashboardCloseBehavior::UnloadAfterDelay {
        cancel_dashboard_unload(app);
        return;
    }
    let should_schedule = app
        .get_webview_window("dashboard")
        .and_then(|window| window.is_visible().ok())
        == Some(false);
    if should_schedule {
        schedule_dashboard_unload(app, dashboard_unload_delay());
    }
}

fn show_packaged_window(
    app: &AppHandle,
    label: &str,
    title: &str,
    url: &str,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(label) {
        return show_existing(&window);
    }

    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(width, height)
        .visible(true)
        .build()
        .map_err(|error| error.to_string())?;
    show_existing(&window)
}

pub fn show_main_window(app: &AppHandle) -> Result<(), String> {
    show_packaged_window(app, "main", "Yep Anywhere", "index.html", 760.0, 620.0)
}

pub async fn show_dashboard_window(app: &AppHandle) -> Result<(), String> {
    cancel_dashboard_unload(app);
    crate::server::start_server(app.clone()).await?;

    let state = app.state::<DashboardWindowState>();
    let _dashboard = state.gate.lock().await;
    let server_attempt = crate::server::get_server_attempt(app)?;
    let dashboard_attempt = *state
        .server_attempt
        .lock()
        .map_err(|error| error.to_string())?;
    if dashboard_is_current(
        app.get_webview_window("dashboard").is_some(),
        dashboard_attempt,
        server_attempt,
    ) {
        if let Some(window) = app.get_webview_window("dashboard") {
            show_existing(&window)?;
            return Ok(());
        }
    }

    if let Some(window) = app.get_webview_window("dashboard") {
        remember_dashboard_route(&state, &window);
    }
    let last_route = state
        .last_route
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    let url =
        crate::server::get_dashboard_url_for_route(app.clone(), last_route.as_deref()).await?;
    let url = url
        .parse()
        .map_err(|error| format!("Invalid desktop dashboard URL: {error}"))?;

    let window = if let Some(window) = app.get_webview_window("dashboard") {
        window.navigate(url).map_err(|error| error.to_string())?;
        window
    } else {
        WebviewWindowBuilder::new(app, "dashboard", WebviewUrl::External(url))
            .title("Yep Anywhere")
            .inner_size(1100.0, 750.0)
            .initialization_script(crate::runtime_metadata::dashboard_initialization_script(
                app,
            ))
            .visible(true)
            .build()
            .map_err(|error| error.to_string())?
    };
    show_existing(&window)?;
    *state
        .server_attempt
        .lock()
        .map_err(|error| error.to_string())? = Some(server_attempt);
    Ok(())
}

pub fn show_server_output_window(app: &AppHandle) -> Result<(), String> {
    show_packaged_window(
        app,
        "server-output",
        "Yep Anywhere Server Output",
        "index.html?view=server-output",
        900.0,
        620.0,
    )
}

pub fn show_diagnostics_window(app: &AppHandle) -> Result<(), String> {
    show_packaged_window(
        app,
        "diagnostics",
        "Yep Anywhere Diagnostics",
        "index.html?view=diagnostics",
        760.0,
        620.0,
    )
}

#[tauri::command]
pub async fn open_dashboard_window(app: AppHandle) -> Result<(), String> {
    show_dashboard_window(&app).await
}

#[tauri::command]
pub fn open_server_output_window(app: AppHandle) -> Result<(), String> {
    show_server_output_window(&app)
}

#[tauri::command]
pub fn open_diagnostics_window(app: AppHandle) -> Result<(), String> {
    show_diagnostics_window(&app)
}

#[tauri::command]
pub fn open_updater_window(app: AppHandle) -> Result<(), String> {
    show_main_window(&app)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{
        dashboard_is_current, dashboard_route_from_url, unload_delay_from_values,
        DEFAULT_DASHBOARD_UNLOAD_DELAY,
    };
    use tauri::Url;

    #[test]
    fn repeat_launch_focuses_only_the_current_dashboard() {
        assert!(dashboard_is_current(true, Some(3), 3));
        assert!(!dashboard_is_current(false, Some(3), 3));
        assert!(!dashboard_is_current(true, Some(2), 3));
        assert!(!dashboard_is_current(true, None, 3));
    }

    #[test]
    fn dashboard_route_keeps_only_same_origin_path_state() {
        let route = dashboard_route_from_url(
            &Url::parse("http://127.0.0.1:4567/sessions/abc?view=all#turn-4").unwrap(),
        );
        assert_eq!(route.as_deref(), Some("/sessions/abc?view=all#turn-4"));

        let bootstrap =
            Url::parse("http://127.0.0.1:4567/desktop-bootstrap/sensitive-code").unwrap();
        assert_eq!(dashboard_route_from_url(&bootstrap), None);
    }

    #[test]
    fn short_unload_delay_requires_explicit_test_mode() {
        assert_eq!(
            unload_delay_from_values(None, Some("25")),
            DEFAULT_DASHBOARD_UNLOAD_DELAY
        );
        assert_eq!(
            unload_delay_from_values(Some("1"), Some("25")),
            Duration::from_millis(25)
        );
        assert_eq!(
            unload_delay_from_values(Some("1"), Some("invalid")),
            DEFAULT_DASHBOARD_UNLOAD_DELAY
        );
    }
}
