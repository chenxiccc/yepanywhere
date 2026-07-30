fn main() {
    const COMMANDS: &[&str] = &[
        "get_config",
        "save_app_config",
        "get_data_dir",
        "is_dev_mode",
        "start_server",
        "stop_server",
        "get_server_status",
        "get_server_error",
        "get_dashboard_url",
        "get_server_output_buffer",
        "open_dashboard_window",
        "open_server_output_window",
        "open_diagnostics_window",
        "open_updater_window",
        "quit_app",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to build Tauri application manifest");
    println!(
        "cargo:rustc-env=TARGET_TRIPLE={}",
        std::env::var("TARGET").unwrap()
    );
}
