//! Tokyo Night chrome tokens from the Electron app's boot theme.

use gpui::rgb;

pub const BG: u32 = 0x16161e;
pub const TERM_BG: u32 = 0x1a1b26;
pub const PANEL: u32 = 0x1a1b26;
pub const PANEL2: u32 = 0x20212e;
pub const BORDER: u32 = 0x2a2c3d;
pub const FG: u32 = 0xc0caf5;
pub const MUTED: u32 = 0x565f89;
pub const ACCENT: u32 = 0x7aa2f7;
pub const DANGER: u32 = 0xf7768e;
pub const OK: u32 = 0x9ece6a;
pub const WARN: u32 = 0xe0af68;

/// Accent mixed onto the panel, matching the rail's active button.
pub const ACCENT_QUIET: u32 = 0x2b334b;
/// Foreground mixed onto the panel, matching hover fills.
pub const HOVER: u32 = 0x272833;
pub const GROUP_ACTIVE: u32 = 0x2c2e3d;

pub fn bg() -> gpui::Rgba {
    rgb(BG)
}
pub fn term_bg() -> gpui::Rgba {
    rgb(TERM_BG)
}
pub fn panel() -> gpui::Rgba {
    rgb(PANEL)
}
pub fn panel2() -> gpui::Rgba {
    rgb(PANEL2)
}
pub fn border() -> gpui::Rgba {
    rgb(BORDER)
}
pub fn fg() -> gpui::Rgba {
    rgb(FG)
}
pub fn muted() -> gpui::Rgba {
    rgb(MUTED)
}
pub fn accent() -> gpui::Rgba {
    rgb(ACCENT)
}
pub fn danger() -> gpui::Rgba {
    rgb(DANGER)
}
pub fn ok() -> gpui::Rgba {
    rgb(OK)
}
pub fn warn() -> gpui::Rgba {
    rgb(WARN)
}
pub fn accent_quiet() -> gpui::Rgba {
    rgb(ACCENT_QUIET)
}
pub fn hover() -> gpui::Rgba {
    rgb(HOVER)
}
pub fn group_active() -> gpui::Rgba {
    rgb(GROUP_ACTIVE)
}
