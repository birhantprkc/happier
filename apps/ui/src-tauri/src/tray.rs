#[cfg(desktop)]
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    App, AppHandle, Manager, Runtime,
};

#[cfg(desktop)]
use crate::menu::{OPEN_UPDATES_MENU_ID, QUIT_APP_MENU_ID, SHOW_MAIN_WINDOW_MENU_ID};

#[cfg(desktop)]
use serde::Deserialize;

#[cfg(desktop)]
const TRAY_ICON_ID: &str = "main";
/// The tray shows only the Happier mark; status lives in the menu it opens, so the icon never
/// changes and never grows a title. macOS gets a template image the menu bar tints for light and
/// dark bars (tray-icon draws it 18pt tall; 36px is its @2x). Windows and Linux get a white glyph
/// with a dark keyline, legible on light and dark trays alike. Both derive from `logo-black.png`.
#[cfg(target_os = "macos")]
const TRAY_ICON: Image<'static> = tauri::include_image!("./icons/tray/tray-template.png");
#[cfg(all(desktop, not(target_os = "macos")))]
const TRAY_ICON: Image<'static> = tauri::include_image!("./icons/tray/tray.png");
#[cfg(desktop)]
const TRAY_TOOLTIP: &str = "Happier";
/// The tray is how Windows and Linux reach Quit at all: they get no app menu, and closing the main
/// window only hides it. It is also the only way to bring that window back on those platforms.
#[cfg(desktop)]
const DESKTOP_TRAY_ENABLED: bool = true;

#[cfg(desktop)]
fn is_desktop_tray_enabled_for_build() -> bool {
    DESKTOP_TRAY_ENABLED
}

#[cfg(desktop)]
pub fn register<R: Runtime>(app: &mut App<R>) -> tauri::Result<()> {
    if !is_desktop_tray_enabled_for_build() {
        return Ok(());
    }

    let initial_state = DesktopTrayStatePayload {
        label: "Happier".to_string(),
        detail: "Checking connection".to_string(),
        open_label: default_open_label(),
        quit_label: default_quit_label(),
        updates_label: None,
    };

    // No click handler: every platform opens the menu on click (Linux can only ever do that), and
    // the menu's Open item is how the hidden main window comes back.
    TrayIconBuilder::with_id(TRAY_ICON_ID)
        .icon(TRAY_ICON)
        .icon_as_template(true)
        .tooltip(TRAY_TOOLTIP)
        .menu(&build_menu(app, &initial_state)?)
        .show_menu_on_left_click(true)
        .build(app)?;

    Ok(())
}

#[cfg(desktop)]
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTrayStatePayload {
    /// The menu's status line, "label · detail". Unknown fields (the retired `status`) are ignored.
    pub label: String,
    pub detail: String,
    /// The menu labels, localized by the app (U14). The English defaults only cover the frames
    /// before the app's first update and an app that does not send them.
    #[serde(default = "default_open_label")]
    pub open_label: String,
    #[serde(default = "default_quit_label")]
    pub quit_label: String,
    /// "Updates available (3)…" — present only while there is an update to act on. Absent (older
    /// apps, nothing to update) means no item.
    #[serde(default)]
    pub updates_label: Option<String>,
}

#[cfg(desktop)]
fn default_open_label() -> String {
    "Open Happier".to_string()
}

#[cfg(desktop)]
fn default_quit_label() -> String {
    "Quit Happier".to_string()
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_set_tray_state<R: Runtime>(
    app: AppHandle<R>,
    state: DesktopTrayStatePayload,
) -> Result<(), String> {
    if !is_desktop_tray_enabled_for_build() {
        return Ok(());
    }

    apply_tray_state(&app, &state).map_err(|error| error.to_string())
}

#[cfg(desktop)]
fn apply_tray_state<R: Runtime>(
    app: &AppHandle<R>,
    state: &DesktopTrayStatePayload,
) -> tauri::Result<()> {
    let tray = app
        .tray_by_id(TRAY_ICON_ID)
        .ok_or_else(|| tauri::Error::AssetNotFound("tray icon".into()))?;

    tray.set_menu(Some(build_menu(app, state)?))?;
    Ok(())
}

#[cfg(desktop)]
fn build_menu<R: Runtime>(
    app: &impl Manager<R>,
    state: &DesktopTrayStatePayload,
) -> tauri::Result<tauri::menu::Menu<R>> {
    let status_item = MenuItemBuilder::new(status_line(state))
        .enabled(false)
        .build(app)?;
    let show_main_window_item =
        MenuItemBuilder::with_id(SHOW_MAIN_WINDOW_MENU_ID, state.open_label.clone()).build(app)?;
    let quit_app =
        MenuItemBuilder::with_id(QUIT_APP_MENU_ID, state.quit_label.clone()).build(app)?;

    let mut menu = MenuBuilder::new(app).item(&status_item).separator();
    if let Some(label) = state
        .updates_label
        .as_deref()
        .map(str::trim)
        .filter(|label| !label.is_empty())
    {
        menu = menu.item(&MenuItemBuilder::with_id(OPEN_UPDATES_MENU_ID, label).build(app)?);
    }
    menu.item(&show_main_window_item)
        .separator()
        .item(&quit_app)
        .build()
}

#[cfg(desktop)]
fn status_line(state: &DesktopTrayStatePayload) -> String {
    format!("{} · {}", state.label, state.detail)
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;

    #[test]
    fn every_desktop_build_ships_the_tray_so_quit_is_reachable() {
        // Windows and Linux have no other quit or re-show affordance: no app menu, and the main
        // window hides on close.
        assert!(is_desktop_tray_enabled_for_build());
    }

    #[test]
    fn tray_menu_labels_come_from_the_app_and_default_to_english() {
        let localized: DesktopTrayStatePayload = serde_json::from_str(
            r#"{"status":"healthy","label":"Verbunden","detail":"Online","openLabel":"Happier öffnen","quitLabel":"Happier beenden"}"#,
        )
        .expect("payload parses");
        assert_eq!(localized.open_label, "Happier öffnen");
        assert_eq!(localized.quit_label, "Happier beenden");

        let older: DesktopTrayStatePayload =
            serde_json::from_str(r#"{"status":"healthy","label":"Connected","detail":"Online"}"#)
                .expect("payload without labels parses");
        assert_eq!(older.open_label, "Open Happier");
        assert_eq!(older.quit_label, "Quit Happier");
        assert_eq!(older.updates_label, None);

        let with_updates: DesktopTrayStatePayload = serde_json::from_str(
            r#"{"label":"Connected","detail":"Online","updatesLabel":"Updates available (2)…"}"#,
        )
        .expect("payload with an updates item parses");
        assert_eq!(
            with_updates.updates_label.as_deref(),
            Some("Updates available (2)…")
        );
    }

    #[test]
    fn the_menu_status_line_joins_label_and_detail() {
        let state: DesktopTrayStatePayload = serde_json::from_str(
            r#"{"label":"Connected","detail":"Online · 2/2","openLabel":"Open Happier","quitLabel":"Quit Happier"}"#,
        )
        .expect("payload without status parses");
        assert_eq!(status_line(&state), "Connected · Online · 2/2");
    }
}
