//! Small OS integrations that have no cross-platform API.

/// True while a full-screen app (game, video, presentation) owns the screen.
#[cfg(windows)]
pub fn fullscreen_active() -> bool {
    use windows_sys::Win32::UI::Shell::{
        SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
    };
    let mut state = 0;
    // SAFETY: the out-pointer is a valid, initialised local.
    let hr = unsafe { SHQueryUserNotificationState(&mut state) };
    hr == 0 && matches!(state, QUNS_BUSY | QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE)
}

#[cfg(not(windows))]
pub fn fullscreen_active() -> bool {
    // TODO(macOS/Linux): detect full-screen spaces; until then the widget stays visible.
    false
}

/// Play the system's standard alert sound.
#[cfg(windows)]
pub fn alert_sound() {
    use windows_sys::Win32::System::Diagnostics::Debug::MessageBeep;
    use windows_sys::Win32::UI::WindowsAndMessaging::MB_ICONASTERISK;
    // SAFETY: MessageBeep takes a plain flag and has no pointer arguments.
    unsafe {
        MessageBeep(MB_ICONASTERISK);
    }
}

#[cfg(not(windows))]
pub fn alert_sound() {
    // The webview plays a short tone instead (see src/lib/sound.ts).
}
