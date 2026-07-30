use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

fn dashboard_is_current(
    dashboard_exists: bool,
    dashboard_attempt: Option<u64>,
    server_attempt: u64,
) -> bool {
    dashboard_exists && dashboard_attempt == Some(server_attempt)
}

fn show_existing(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
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
        show_existing(&window);
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(width, height)
        .visible(true)
        .build()
        .map_err(|error| error.to_string())?;
    show_existing(&window);
    Ok(())
}

pub fn show_main_window(app: &AppHandle) -> Result<(), String> {
    show_packaged_window(app, "main", "Yep Anywhere", "index.html", 760.0, 620.0)
}

pub async fn show_dashboard_window(app: &AppHandle) -> Result<(), String> {
    crate::server::start_server(app.clone()).await?;

    let state = app.state::<crate::server::ServerState>();
    let _dashboard = state.dashboard_gate.lock().await;
    let server_attempt = crate::server::get_server_attempt(app)?;
    let dashboard_attempt = *state
        .dashboard_attempt
        .lock()
        .map_err(|error| error.to_string())?;
    if dashboard_is_current(
        app.get_webview_window("dashboard").is_some(),
        dashboard_attempt,
        server_attempt,
    ) {
        if let Some(window) = app.get_webview_window("dashboard") {
            show_existing(&window);
            return Ok(());
        }
    }

    let url = crate::server::get_dashboard_url(app.clone()).await?;
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
            .visible(true)
            .build()
            .map_err(|error| error.to_string())?
    };
    show_existing(&window);
    *state
        .dashboard_attempt
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

#[cfg(test)]
mod tests {
    use super::dashboard_is_current;

    #[test]
    fn repeat_launch_focuses_only_the_current_dashboard() {
        assert!(dashboard_is_current(true, Some(3), 3));
        assert!(!dashboard_is_current(false, Some(3), 3));
        assert!(!dashboard_is_current(true, Some(2), 3));
        assert!(!dashboard_is_current(true, None, 3));
    }
}
