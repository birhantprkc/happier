//! Desktop menus and the single router for every menu command.
//!
//! Two menus can issue the same app commands — the tray menu on every desktop platform, and the
//! macOS app menu — so the id → action decision lives here once rather than in each menu's own
//! handler. muda delivers every `MenuEvent` to one global channel, so this is registered once at
//! the app level ([`tauri::Builder::on_menu_event`]) and never per menu: registering it twice would
//! call `app.exit(0)` twice for one Quit, and the second exit finds the shutdown handoff already
//! used and quits without waiting for it.
//!
//! macOS needs its own app menu because tauri's default one ends in muda's *predefined* Quit, whose
//! native action is `terminate:`. That bypasses `RunEvent::ExitRequested` entirely — it emits no
//! menu event and offers no `prevent_exit` — so the quit handoff in [`crate::shutdown`] could never
//! run. Everything below mirrors `tauri::menu::Menu::default` item for item, except that Quit is our
//! own item routed through [`handle_menu_event`] to `app.exit(0)`.
//!
//! Dock → Quit, OS logout, OS shutdown and force quit still terminate the app without reaching
//! `ExitRequested`; `crate::shutdown` documents that as leaving the daemon exactly where it was.

#[cfg(desktop)]
use tauri::{menu::MenuEvent, AppHandle, Runtime};

#[cfg(target_os = "macos")]
use tauri::menu::{
    AboutMetadata, Menu, MenuItemBuilder, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
    WINDOW_SUBMENU_ID,
};

/// Reveals the main window, which closes to the tray rather than exiting.
#[cfg(desktop)]
pub const SHOW_MAIN_WINDOW_MENU_ID: &str = "show-main-window";
/// Quits the app through `app.exit`, the only quit that reaches the shutdown handoff.
#[cfg(desktop)]
pub const QUIT_APP_MENU_ID: &str = "quit-app";

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DesktopMenuAction {
    ShowMainWindow,
    QuitApp,
}

/// `None` for every item this app does not own: predefined items act natively, and the router sees
/// every menu's events because muda's event channel is global.
#[cfg(desktop)]
pub fn resolve_desktop_menu_action(menu_item_id: &str) -> Option<DesktopMenuAction> {
    match menu_item_id {
        SHOW_MAIN_WINDOW_MENU_ID => Some(DesktopMenuAction::ShowMainWindow),
        QUIT_APP_MENU_ID => Some(DesktopMenuAction::QuitApp),
        _ => None,
    }
}

#[cfg(desktop)]
pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match resolve_desktop_menu_action(event.id().0.as_str()) {
        Some(DesktopMenuAction::ShowMainWindow) => {
            if let Err(error) = crate::window_chrome::show_main_window(app) {
                log::warn!("failed to show the main window from a menu command: {error}");
            }
        }
        // Held once by `crate::shutdown` so the webview can honour the background-service
        // preference before the app goes.
        Some(DesktopMenuAction::QuitApp) => app.exit(0),
        None => {}
    }
}

/// tauri's default menu, with its predefined Quit replaced by one that reaches the handoff.
///
/// The Window and Help submenus keep tauri's own ids because tauri registers those two with NSApp
/// by id (`setWindowsMenu` / `setHelpMenu`); a different id silently loses the macOS window list
/// and the Help search field.
#[cfg(target_os = "macos")]
pub fn build_app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let package_info = app.package_info();
    let config = app.config();
    let about_metadata = AboutMetadata {
        name: Some(package_info.name.clone()),
        version: Some(package_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };

    let quit_item = MenuItemBuilder::with_id(QUIT_APP_MENU_ID, "Quit Happier")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;

    let app_menu = Submenu::with_items(
        app,
        package_info.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about_metadata))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[&PredefinedMenuItem::close_window(app, None)?],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;

    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let help_menu = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
    )
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;

    #[test]
    fn the_quit_item_both_menus_share_asks_the_app_to_exit() {
        // `app.exit` is the only quit that reaches the shutdown handoff, so this arm is what makes
        // the background-service preference reachable at all.
        assert_eq!(
            resolve_desktop_menu_action(QUIT_APP_MENU_ID),
            Some(DesktopMenuAction::QuitApp)
        );
    }

    #[test]
    fn the_show_item_reveals_the_window_that_close_only_hid() {
        assert_eq!(
            resolve_desktop_menu_action(SHOW_MAIN_WINDOW_MENU_ID),
            Some(DesktopMenuAction::ShowMainWindow)
        );
    }

    #[test]
    fn menu_items_this_app_does_not_own_are_left_to_act_natively() {
        // The router is global: it sees Edit, View and Window items too, and must not touch them.
        assert_eq!(resolve_desktop_menu_action("Paste"), None);
        assert_eq!(resolve_desktop_menu_action(""), None);
    }
}
