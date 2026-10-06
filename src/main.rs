//! DevTerm on GPUI. The first screen is the terminal, same as the Electron app.

mod app;
mod ssh_config;
mod theme;
mod vt;

fn main() {
    gpui::Application::new().run(|cx| {
        app::open(cx);
    });
}
