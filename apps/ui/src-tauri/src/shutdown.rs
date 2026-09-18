//! Desktop quit handoff.
//!
//! The main window never closes — it hides to the tray (`window_chrome::resolve_desktop_window_close_strategy`)
//! — so "the app closed" is the app exiting, and that happens exactly once, never once per window.
//! It is where the background-service preference is honoured, and the webview owns the decision
//! because only it knows what is running on this computer and can put a question to the user.
//!
//! The safe direction is asymmetric: leaving the daemon running costs the user nothing they did
//! not already have, while stopping it can end in-flight agent work. So the exit proceeds unless
//! the webview asks for the handoff, and the service is only ever stopped by the webview acting on
//! an answer it actually received. A force quit, an OS shutdown or a logout that kills the app
//! part-way through therefore leaves the daemon exactly where it was.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, Runtime, State};

/// Emitted to the webview when the app is quitting and the handoff is still available.
pub const APP_EXIT_REQUESTED_EVENT: &str = "desktop_app_exit_requested";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DesktopExitAction {
    /// Hold the exit and let the webview decide what to do with the background service.
    HandOffToWebview,
    /// Quit now.
    Exit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DesktopExitRequest {
    /// Whether there is still a webview to ask.
    pub webview_present: bool,
    /// Whether this quit already handed off once.
    pub handoff_used: bool,
    /// An update relaunch. The app is coming straight back, and `prevent_exit` is ignored for it
    /// anyway, so asking whether to stop the service would be both pointless and wrong.
    pub is_restart: bool,
}

/// One handoff, then the app always quits.
///
/// `handoff_used` is what keeps a quit from ever becoming unquittable: if the webview is wedged,
/// gone, or simply slow, pressing Quit again exits. Nothing here waits on a timer.
pub fn resolve_desktop_exit_action(request: DesktopExitRequest) -> DesktopExitAction {
    if request.is_restart || request.handoff_used || !request.webview_present {
        return DesktopExitAction::Exit;
    }
    DesktopExitAction::HandOffToWebview
}

#[derive(Default)]
pub struct DesktopShutdownState {
    handoff_used: AtomicBool,
}

/// Called by the webview once it has done whatever the user's answer asked for. Exiting again
/// re-enters the handler, which now finds the handoff used and lets the app go.
#[tauri::command]
pub fn desktop_finish_shutdown<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

/// Handles `RunEvent::ExitRequested`. Returns `true` when the caller must hold the exit.
pub fn handle_exit_requested<R: Runtime>(app: &AppHandle<R>, code: Option<i32>) -> bool {
    let state: State<'_, DesktopShutdownState> = app.state();
    let request = DesktopExitRequest {
        webview_present: !app.webview_windows().is_empty(),
        handoff_used: state.handoff_used.load(Ordering::SeqCst),
        is_restart: code == Some(tauri::RESTART_EXIT_CODE),
    };

    match resolve_desktop_exit_action(request) {
        DesktopExitAction::Exit => false,
        DesktopExitAction::HandOffToWebview => {
            state.handoff_used.store(true, Ordering::SeqCst);
            // `emit` reports success with zero listeners, so this only fires when the event could
            // not be published at all — never as "nobody is listening". A quit that beats the
            // webview's listener is still held, and is finished by pressing Quit again.
            if app.emit(APP_EXIT_REQUESTED_EVENT, ()).is_err() {
                return false;
            }
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> DesktopExitRequest {
        DesktopExitRequest {
            webview_present: true,
            handoff_used: false,
            is_restart: false,
        }
    }

    #[test]
    fn a_live_webview_gets_one_chance_to_decide() {
        assert_eq!(
            resolve_desktop_exit_action(request()),
            DesktopExitAction::HandOffToWebview
        );
    }

    #[test]
    fn quitting_again_exits_instead_of_asking_twice() {
        assert_eq!(
            resolve_desktop_exit_action(DesktopExitRequest {
                handoff_used: true,
                ..request()
            }),
            DesktopExitAction::Exit
        );
    }

    #[test]
    fn an_exit_with_nobody_to_ask_never_touches_the_background_service() {
        // No webview means no decision and no stop command: the daemon is left running.
        assert_eq!(
            resolve_desktop_exit_action(DesktopExitRequest {
                webview_present: false,
                ..request()
            }),
            DesktopExitAction::Exit
        );
    }

    #[test]
    fn an_update_relaunch_never_asks_about_the_background_service() {
        assert_eq!(
            resolve_desktop_exit_action(DesktopExitRequest {
                is_restart: true,
                ..request()
            }),
            DesktopExitAction::Exit
        );
    }
}
