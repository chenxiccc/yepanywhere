use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

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
    if crate::server::get_server_status(app.clone()).await? != "running" {
        crate::server::start_server(app.clone()).await?;
    }
    let url = crate::server::get_dashboard_url(app.clone()).await?;
    let url = url
        .parse()
        .map_err(|error| format!("Invalid desktop dashboard URL: {error}"))?;

    if let Some(window) = app.get_webview_window("dashboard") {
        window.navigate(url).map_err(|error| error.to_string())?;
        show_existing(&window);
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(app, "dashboard", WebviewUrl::External(url))
        .title("Yep Anywhere")
        .inner_size(1100.0, 750.0)
        .visible(true)
        .build()
        .map_err(|error| error.to_string())?;
    show_existing(&window);
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
