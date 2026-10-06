//! A small terminal grid.
//!
//! Enough of VT to show a login shell: printable text, cursor motion, erase,
//! and ignored color/mode sequences. A full parser (`alacritty_terminal`) is
//! the next step once this window matches the DevTerm chrome.

#[derive(Clone, Copy, PartialEq, Eq)]
enum VtState {
    Ground,
    Esc,
    Csi,
    Osc,
}

pub struct Grid {
    pub cols: usize,
    pub rows: usize,
    cells: Vec<char>,
    pub cursor_col: usize,
    pub cursor_row: usize,
    state: VtState,
    param: String,
    partial: Vec<u8>,
}

impl Grid {
    pub fn new(cols: usize, rows: usize) -> Self {
        let cols = cols.max(1);
        let rows = rows.max(1);
        Self {
            cols,
            rows,
            cells: vec![' '; cols * rows],
            cursor_col: 0,
            cursor_row: 0,
            state: VtState::Ground,
            param: String::new(),
            partial: Vec::new(),
        }
    }

    pub fn line(&self, row: usize) -> String {
        let start = row * self.cols;
        self.cells[start..start + self.cols].iter().collect()
    }

    pub fn resize(&mut self, cols: usize, rows: usize) {
        let cols = cols.max(1);
        let rows = rows.max(1);
        if cols == self.cols && rows == self.rows {
            return;
        }
        let mut next = vec![' '; cols * rows];
        let copy_rows = self.rows.min(rows);
        let copy_cols = self.cols.min(cols);
        for row in 0..copy_rows {
            let from = row * self.cols;
            let to = row * cols;
            next[to..to + copy_cols].copy_from_slice(&self.cells[from..from + copy_cols]);
        }
        self.cells = next;
        self.cols = cols;
        self.rows = rows;
        self.cursor_col = self.cursor_col.min(cols - 1);
        self.cursor_row = self.cursor_row.min(rows - 1);
    }

    pub fn feed_bytes(&mut self, bytes: &[u8]) {
        let mut buf = std::mem::take(&mut self.partial);
        buf.extend_from_slice(bytes);
        match String::from_utf8(buf) {
            Ok(text) => {
                for ch in text.chars() {
                    self.feed_char(ch);
                }
            }
            Err(err) => {
                let valid = err.utf8_error().valid_up_to();
                let error_len = err.utf8_error().error_len();
                let mut raw = err.into_bytes();
                let rest = raw.split_off(valid);
                if let Ok(text) = String::from_utf8(raw) {
                    for ch in text.chars() {
                        self.feed_char(ch);
                    }
                }
                if error_len.is_none() {
                    self.partial = rest;
                } else if let Some(len) = error_len {
                    let skip = len.min(rest.len());
                    self.feed_bytes(&rest[skip..]);
                }
            }
        }
    }

    fn feed_char(&mut self, ch: char) {
        match self.state {
            VtState::Ground => match ch {
                '\u{1b}' => self.state = VtState::Esc,
                '\n' => self.newline(),
                '\r' => self.cursor_col = 0,
                '\u{08}' => self.cursor_col = self.cursor_col.saturating_sub(1),
                '\t' => {
                    let stop = (self.cursor_col / 8 + 1) * 8;
                    self.cursor_col = stop.min(self.cols - 1);
                }
                c if (' '..='\u{10ffff}').contains(&c) && c != '\u{7f}' => self.put(c),
                _ => {}
            },
            VtState::Esc => match ch {
                '[' => {
                    self.state = VtState::Csi;
                    self.param.clear();
                }
                ']' => {
                    self.state = VtState::Osc;
                    self.param.clear();
                }
                _ => self.state = VtState::Ground,
            },
            VtState::Csi => {
                if ('@'..='~').contains(&ch) {
                    self.csi(ch);
                    self.state = VtState::Ground;
                } else {
                    self.param.push(ch);
                }
            }
            VtState::Osc => {
                if ch == '\u{07}' {
                    self.state = VtState::Ground;
                    self.param.clear();
                } else if ch == '\\' && self.param.ends_with('\u{1b}') {
                    self.state = VtState::Ground;
                    self.param.clear();
                } else {
                    self.param.push(ch);
                }
            }
        }
    }

    fn put(&mut self, ch: char) {
        if self.cursor_row >= self.rows {
            self.scroll();
        }
        let idx = self.cursor_row * self.cols + self.cursor_col;
        self.cells[idx] = ch;
        if self.cursor_col + 1 < self.cols {
            self.cursor_col += 1;
        } else {
            self.cursor_col = 0;
            self.newline();
        }
    }

    fn newline(&mut self) {
        if self.cursor_row + 1 >= self.rows {
            self.scroll();
        } else {
            self.cursor_row += 1;
        }
    }

    fn scroll(&mut self) {
        self.cells.drain(0..self.cols);
        self.cells.extend(std::iter::repeat(' ').take(self.cols));
        self.cursor_row = self.rows - 1;
    }

    fn csi(&mut self, final_byte: char) {
        let params = parse_params(&self.param);
        let nth = |index: usize, default: usize| -> usize {
            params
                .get(index)
                .copied()
                .filter(|value| *value > 0)
                .unwrap_or(default)
        };
        match final_byte {
            'A' => self.cursor_row = self.cursor_row.saturating_sub(nth(0, 1)),
            'B' => {
                self.cursor_row = (self.cursor_row + nth(0, 1)).min(self.rows - 1);
            }
            'C' => {
                self.cursor_col = (self.cursor_col + nth(0, 1)).min(self.cols - 1);
            }
            'D' => self.cursor_col = self.cursor_col.saturating_sub(nth(0, 1)),
            'G' => self.cursor_col = nth(0, 1).saturating_sub(1).min(self.cols - 1),
            'H' | 'f' => {
                self.cursor_row = nth(0, 1).saturating_sub(1).min(self.rows - 1);
                self.cursor_col = nth(1, 1).saturating_sub(1).min(self.cols - 1);
            }
            'J' => match params.first().copied().unwrap_or(0) {
                2 | 3 => self.cells.fill(' '),
                0 => self.clear_from_cursor(),
                _ => {}
            },
            'K' => self.clear_line_from_cursor(),
            _ => {}
        }
        self.param.clear();
    }

    fn clear_from_cursor(&mut self) {
        let start = self.cursor_row * self.cols + self.cursor_col;
        for cell in &mut self.cells[start..] {
            *cell = ' ';
        }
    }

    fn clear_line_from_cursor(&mut self) {
        let start = self.cursor_row * self.cols + self.cursor_col;
        let end = (self.cursor_row + 1) * self.cols;
        for cell in &mut self.cells[start..end] {
            *cell = ' ';
        }
    }
}

fn parse_params(raw: &str) -> Vec<usize> {
    let raw = raw.trim_start_matches(['?', '>', '!']);
    if raw.is_empty() {
        return Vec::new();
    }
    raw.split(';')
        .map(|part| {
            part.chars()
                .take_while(|ch| ch.is_ascii_digit())
                .collect::<String>()
                .parse()
                .unwrap_or(0)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::Grid;

    #[test]
    fn writes_text_and_moves_to_the_next_line() {
        let mut grid = Grid::new(8, 3);
        grid.feed_bytes(b"hi\r\nthere");
        assert_eq!(grid.line(0).trim_end(), "hi");
        assert_eq!(grid.line(1).trim_end(), "there");
        assert_eq!(grid.cursor_row, 1);
    }

    #[test]
    fn cursor_position_and_erase() {
        let mut grid = Grid::new(6, 2);
        grid.feed_bytes(b"abcdef");
        grid.feed_bytes(b"\x1b[1;1H");
        grid.feed_bytes(b"\x1b[J");
        assert_eq!(grid.line(0).trim_end(), "");
        assert_eq!(grid.cursor_row, 0);
        assert_eq!(grid.cursor_col, 0);
    }

    #[test]
    fn ignores_sgr_color_sequences() {
        let mut grid = Grid::new(8, 2);
        grid.feed_bytes(b"\x1b[32mOK\x1b[0m");
        assert_eq!(grid.line(0).trim_end(), "OK");
    }
}
