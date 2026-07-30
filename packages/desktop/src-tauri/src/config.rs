use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const TEST_MODE_ENV: &str = "YEP_DESKTOP_TEST_MODE";
const TEST_DATA_DIR_ENV: &str = "YEP_DESKTOP_TEST_DATA_DIR";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupView {
    Dashboard,
    ServerOutput,
    TrayOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DashboardCloseBehavior {
    UnloadAfterDelay,
    KeepLoaded,
    Quit,
}

fn default_startup_view() -> StartupView {
    StartupView::Dashboard
}

fn default_dashboard_close_behavior() -> DashboardCloseBehavior {
    DashboardCloseBehavior::UnloadAfterDelay
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default = "default_true")]
    pub setup_complete: bool,
    #[serde(default)]
    pub agents: Vec<String>,
    /// User-specified port override. None = auto-pick a free port on each launch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// Backwards-compatible input for configs saved before startup_view.
    #[serde(default)]
    pub start_minimized: bool,
    #[serde(default = "default_startup_view")]
    pub startup_view: StartupView,
    #[serde(default = "default_dashboard_close_behavior")]
    pub dashboard_close_behavior: DashboardCloseBehavior,
}

fn default_true() -> bool {
    true
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            setup_complete: true,
            agents: vec![],
            port: None,
            start_minimized: false,
            startup_view: StartupView::Dashboard,
            dashboard_close_behavior: DashboardCloseBehavior::UnloadAfterDelay,
        }
    }
}

pub fn data_dir() -> PathBuf {
    let base = dirs::home_dir().expect("Could not find home directory");
    data_dir_from_values(
        test_mode_enabled(),
        std::env::var_os(TEST_DATA_DIR_ENV).as_deref(),
        &base,
    )
}

pub fn test_mode_enabled() -> bool {
    std::env::var(TEST_MODE_ENV).ok().as_deref() == Some("1")
}

fn data_dir_from_values(
    test_mode: bool,
    test_data_dir: Option<&std::ffi::OsStr>,
    home_dir: &std::path::Path,
) -> PathBuf {
    if test_mode {
        if let Some(path) = test_data_dir
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
        {
            return path;
        }
    }
    home_dir.join(".yep-anywhere-desktop")
}

pub fn config_path() -> PathBuf {
    data_dir().join("config.json")
}

/// Development builds may explicitly run a checkout. Signed/release binaries
/// always use their immutable bundled server so an ambient machine variable
/// cannot silently replace the stable fallback.
pub fn dev_dir() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        std::env::var("YEP_DEV_DIR").ok().map(PathBuf::from)
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}

pub fn load_config() -> AppConfig {
    let path = config_path();
    if path.exists() {
        let contents = fs::read_to_string(&path).unwrap_or_default();
        parse_config(&contents)
    } else {
        AppConfig::default()
    }
}

fn parse_config(contents: &str) -> AppConfig {
    let mut config: AppConfig = serde_json::from_str(contents).unwrap_or_default();
    if !contents.contains("\"setup_complete\"") || !config.setup_complete {
        config.setup_complete = true;
    }
    if !contents.contains("\"startup_view\"") && config.start_minimized {
        config.startup_view = StartupView::TrayOnly;
    }
    if !contents.contains("\"dashboard_close_behavior\"") {
        let legacy_run_in_background = serde_json::from_str::<serde_json::Value>(contents)
            .ok()
            .and_then(|value| value.get("run_in_background")?.as_bool())
            .unwrap_or(true);
        config.dashboard_close_behavior = if legacy_run_in_background {
            DashboardCloseBehavior::UnloadAfterDelay
        } else {
            DashboardCloseBehavior::Quit
        };
    }
    if config.startup_view == StartupView::TrayOnly
        && config.dashboard_close_behavior == DashboardCloseBehavior::Quit
    {
        config.startup_view = StartupView::Dashboard;
        config.start_minimized = false;
    }
    config
}

pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{data_dir_from_values, parse_config, DashboardCloseBehavior, StartupView};
    use std::path::Path;

    #[test]
    fn old_background_config_migrates_to_explicit_close_behavior() {
        let keep_running = parse_config(r#"{"run_in_background":true}"#);
        assert_eq!(
            keep_running.dashboard_close_behavior,
            DashboardCloseBehavior::UnloadAfterDelay
        );

        let quit = parse_config(r#"{"run_in_background":false}"#);
        assert_eq!(quit.dashboard_close_behavior, DashboardCloseBehavior::Quit);
    }

    #[test]
    fn explicit_close_behavior_wins_over_legacy_field() {
        let config =
            parse_config(r#"{"dashboard_close_behavior":"keep_loaded","run_in_background":false}"#);
        assert_eq!(
            config.dashboard_close_behavior,
            DashboardCloseBehavior::KeepLoaded
        );
    }

    #[test]
    fn old_start_minimized_config_still_migrates_to_tray_only() {
        let config = parse_config(r#"{"start_minimized":true}"#);
        assert_eq!(config.startup_view, StartupView::TrayOnly);
    }

    #[test]
    fn tray_only_startup_cannot_hide_a_quit_on_close_app() {
        let config =
            parse_config(r#"{"startup_view":"tray_only","dashboard_close_behavior":"quit"}"#);
        assert_eq!(config.startup_view, StartupView::Dashboard);
        assert!(!config.start_minimized);
    }

    #[test]
    fn alternate_data_dir_requires_test_mode() {
        let home = Path::new("C:/Users/example");
        assert_eq!(
            data_dir_from_values(false, Some("C:/temp/smoke".as_ref()), home),
            home.join(".yep-anywhere-desktop")
        );
        assert_eq!(
            data_dir_from_values(true, Some("C:/temp/smoke".as_ref()), home),
            Path::new("C:/temp/smoke")
        );
    }
}
