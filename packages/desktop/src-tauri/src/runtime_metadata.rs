use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const RUNTIME_MANIFEST_NAME: &str = "desktop-runtime-manifest.json";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimeMetadata {
    desktop_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    bundled_ya_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    commit: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopRuntimeManifest {
    yep_version: Option<String>,
    commit: Option<String>,
}

fn meaningful(value: Option<String>) -> Option<String> {
    value
        .map(|candidate| candidate.trim().to_string())
        .filter(|candidate| !candidate.is_empty() && candidate != "unknown")
}

fn metadata_from_manifest(
    desktop_version: impl Into<String>,
    manifest_json: Option<&str>,
) -> DesktopRuntimeMetadata {
    let manifest = manifest_json
        .and_then(|contents| serde_json::from_str::<DesktopRuntimeManifest>(contents).ok());
    DesktopRuntimeMetadata {
        desktop_version: desktop_version.into(),
        bundled_ya_version: manifest
            .as_ref()
            .and_then(|candidate| meaningful(candidate.yep_version.clone())),
        commit: manifest.and_then(|candidate| meaningful(candidate.commit)),
    }
}

fn manifest_candidates(resource_dir: &Path) -> [PathBuf; 2] {
    [
        resource_dir.join("server").join(RUNTIME_MANIFEST_NAME),
        resource_dir
            .join("resources")
            .join("server")
            .join(RUNTIME_MANIFEST_NAME),
    ]
}

pub fn load(app: &AppHandle) -> DesktopRuntimeMetadata {
    let manifest = app.path().resource_dir().ok().and_then(|resource_dir| {
        manifest_candidates(&resource_dir)
            .into_iter()
            .find_map(|path| fs::read_to_string(path).ok())
    });
    metadata_from_manifest(app.package_info().version.to_string(), manifest.as_deref())
}

fn initialization_script(metadata: &DesktopRuntimeMetadata) -> String {
    let metadata_json =
        serde_json::to_string(metadata).expect("desktop runtime metadata should serialize");
    format!(
        r#"
if (
  window.location.protocol === "http:" &&
  (window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "localhost") &&
  !Object.prototype.hasOwnProperty.call(window, "__YEP_DESKTOP_RUNTIME__")
) {{
  Object.defineProperty(window, "__YEP_DESKTOP_RUNTIME__", {{
    value: Object.freeze({metadata_json}),
    writable: false,
    configurable: false
  }});
}}
"#
    )
}

pub fn dashboard_initialization_script(app: &AppHandle) -> String {
    initialization_script(&load(app))
}

#[cfg(test)]
mod tests {
    use super::{initialization_script, metadata_from_manifest, DesktopRuntimeMetadata};

    #[test]
    fn native_version_and_bundled_ya_build_remain_distinct() {
        let metadata = metadata_from_manifest(
            "0.1.1",
            Some(
                r#"{
                    "desktopVersion": "wrong-manifest-value",
                    "yepVersion": "v0.7.0-204-g02856e2c",
                    "commit": "02856e2cbe0edae579309ddb747ca8164a0682d3"
                }"#,
            ),
        );

        assert_eq!(
            metadata,
            DesktopRuntimeMetadata {
                desktop_version: "0.1.1".to_string(),
                bundled_ya_version: Some("v0.7.0-204-g02856e2c".to_string()),
                commit: Some("02856e2cbe0edae579309ddb747ca8164a0682d3".to_string()),
            }
        );
    }

    #[test]
    fn malformed_manifest_keeps_the_native_desktop_version() {
        assert_eq!(
            metadata_from_manifest("0.1.1", Some("{")),
            DesktopRuntimeMetadata {
                desktop_version: "0.1.1".to_string(),
                bundled_ya_version: None,
                commit: None,
            }
        );
    }

    #[test]
    fn dashboard_metadata_is_read_only_and_loopback_scoped() {
        let script = initialization_script(&DesktopRuntimeMetadata {
            desktop_version: "0.1.1".to_string(),
            bundled_ya_version: Some("v0.7.0-204-g02856e2c".to_string()),
            commit: Some("02856e2c".to_string()),
        });

        assert!(script.contains(r#"window.location.hostname === "127.0.0.1""#));
        assert!(script.contains(r#"window.location.hostname === "localhost""#));
        assert!(script.contains(r#""desktopVersion":"0.1.1""#));
        assert!(script.contains("Object.freeze"));
        assert!(script.contains("writable: false"));
        assert!(script.contains("configurable: false"));
    }
}
