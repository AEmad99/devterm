//! DevTerm's window, drawn with GPUI.
//!
//! The chrome follows the Electron app: a 40px icon rail, an optional library
//! column, the group bar, pane tabs over the terminal, and a 22px status bar.
//! Local shells are real PTYs. SSH, the agent process, and the browser pane
//! are still the Electron app's job.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use gpui::prelude::*;
use gpui::{
    canvas, div, px, rgba, size, AnyElement, App, Bounds, Context, FocusHandle, Focusable,
    KeyDownEvent, MouseButton, TitlebarOptions, Window, WindowBounds, WindowOptions,
};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

use crate::ssh_config::{parse_ssh_config, SshHost};
use crate::theme;
use crate::vt::Grid;

const SNIPPETS: &[(&str, &str, &str)] = &[
    ("List files", "ls -la", "ls -la\n"),
    ("Git status", "git status", "git status\n"),
    ("Working directory", "pwd", "pwd\n"),
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Library {
    Files,
    Connections,
    Workspaces,
    Snippets,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Modal {
    Settings,
    Shortcuts,
    Palette,
}

enum PtyMsg {
    Data(Vec<u8>),
    Exit,
}

struct LivePty {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl LivePty {
    fn write(&self, bytes: &[u8]) {
        if let Ok(mut writer) = self.writer.lock() {
            let _ = writer.write_all(bytes);
            let _ = writer.flush();
        }
    }

    fn resize(&mut self, cols: usize, rows: usize) {
        let _ = self.master.resize(PtySize {
            rows: rows as u16,
            cols: cols as u16,
            pixel_width: 0,
            pixel_height: 0,
        });
    }
}

impl Drop for LivePty {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

struct Session {
    title: String,
    grid: Grid,
    live: Option<LivePty>,
    exited: bool,
}

#[derive(Clone)]
struct Pane {
    tabs: Vec<u64>,
    active: u64,
}

#[derive(Clone)]
struct Group {
    id: u64,
    name: String,
    panes: Vec<Pane>,
    active_pane: usize,
}

struct FileRow {
    name: String,
    dir: bool,
}

struct GitSnapshot {
    branch: String,
    changes: Vec<String>,
}

pub struct Shell {
    focus: FocusHandle,
    library: Option<Library>,
    git_open: bool,
    agent_open: bool,
    activity_open: bool,
    transfers_open: bool,
    welcome_dismissed: bool,
    ssh_done: bool,
    agent_done: bool,
    modal: Option<Modal>,
    status: String,
    next_id: u64,
    home_group: u64,
    active_group: u64,
    groups: Vec<Group>,
    sessions: std::collections::HashMap<u64, Session>,
    files_cwd: PathBuf,
    file_rows: Vec<FileRow>,
    ssh_hosts: Vec<SshHost>,
    git: Option<GitSnapshot>,
    work_dir: PathBuf,
}

impl Shell {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let work_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let mut shell = Self {
            focus: cx.focus_handle(),
            library: None,
            git_open: false,
            agent_open: false,
            activity_open: false,
            transfers_open: false,
            welcome_dismissed: false,
            ssh_done: false,
            agent_done: false,
            modal: None,
            status: "Ready".into(),
            next_id: 1,
            home_group: 1,
            active_group: 1,
            groups: Vec::new(),
            sessions: std::collections::HashMap::new(),
            files_cwd: work_dir.clone(),
            file_rows: Vec::new(),
            ssh_hosts: Vec::new(),
            git: git_snapshot(&work_dir),
            work_dir,
        };
        let group_id = shell.alloc();
        shell.home_group = group_id;
        shell.active_group = group_id;
        let session = shell.spawn_session(cx);
        shell.groups.push(Group {
            id: group_id,
            name: "Group 1".into(),
            panes: vec![Pane {
                tabs: vec![session],
                active: session,
            }],
            active_pane: 0,
        });
        shell.reload_files();
        shell.reload_ssh();
        shell
    }

    fn alloc(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn spawn_session(&mut self, cx: &mut Context<Self>) -> u64 {
        let id = self.alloc();
        let title = shell_title();
        match spawn_shell() {
            Ok((live, rx)) => {
                self.sessions.insert(
                    id,
                    Session {
                        title,
                        grid: Grid::new(80, 24),
                        live: Some(live),
                        exited: false,
                    },
                );
                pump_pty(id, rx, cx);
            }
            Err(err) => {
                let mut grid = Grid::new(80, 24);
                let message = format!("Could not open a local shell: {err}\r\n");
                grid.feed_bytes(message.as_bytes());
                self.sessions.insert(
                    id,
                    Session {
                        title,
                        grid,
                        live: None,
                        exited: true,
                    },
                );
                self.status = "Local shell failed".into();
            }
        }
        id
    }

    fn active_group_mut(&mut self) -> Option<&mut Group> {
        let id = self.active_group;
        self.groups.iter_mut().find(|group| group.id == id)
    }

    fn new_tab(&mut self, cx: &mut Context<Self>) {
        let session = self.spawn_session(cx);
        let Some(group) = self.active_group_mut() else {
            return;
        };
        if group.panes.is_empty() {
            group.panes.push(Pane {
                tabs: vec![session],
                active: session,
            });
            group.active_pane = 0;
        } else {
            let index = group.active_pane.min(group.panes.len() - 1);
            group.active_pane = index;
            let pane = &mut group.panes[index];
            pane.tabs.push(session);
            pane.active = session;
        }
        self.status = "Opened a local terminal".into();
    }

    fn split_right(&mut self, cx: &mut Context<Self>) {
        let session = self.spawn_session(cx);
        let Some(group) = self.active_group_mut() else {
            return;
        };
        group.panes.push(Pane {
            tabs: vec![session],
            active: session,
        });
        group.active_pane = group.panes.len() - 1;
        self.status = "Split the pane to the right".into();
    }

    fn new_group(&mut self, cx: &mut Context<Self>) {
        let id = self.alloc();
        let session = self.spawn_session(cx);
        let name = format!("Group {}", self.groups.len() + 1);
        self.groups.push(Group {
            id,
            name,
            panes: vec![Pane {
                tabs: vec![session],
                active: session,
            }],
            active_pane: 0,
        });
        self.active_group = id;
        self.status = "Opened a new group".into();
    }

    fn close_session(&mut self, id: u64) {
        self.sessions.remove(&id);
        for group in &mut self.groups {
            for pane in &mut group.panes {
                pane.tabs.retain(|tab| *tab != id);
                if !pane.tabs.is_empty() && !pane.tabs.contains(&pane.active) {
                    pane.active = *pane.tabs.last().unwrap();
                }
            }
            group.panes.retain(|pane| !pane.tabs.is_empty());
            if group.active_pane >= group.panes.len() {
                group.active_pane = group.panes.len().saturating_sub(1);
            }
        }
        self.status = "Closed terminal".into();
    }

    fn close_group(&mut self, id: u64) {
        if id == self.home_group {
            self.status = "The home group stays open".into();
            return;
        }
        let Some(index) = self.groups.iter().position(|group| group.id == id) else {
            return;
        };
        let group = self.groups.remove(index);
        for pane in group.panes {
            for tab in pane.tabs {
                self.sessions.remove(&tab);
            }
        }
        if self.active_group == id {
            self.active_group = self.home_group;
        }
    }

    fn select_tab(&mut self, pane_index: usize, session: u64) {
        if let Some(group) = self.active_group_mut() {
            if let Some(pane) = group.panes.get_mut(pane_index) {
                if pane.tabs.contains(&session) {
                    pane.active = session;
                    group.active_pane = pane_index;
                }
            }
        }
    }

    fn write_active(&self, bytes: &[u8]) {
        let Some(group) = self
            .groups
            .iter()
            .find(|group| group.id == self.active_group)
        else {
            return;
        };
        let Some(pane) = group.panes.get(group.active_pane) else {
            return;
        };
        if let Some(session) = self.sessions.get(&pane.active) {
            if let Some(live) = &session.live {
                live.write(bytes);
            }
        }
    }

    fn note_size(&mut self, id: u64, cols: usize, rows: usize) -> bool {
        let Some(session) = self.sessions.get_mut(&id) else {
            return false;
        };
        if session.grid.cols == cols && session.grid.rows == rows {
            return false;
        }
        session.grid.resize(cols, rows);
        if let Some(live) = session.live.as_mut() {
            live.resize(cols, rows);
        }
        true
    }

    fn reload_files(&mut self) {
        self.file_rows = list_dir(&self.files_cwd);
    }

    fn reload_ssh(&mut self) {
        self.ssh_hosts = load_ssh_hosts();
        if !self.ssh_hosts.is_empty() {
            self.ssh_done = true;
        }
    }

    fn toggle_library(&mut self, library: Library) {
        self.library = if self.library == Some(library) {
            None
        } else {
            match library {
                Library::Files => self.reload_files(),
                Library::Connections => self.reload_ssh(),
                Library::Workspaces | Library::Snippets => {}
            }
            Some(library)
        };
    }

    fn on_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.to_ascii_lowercase();
        let mods = &event.keystroke.modifiers;
        if self.modal.is_some() {
            if key == "escape" {
                self.modal = None;
                cx.notify();
            }
            window.prevent_default();
            cx.stop_propagation();
            return;
        }
        if mods.control && !mods.alt && !mods.platform {
            let handled = if mods.shift {
                match key.as_str() {
                    "t" => {
                        self.new_tab(cx);
                        true
                    }
                    "n" => {
                        self.new_group(cx);
                        true
                    }
                    "e" => {
                        self.toggle_library(Library::Files);
                        true
                    }
                    "w" => {
                        if let Some(id) = self.active_session_id() {
                            self.close_session(id);
                        }
                        true
                    }
                    _ => false,
                }
            } else {
                match key.as_str() {
                    "k" => {
                        self.modal = Some(Modal::Palette);
                        true
                    }
                    "," => {
                        self.modal = Some(Modal::Settings);
                        true
                    }
                    "/" => {
                        self.modal = Some(Modal::Shortcuts);
                        true
                    }
                    _ => false,
                }
            };
            if handled {
                cx.notify();
                window.prevent_default();
                cx.stop_propagation();
                return;
            }
        }
        if mods.control && mods.alt && !mods.shift && key == "g" {
            self.git_open = !self.git_open;
            if self.git_open {
                self.git = git_snapshot(&self.work_dir);
            }
            cx.notify();
            window.prevent_default();
            cx.stop_propagation();
            return;
        }
        if let Some(bytes) = pty_bytes(event) {
            self.write_active(&bytes);
            window.prevent_default();
            cx.stop_propagation();
        }
    }

    fn active_session_id(&self) -> Option<u64> {
        let group = self
            .groups
            .iter()
            .find(|group| group.id == self.active_group)?;
        Some(group.panes.get(group.active_pane)?.active)
    }

    fn render_rail(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let changes = self.git.as_ref().map(|git| git.changes.len()).unwrap_or(0);
        div()
            .w(px(40.))
            .h_full()
            .flex()
            .flex_col()
            .items_center()
            .bg(theme::panel())
            .border_r_1()
            .border_color(theme::border())
            .py(px(6.))
            .gap(px(4.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(4.))
                    .child(rail_button(
                        "▤",
                        self.library == Some(Library::Files),
                        cx,
                        |this, _| {
                            this.toggle_library(Library::Files);
                        },
                    ))
                    .child(rail_button(
                        "◎",
                        self.library == Some(Library::Connections),
                        cx,
                        |this, _| this.toggle_library(Library::Connections),
                    ))
                    .child(rail_button(
                        "▦",
                        self.library == Some(Library::Workspaces),
                        cx,
                        |this, _| this.toggle_library(Library::Workspaces),
                    ))
                    .child(rail_button(
                        "</>",
                        self.library == Some(Library::Snippets),
                        cx,
                        |this, _| this.toggle_library(Library::Snippets),
                    )),
            )
            .child(div().flex_1())
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(4.))
                    .child(div().w(px(18.)).h(px(1.)).bg(theme::border()))
                    .child(rail_button("⎇", self.git_open, cx, |this, _| {
                        this.git_open = !this.git_open;
                        if this.git_open {
                            this.git = git_snapshot(&this.work_dir);
                        }
                    }))
                    .when(changes > 0, |el| {
                        el.child(
                            div()
                                .text_xs()
                                .text_color(theme::warn())
                                .child(changes.to_string()),
                        )
                    })
                    .child(rail_button("●", false, cx, |this, _| {
                        this.status = "Dictation stays on the Electron app for now".into();
                    }))
                    .child(rail_button(
                        "?",
                        self.modal == Some(Modal::Shortcuts),
                        cx,
                        |this, _| {
                            this.modal = Some(Modal::Shortcuts);
                        },
                    ))
                    .child(rail_button(
                        "⚙",
                        self.modal == Some(Modal::Settings),
                        cx,
                        |this, _| {
                            this.modal = Some(Modal::Settings);
                        },
                    )),
            )
    }

    fn render_library(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let Some(library) = self.library else {
            return div().into_any_element();
        };
        let title = match library {
            Library::Files => "Files",
            Library::Connections => "Connections",
            Library::Workspaces => "Workspaces",
            Library::Snippets => "Snippets",
        };
        let mut body: Vec<AnyElement> = Vec::new();
        match library {
            Library::Files => {
                body.push(
                    div()
                        .text_xs()
                        .text_color(theme::muted())
                        .pb(px(8.))
                        .child(display_path(&self.files_cwd))
                        .into_any_element(),
                );
                if self.files_cwd.parent().is_some() {
                    body.push(self.file_row("..", true, cx));
                }
                let rows: Vec<(String, bool)> = self
                    .file_rows
                    .iter()
                    .map(|row| (row.name.clone(), row.dir))
                    .collect();
                for (name, dir) in rows {
                    body.push(self.file_row(&name, dir, cx));
                }
            }
            Library::Connections => {
                body.push(
                    button("Import SSH config", false, cx, |this, _| {
                        this.reload_ssh();
                        this.status = if this.ssh_hosts.is_empty() {
                            "No concrete hosts in ~/.ssh/config".into()
                        } else {
                            format!("Imported {} host(s)", this.ssh_hosts.len())
                        };
                    })
                    .into_any_element(),
                );
                if self.ssh_hosts.is_empty() {
                    body.push(empty_copy(
                        "No saved connections. Import reads concrete Host names from ~/.ssh/config.",
                    ));
                }
                let hosts = self.ssh_hosts.clone();
                for host in hosts {
                    let subtitle = match (&host.user, &host.host_name) {
                        (Some(user), Some(name)) => format!("{user}@{name}"),
                        (None, Some(name)) => name.clone(),
                        (Some(user), None) => user.clone(),
                        (None, None) => host.name.clone(),
                    };
                    let label = host.name.clone();
                    body.push(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .px(px(8.))
                            .py(px(8.))
                            .rounded(px(6.))
                            .hover(|style| style.bg(theme::hover()))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w(px(0.))
                                    .child(div().text_sm().child(label.clone()))
                                    .child(
                                        div().text_xs().text_color(theme::muted()).child(subtitle),
                                    ),
                            )
                            .child(button("Connect", true, cx, move |this, _| {
                                this.status = format!(
                                    "{label} is listed. SSH sessions land with the russh port."
                                );
                            }))
                            .into_any_element(),
                    );
                }
            }
            Library::Workspaces => {
                body.push(empty_copy(
                    "No workspaces yet. The group bar Save button is the same action as the Electron app; the workspace file is not written in this slice.",
                ));
            }
            Library::Snippets => {
                for (name, detail, body_text) in SNIPPETS {
                    let payload = (*body_text).to_string();
                    let name = (*name).to_string();
                    body.push(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .px(px(8.))
                            .py(px(8.))
                            .rounded(px(6.))
                            .hover(|style| style.bg(theme::hover()))
                            .child(
                                div().flex_1().child(div().text_sm().child(name)).child(
                                    div()
                                        .text_xs()
                                        .text_color(theme::muted())
                                        .font_family("Cascadia Mono")
                                        .child((*detail).to_string()),
                                ),
                            )
                            .child(button("Run", true, cx, move |this, _| {
                                this.write_active(payload.as_bytes());
                                this.status = "Sent snippet to the active terminal".into();
                            }))
                            .into_any_element(),
                    );
                }
            }
        }
        div()
            .w(px(280.))
            .h_full()
            .flex()
            .flex_col()
            .bg(theme::panel())
            .border_r_1()
            .border_color(theme::border())
            .p(px(12.))
            .gap(px(6.))
            .child(div().text_size(px(15.)).pb(px(6.)).child(title))
            .child(
                div()
                    .w_full()
                    .px(px(10.))
                    .py(px(6.))
                    .rounded(px(6.))
                    .bg(theme::bg())
                    .border_1()
                    .border_color(theme::border())
                    .text_color(theme::muted())
                    .text_xs()
                    .child("Filter"),
            )
            .children(body)
            .into_any_element()
    }

    fn file_row(&self, name: &str, dir: bool, cx: &mut Context<Self>) -> AnyElement {
        let label = name.to_string();
        let cwd = self.files_cwd.clone();
        div()
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(8.))
            .py(px(6.))
            .rounded(px(6.))
            .hover(|style| style.bg(theme::hover()))
            .child(
                div()
                    .text_color(theme::accent())
                    .child(if dir { "▸" } else { "·" }),
            )
            .child(div().text_sm().child(label.clone()))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, _, _, cx| {
                    if !dir {
                        this.status =
                            format!("{label} is listed. The editor opens in a later slice.");
                        cx.notify();
                        return;
                    }
                    let next = if label == ".." {
                        cwd.parent().unwrap_or(&cwd).to_path_buf()
                    } else {
                        cwd.join(&label)
                    };
                    this.files_cwd = next;
                    this.reload_files();
                    cx.notify();
                }),
            )
            .into_any_element()
    }

    fn render_center(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let group_bar = self.render_group_bar(cx);
        let welcome = self.render_welcome(cx);
        let panes = self.render_panes(window, cx);
        let activity = self.activity_open.then(|| {
            dock_note(
                "Activity",
                "No agent activity yet. The bridge log arrives with the agent process.",
            )
        });
        let transfers = self.transfers_open.then(|| {
            dock_note("Transfers", "No transfers. The persistent SFTP queue stays on the Electron app until russh-sftp is wired.")
        });
        let status = self.render_status(cx);
        div()
            .flex_1()
            .min_w(px(0.))
            .h_full()
            .flex()
            .flex_col()
            .bg(theme::bg())
            .child(group_bar)
            .children(welcome)
            .child(panes)
            .children(activity)
            .children(transfers)
            .child(status)
    }

    fn render_group_bar(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let mut tabs: Vec<AnyElement> = Vec::new();
        let groups: Vec<(u64, String, usize, bool)> = self
            .groups
            .iter()
            .map(|group| {
                let count: usize = group.panes.iter().map(|pane| pane.tabs.len()).sum();
                (
                    group.id,
                    group.name.clone(),
                    count,
                    group.id == self.active_group,
                )
            })
            .collect();
        for (id, name, count, active) in groups {
            let closable = id != self.home_group;
            tabs.push(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .px(px(10.))
                    .py(px(4.))
                    .rounded(px(4.))
                    .text_xs()
                    .text_color(if active { theme::fg() } else { theme::muted() })
                    .when(active, |el| el.bg(theme::group_active()))
                    .hover(|style| style.text_color(theme::fg()))
                    .child("▦")
                    .child(name)
                    .child(
                        div()
                            .px(px(6.))
                            .rounded(px(8.))
                            .bg(theme::hover())
                            .text_size(px(10.))
                            .child(count.to_string()),
                    )
                    .when(closable, |el| {
                        el.child(
                            div()
                                .text_color(theme::muted())
                                .hover(|style| style.text_color(theme::danger()))
                                .child("×")
                                .on_mouse_down(
                                    MouseButton::Left,
                                    cx.listener(move |this, _, _, cx| {
                                        this.close_group(id);
                                        cx.stop_propagation();
                                        cx.notify();
                                    }),
                                ),
                        )
                    })
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, _, _, cx| {
                            this.active_group = id;
                            cx.notify();
                        }),
                    )
                    .into_any_element(),
            );
        }
        div()
            .h(px(26.))
            .flex()
            .items_center()
            .gap(px(2.))
            .px(px(6.))
            .bg(theme::bg())
            .border_b_1()
            .border_color(theme::border())
            .children(tabs)
            .child(
                div()
                    .px(px(8.))
                    .text_color(theme::muted())
                    .hover(|style| style.text_color(theme::fg()))
                    .child("+")
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, _, _, cx| {
                            this.new_group(cx);
                            cx.notify();
                        }),
                    ),
            )
            .child(div().flex_1())
            .child(
                div()
                    .px(px(8.))
                    .py(px(2.))
                    .rounded(px(4.))
                    .border_1()
                    .border_color(theme::border())
                    .text_xs()
                    .text_color(theme::muted())
                    .child("Save")
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, _, _, cx| {
                            this.library = Some(Library::Workspaces);
                            this.status = "Workspace save is not written in this slice yet".into();
                            cx.notify();
                        }),
                    ),
            )
    }

    fn render_welcome(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.welcome_dismissed {
            return None;
        }
        let local_done = self
            .sessions
            .values()
            .any(|session| session.live.is_some() || session.exited);
        let cards = vec![
            welcome_card(
                "Local terminal",
                "A shell in this group, ready to type.",
                local_done,
                "Open",
                cx,
                |this, cx| this.new_tab(cx),
            ),
            welcome_card(
                "SSH connection",
                "Import SSH config or save a host.",
                self.ssh_done,
                "Add",
                cx,
                |this, _| {
                    this.library = Some(Library::Connections);
                    this.reload_ssh();
                },
            ),
            welcome_card(
                "DevTerm Agent",
                "Runs on this PC and works over SSH.",
                self.agent_done,
                "Start",
                cx,
                |this, _| {
                    this.agent_open = true;
                    this.agent_done = true;
                    this.status = "Agent column open".into();
                },
            ),
        ];
        Some(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .p(px(12.))
                .border_b_1()
                .border_color(theme::border())
                .bg(theme::bg())
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(12.))
                        .child(div().text_sm().child("Getting started"))
                        .child(div().flex_1())
                        .child(hint_key("Ctrl+K", "palette"))
                        .child(hint_key("Ctrl+Shift+T", "new terminal"))
                        .child(hint_key("Ctrl+,", "settings"))
                        .child(
                            div()
                                .px(px(8.))
                                .py(px(2.))
                                .rounded(px(4.))
                                .border_1()
                                .border_color(theme::border())
                                .text_xs()
                                .text_color(theme::muted())
                                .child("Dismiss")
                                .on_mouse_down(
                                    MouseButton::Left,
                                    cx.listener(|this, _, _, cx| {
                                        this.welcome_dismissed = true;
                                        cx.notify();
                                    }),
                                ),
                        ),
                )
                .child(div().flex().gap(px(8.)).children(cards))
                .into_any_element(),
        )
    }

    fn render_panes(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let group = self
            .groups
            .iter()
            .find(|group| group.id == self.active_group)
            .cloned();
        let Some(group) = group else {
            return div().flex_1().into_any_element();
        };
        if group.panes.is_empty() {
            return div()
                .flex_1()
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(8.))
                        .child(div().text_sm().child("Empty group"))
                        .child(
                            div()
                                .text_xs()
                                .text_color(theme::muted())
                                .child("Open a terminal in this group."),
                        )
                        .child(button("New terminal", true, cx, |this, cx| {
                            this.new_tab(cx)
                        })),
                )
                .into_any_element();
        }
        let mut panes: Vec<AnyElement> = Vec::new();
        for (index, pane) in group.panes.iter().enumerate() {
            panes.push(self.render_pane(index, pane, index == group.active_pane, cx));
        }
        let agent = self.agent_open.then(|| self.render_agent(cx));
        div()
            .flex_1()
            .min_h(px(0.))
            .min_w(px(0.))
            .overflow_hidden()
            .flex()
            .flex_row()
            .children(panes)
            .children(agent)
            .into_any_element()
    }

    fn render_pane(
        &self,
        index: usize,
        pane: &Pane,
        active_pane: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut tabs: Vec<AnyElement> = Vec::new();
        for session_id in &pane.tabs {
            let Some(session) = self.sessions.get(session_id) else {
                continue;
            };
            let selected = *session_id == pane.active;
            let title = session.title.clone();
            let id = *session_id;
            let dot = if session.exited {
                theme::danger()
            } else {
                theme::ok()
            };
            tabs.push(
                div()
                    .h_full()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .px(px(8.))
                    .text_xs()
                    .text_color(if selected {
                        theme::fg()
                    } else {
                        theme::muted()
                    })
                    .when(selected, |el| el.bg(theme::panel2()))
                    .child(div().w(px(6.)).h(px(6.)).rounded(px(3.)).bg(dot))
                    .child(title)
                    .child(
                        div()
                            .text_color(theme::muted())
                            .hover(|style| style.text_color(theme::danger()))
                            .child("×")
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(move |this, _, _, cx| {
                                    this.close_session(id);
                                    cx.stop_propagation();
                                    cx.notify();
                                }),
                            ),
                    )
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, _, window, cx| {
                            window.focus(&this.focus);
                            this.select_tab(index, id);
                            cx.notify();
                        }),
                    )
                    .into_any_element(),
            );
        }
        let session_id = pane.active;
        let lines = self.sessions.get(&session_id).map(|session| {
            let mut rows: Vec<AnyElement> = Vec::new();
            for row in 0..session.grid.rows {
                let cursor = (session.grid.cursor_row == row).then_some(session.grid.cursor_col);
                rows.push(term_line(&session.grid.line(row), cursor));
            }
            rows
        });
        let entity = cx.entity().clone();
        div()
            .flex_1()
            .min_w(px(0.))
            .h_full()
            .flex()
            .flex_col()
            .bg(theme::term_bg())
            .border_1()
            .border_color(if active_pane {
                theme::accent()
            } else {
                theme::border()
            })
            .child(
                div()
                    .h(px(28.))
                    .flex()
                    .items_center()
                    .gap(px(2.))
                    .px(px(4.))
                    .bg(theme::panel())
                    .border_b_1()
                    .border_color(if active_pane {
                        theme::accent()
                    } else {
                        theme::border()
                    })
                    .children(tabs)
                    .child(div().flex_1())
                    .child(strip_button("✦", cx, |this, _| {
                        this.agent_open = !this.agent_open;
                        this.agent_done = true;
                    }))
                    .child(strip_button("⧉", cx, |this, cx| this.split_right(cx)))
                    .child(strip_button("+", cx, |this, cx| this.new_tab(cx))),
            )
            .child(
                div()
                    .flex_1()
                    .min_h(px(0.))
                    .relative()
                    .overflow_hidden()
                    .p(px(8.))
                    .font_family("Cascadia Mono")
                    .text_size(px(13.))
                    .line_height(px(18.))
                    .text_color(theme::fg())
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, _, window, cx| {
                            window.focus(&this.focus);
                            this.select_tab(index, session_id);
                            cx.notify();
                        }),
                    )
                    .children(lines.unwrap_or_default())
                    .child(
                        canvas(
                            move |bounds, _, app| {
                                let cols = (bounds.size.width / px(7.8)).floor() as usize;
                                let rows = (bounds.size.height / px(18.)).floor() as usize;
                                let cols = cols.clamp(20, 400);
                                let rows = rows.clamp(4, 200);
                                let _ = entity.update(app, |shell, cx| {
                                    if shell.note_size(session_id, cols, rows) {
                                        cx.notify();
                                    }
                                });
                            },
                            |_, _, _, _| {},
                        )
                        .absolute()
                        .size_full(),
                    ),
            )
            .into_any_element()
    }

    fn render_agent(&self, cx: &mut Context<Self>) -> AnyElement {
        div()
            .w(px(320.))
            .h_full()
            .flex()
            .flex_col()
            .bg(theme::panel())
            .border_l_1()
            .border_color(theme::border())
            .child(
                div()
                    .h(px(28.))
                    .flex()
                    .items_center()
                    .px(px(10.))
                    .gap(px(8.))
                    .border_b_1()
                    .border_color(theme::border())
                    .child(div().text_color(theme::accent()).child("✦"))
                    .child(div().text_xs().child("DevTerm"))
                    .child(div().flex_1())
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme::muted())
                            .child("Stop")
                            .on_mouse_down(MouseButton::Left, cx.listener(|this, _, _, cx| {
                                this.agent_open = false;
                                this.status = "Agent hidden".into();
                                cx.notify();
                            })),
                    ),
            )
            .child(
                div()
                    .p(px(12.))
                    .text_xs()
                    .text_color(theme::muted())
                    .child("This is the docked agent column. The bundled agent is still the Node runtime in the Electron app, so this column does not spawn it yet."),
            )
            .into_any_element()
    }

    fn render_status(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let exited = self
            .active_session_id()
            .and_then(|id| self.sessions.get(&id))
            .is_some_and(|session| session.exited);
        let left = if exited {
            "Local · Linux · exited".to_string()
        } else {
            format!("Local · Linux · {}", display_path(&self.work_dir))
        };
        div()
            .h(px(22.))
            .flex()
            .items_center()
            .gap(px(10.))
            .px(px(12.))
            .bg(theme::panel())
            .border_t_1()
            .border_color(theme::border())
            .text_size(px(11.))
            .text_color(theme::muted())
            .child(left)
            .when(!self.status.is_empty() && self.status != "Ready", |el| {
                el.child(self.status.clone())
            })
            .child(div().flex_1())
            .child(status_button(
                "Activity",
                self.activity_open,
                cx,
                |this, _| {
                    this.activity_open = !this.activity_open;
                },
            ))
            .child(status_button(
                "Transfers",
                self.transfers_open,
                cx,
                |this, _| {
                    this.transfers_open = !this.transfers_open;
                },
            ))
            .child(status_button("DevTerm", self.agent_open, cx, |this, _| {
                this.agent_open = !this.agent_open;
                this.agent_done = true;
            }))
    }

    fn render_git(&self, cx: &mut Context<Self>) -> AnyElement {
        if !self.git_open {
            return div().into_any_element();
        }
        let mut rows: Vec<AnyElement> = Vec::new();
        if let Some(git) = &self.git {
            rows.push(
                div()
                    .text_sm()
                    .child(format!("⎇ {}", git.branch))
                    .into_any_element(),
            );
            if git.changes.is_empty() {
                rows.push(empty_copy("Working tree clean."));
            }
            for change in &git.changes {
                rows.push(
                    div()
                        .text_xs()
                        .font_family("Cascadia Mono")
                        .child(change.clone())
                        .into_any_element(),
                );
            }
        } else {
            rows.push(empty_copy("This folder is not a git repository."));
        }
        div()
            .w(px(280.))
            .h_full()
            .flex()
            .flex_col()
            .bg(theme::panel())
            .border_l_1()
            .border_color(theme::border())
            .p(px(12.))
            .gap(px(6.))
            .child(div().text_size(px(15.)).child("Git"))
            .child(button("Refresh", false, cx, |this, _| {
                this.git = git_snapshot(&this.work_dir);
            }))
            .children(rows)
            .into_any_element()
    }

    fn render_modal(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let modal = self.modal?;
        let (title, body) = match modal {
            Modal::Settings => ("Settings", settings_body()),
            Modal::Shortcuts => ("Keyboard shortcuts", shortcuts_body()),
            Modal::Palette => ("Command palette", palette_body(cx)),
        };
        Some(
            div()
                .absolute()
                .top(px(0.))
                .left(px(0.))
                .right(px(0.))
                .bottom(px(0.))
                .flex()
                .items_center()
                .justify_center()
                .bg(rgba(0x101018cc))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|this, _, _, cx| {
                        this.modal = None;
                        cx.notify();
                    }),
                )
                .child(
                    div()
                        .w(px(460.))
                        .max_h(px(520.))
                        .bg(theme::panel())
                        .border_1()
                        .border_color(theme::border())
                        .rounded(px(8.))
                        .p(px(16.))
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .child(div().text_size(px(15.)).child(title))
                                .child(div().flex_1())
                                .child(div().text_color(theme::muted()).child("×").on_mouse_down(
                                    MouseButton::Left,
                                    cx.listener(|this, _, _, cx| {
                                        this.modal = None;
                                        cx.notify();
                                    }),
                                )),
                        )
                        .child(body),
                )
                .into_any_element(),
        )
    }
}

impl Focusable for Shell {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let rail = self.render_rail(cx);
        let library = self.render_library(cx);
        let center = self.render_center(window, cx);
        let git = self.render_git(cx);
        let modal = self.render_modal(cx);
        div()
            .id("devterm")
            .size_full()
            .relative()
            .flex()
            .flex_row()
            .bg(theme::bg())
            .text_color(theme::fg())
            .font_family("DejaVu Sans")
            .text_sm()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this, event, window, cx| this.on_key(event, window, cx)))
            .child(rail)
            .child(library)
            .child(center)
            .child(git)
            .children(modal)
    }
}

pub fn open(cx: &mut App) {
    let bounds = Bounds::centered(None, size(px(1280.), px(800.)), cx);
    cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions {
                title: Some("DevTerm".into()),
                appears_transparent: false,
                traffic_light_position: None,
            }),
            app_id: Some("com.devterm.app".into()),
            ..Default::default()
        },
        |window, cx| {
            let shell = cx.new(|cx| Shell::new(cx));
            shell.update(cx, |shell, _| {
                window.focus(&shell.focus);
            });
            shell
        },
    )
    .expect("open DevTerm window");
    cx.activate(true);
}

fn pump_pty(id: u64, rx: std::sync::mpsc::Receiver<PtyMsg>, cx: &mut Context<Shell>) {
    let rx = Arc::new(Mutex::new(rx));
    cx.spawn(async move |this, cx| loop {
        let rx = rx.clone();
        let msg = cx
            .background_executor()
            .spawn(async move { rx.lock().ok().and_then(|guard| guard.recv().ok()) })
            .await;
        let Some(msg) = msg else { break };
        let alive = this
            .update(cx, |shell, cx| {
                if let Some(session) = shell.sessions.get_mut(&id) {
                    match msg {
                        PtyMsg::Data(bytes) => session.grid.feed_bytes(&bytes),
                        PtyMsg::Exit => {
                            session.exited = true;
                            session.live = None;
                            session.grid.feed_bytes(b"\r\n[process exited]\r\n");
                        }
                    }
                }
                cx.notify();
            })
            .is_ok();
        if !alive {
            break;
        }
    })
    .detach();
}

fn spawn_shell() -> anyhow::Result<(LivePty, std::sync::mpsc::Receiver<PtyMsg>)> {
    let system = native_pty_system();
    let pair = system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let mut command = CommandBuilder::new(shell_program());
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    if let Ok(cwd) = std::env::current_dir() {
        command.cwd(cwd);
    }
    let child = pair.slave.spawn_command(command)?;
    let mut reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    let _ = tx.send(PtyMsg::Exit);
                    break;
                }
                Ok(n) => {
                    if tx.send(PtyMsg::Data(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(_) => {
                    let _ = tx.send(PtyMsg::Exit);
                    break;
                }
            }
        }
    });
    Ok((
        LivePty {
            writer: Arc::new(Mutex::new(writer)),
            master: pair.master,
            child,
        },
        rx,
    ))
}

fn shell_program() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
}

fn shell_title() -> String {
    Path::new(&shell_program())
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("shell")
        .to_string()
}

fn pty_bytes(event: &KeyDownEvent) -> Option<Vec<u8>> {
    let key = event.keystroke.key.as_str();
    let mods = &event.keystroke.modifiers;
    if mods.control && !mods.alt && !mods.platform && !mods.shift {
        if let Some(ch) = key.chars().next() {
            if ch.is_ascii_lowercase() {
                return Some(vec![ch as u8 - b'a' + 1]);
            }
        }
    }
    match key {
        "enter" | "return" => Some(b"\r".to_vec()),
        "backspace" => Some(vec![0x7f]),
        "tab" => Some(b"\t".to_vec()),
        "escape" => Some(vec![0x1b]),
        "up" => Some(b"\x1b[A".to_vec()),
        "down" => Some(b"\x1b[B".to_vec()),
        "right" => Some(b"\x1b[C".to_vec()),
        "left" => Some(b"\x1b[D".to_vec()),
        "home" => Some(b"\x1b[H".to_vec()),
        "end" => Some(b"\x1b[F".to_vec()),
        "pageup" => Some(b"\x1b[5~".to_vec()),
        "pagedown" => Some(b"\x1b[6~".to_vec()),
        "delete" => Some(b"\x1b[3~".to_vec()),
        _ => {
            if mods.control || mods.alt || mods.platform {
                None
            } else {
                event
                    .keystroke
                    .key_char
                    .clone()
                    .map(|text| text.into_bytes())
            }
        }
    }
}

fn list_dir(path: &Path) -> Vec<FileRow> {
    let Ok(entries) = std::fs::read_dir(path) else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        rows.push(FileRow { name, dir });
        if rows.len() == 300 {
            break;
        }
    }
    rows.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.cmp(&b.name)));
    rows
}

fn load_ssh_hosts() -> Vec<SshHost> {
    let Some(home) = std::env::var_os("HOME") else {
        return Vec::new();
    };
    let path = PathBuf::from(home).join(".ssh").join("config");
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    parse_ssh_config(&text)
}

fn git_snapshot(cwd: &Path) -> Option<GitSnapshot> {
    let output = std::process::Command::new("git")
        .args(["status", "--porcelain=v1", "-b"])
        .current_dir(cwd)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut branch = "detached".to_string();
    let mut changes = Vec::new();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            branch = rest.split("...").next().unwrap_or(rest).to_string();
        } else if !line.is_empty() {
            changes.push(line.to_string());
        }
    }
    Some(GitSnapshot { branch, changes })
}

fn display_path(path: &Path) -> String {
    if let Some(home) = std::env::var_os("HOME") {
        if let Ok(rest) = path.strip_prefix(&home) {
            if rest.as_os_str().is_empty() {
                return "~".into();
            }
            return format!("~/{}", rest.display());
        }
    }
    path.display().to_string()
}

fn rail_button(
    glyph: &'static str,
    active: bool,
    cx: &mut Context<Shell>,
    on_press: impl Fn(&mut Shell, &mut Context<Shell>) + 'static,
) -> gpui::Div {
    div()
        .w(px(32.))
        .h(px(32.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(4.))
        .text_color(if active { theme::fg() } else { theme::muted() })
        .when(active, |el| el.bg(theme::accent_quiet()))
        .hover(|style| style.bg(theme::hover()).text_color(theme::fg()))
        .child(glyph)
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |this, _, window, cx| {
                window.focus(&this.focus);
                on_press(this, cx);
                cx.notify();
            }),
        )
}

fn button(
    label: &'static str,
    primary: bool,
    cx: &mut Context<Shell>,
    on_press: impl Fn(&mut Shell, &mut Context<Shell>) + 'static,
) -> gpui::Div {
    div()
        .px(px(8.))
        .py(px(4.))
        .rounded(px(6.))
        .border_1()
        .border_color(if primary {
            theme::accent()
        } else {
            theme::border()
        })
        .text_xs()
        .when(primary, |el| el.bg(theme::accent_quiet()))
        .hover(|style| style.bg(theme::hover()))
        .child(label)
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |this, _, _, cx| {
                on_press(this, cx);
                cx.notify();
            }),
        )
}

fn strip_button(
    glyph: &'static str,
    cx: &mut Context<Shell>,
    on_press: impl Fn(&mut Shell, &mut Context<Shell>) + 'static,
) -> gpui::Div {
    div()
        .w(px(24.))
        .h(px(24.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(4.))
        .text_color(theme::muted())
        .hover(|style| style.bg(theme::hover()).text_color(theme::fg()))
        .child(glyph)
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |this, _, window, cx| {
                window.focus(&this.focus);
                on_press(this, cx);
                cx.notify();
            }),
        )
}

fn status_button(
    label: &'static str,
    active: bool,
    cx: &mut Context<Shell>,
    on_press: impl Fn(&mut Shell, &mut Context<Shell>) + 'static,
) -> gpui::Div {
    div()
        .text_color(if active { theme::fg() } else { theme::muted() })
        .hover(|style| style.text_color(theme::fg()))
        .child(label)
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |this, _, _, cx| {
                on_press(this, cx);
                cx.notify();
            }),
        )
}

fn welcome_card(
    title: &'static str,
    copy: &'static str,
    done: bool,
    action: &'static str,
    cx: &mut Context<Shell>,
    on_press: impl Fn(&mut Shell, &mut Context<Shell>) + 'static,
) -> AnyElement {
    div()
        .flex_1()
        .min_w(px(0.))
        .h(px(56.))
        .flex()
        .items_center()
        .gap(px(10.))
        .px(px(10.))
        .rounded(px(6.))
        .bg(theme::panel2())
        .border_1()
        .border_color(theme::border())
        .when(!done, |el| {
            el.hover(|style| style.border_color(theme::accent()))
        })
        .child(
            div()
                .w(px(28.))
                .h(px(28.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(4.))
                .bg(if done {
                    rgba(0x9ece6a2e)
                } else {
                    theme::accent_quiet()
                })
                .text_color(if done { theme::ok() } else { theme::accent() })
                .child(if done { "✓" } else { "●" }),
        )
        .child(
            div()
                .flex_1()
                .min_w(px(0.))
                .child(div().text_xs().text_color(theme::fg()).child(title))
                .child(
                    div()
                        .text_size(px(11.))
                        .text_color(theme::muted())
                        .child(copy),
                ),
        )
        .child(
            div()
                .text_xs()
                .text_color(if done { theme::ok() } else { theme::fg() })
                .child(if done { "Done" } else { action }),
        )
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |this, _, _, cx| {
                if done {
                    return;
                }
                on_press(this, cx);
                cx.notify();
            }),
        )
        .into_any_element()
}

fn hint_key(chord: &'static str, label: &'static str) -> gpui::Div {
    div()
        .flex()
        .items_center()
        .gap(px(4.))
        .text_size(px(11.))
        .text_color(theme::muted())
        .child(
            div()
                .px(px(5.))
                .rounded(px(4.))
                .bg(theme::panel2())
                .font_family("Cascadia Mono")
                .text_color(theme::fg())
                .child(chord),
        )
        .child(label)
}

fn dock_note(title: &'static str, body: &'static str) -> AnyElement {
    div()
        .h(px(72.))
        .px(px(12.))
        .py(px(8.))
        .bg(theme::panel())
        .border_t_1()
        .border_color(theme::border())
        .child(div().text_xs().text_color(theme::fg()).child(title))
        .child(
            div()
                .text_size(px(11.))
                .text_color(theme::muted())
                .child(body),
        )
        .into_any_element()
}

fn empty_copy(text: &'static str) -> AnyElement {
    div()
        .text_xs()
        .text_color(theme::muted())
        .child(text)
        .into_any_element()
}

fn term_line(line: &str, cursor: Option<usize>) -> AnyElement {
    let chars: Vec<char> = line.chars().collect();
    let row = div().h(px(18.)).flex().flex_row().whitespace_nowrap();
    let Some(col) = cursor else {
        let trimmed = line.trim_end();
        return row.child(trimmed.to_string()).into_any_element();
    };
    let before: String = chars.iter().take(col).collect();
    let current = chars.get(col).copied().unwrap_or(' ');
    let after: String = chars.iter().skip(col + 1).collect::<String>();
    let after = after.trim_end().to_string();
    row.child(before)
        .child(
            div()
                .bg(theme::accent())
                .text_color(theme::bg())
                .child(current.to_string()),
        )
        .child(after)
        .into_any_element()
}

fn settings_body() -> AnyElement {
    div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .text_xs()
        .child(div().child("Theme · Tokyo Night"))
        .child(div().text_color(theme::muted()).child(
            "The same boot palette as the Electron app. The other eight themes move over with the settings store.",
        ))
        .child(div().child("Agent · DevTerm"))
        .child(div().text_color(theme::muted()).child(
            "The bundled agent is still the Node runtime. External CLIs stay launch-on-a-PTY work.",
        ))
        .into_any_element()
}

fn shortcuts_body() -> AnyElement {
    let rows = [
        ("Ctrl+K", "Command palette"),
        ("Ctrl+Shift+T", "New terminal"),
        ("Ctrl+Shift+N", "New group"),
        ("Ctrl+Shift+W", "Close terminal"),
        ("Ctrl+Shift+E", "Files"),
        ("Ctrl+Alt+G", "Git panel"),
        ("Ctrl+,", "Settings"),
        ("Ctrl+/", "Keyboard shortcuts"),
        ("Esc", "Close dialog"),
    ];
    let mut list: Vec<AnyElement> = Vec::new();
    for (chord, label) in rows {
        list.push(
            div()
                .flex()
                .items_center()
                .gap(px(12.))
                .child(
                    div()
                        .w(px(120.))
                        .font_family("Cascadia Mono")
                        .text_color(theme::fg())
                        .child(chord),
                )
                .child(div().text_color(theme::muted()).child(label))
                .into_any_element(),
        );
    }
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .text_xs()
        .children(list)
        .into_any_element()
}

fn palette_body(cx: &mut Context<Shell>) -> AnyElement {
    let actions: [(&str, fn(&mut Shell, &mut Context<Shell>)); 5] = [
        ("New terminal", |this, cx| this.new_tab(cx)),
        ("New group", |this, cx| this.new_group(cx)),
        ("Toggle files", |this, _| {
            this.toggle_library(Library::Files)
        }),
        ("Toggle git", |this, _| {
            this.git_open = !this.git_open;
            if this.git_open {
                this.git = git_snapshot(&this.work_dir);
            }
        }),
        ("Settings", |this, _| this.modal = Some(Modal::Settings)),
    ];
    let mut rows: Vec<AnyElement> = Vec::new();
    for (label, action) in actions {
        rows.push(
            div()
                .px(px(8.))
                .py(px(6.))
                .rounded(px(4.))
                .text_sm()
                .hover(|style| style.bg(theme::hover()))
                .child(label)
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, _, _, cx| {
                        action(this, cx);
                        if !matches!(this.modal, Some(Modal::Settings)) {
                            this.modal = None;
                        }
                        cx.notify();
                    }),
                )
                .into_any_element(),
        );
    }
    div()
        .flex()
        .flex_col()
        .gap(px(2.))
        .children(rows)
        .into_any_element()
}
