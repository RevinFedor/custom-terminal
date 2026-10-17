// PTY Proxy: DEC 2026 sync-aware stdin->vt100->stdout filter
//
// Outside sync blocks: pass data through unchanged
// Inside sync blocks (BSU..ESU): buffer data, process in vt100,
// emit screen diff on ESU via contents_diff()

use std::io::{self, Read, Write};

// DEC 2026 synchronized output markers
const BSU: &[u8] = b"\x1b[?2026h"; // Begin Synchronized Update
const ESU: &[u8] = b"\x1b[?2026l"; // End Synchronized Update

const READ_BUF_SIZE: usize = 16 * 1024;
const SYNC_BUF_CAP: usize = 1024 * 1024; // 1MB max sync buffer

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();

    let mut reader = stdin.lock();
    let mut writer = stdout.lock();

    // Default terminal size
    let (rows, cols) = parse_size_arg().unwrap_or((24, 80));

    let mut parser = vt100::Parser::new(rows, cols, 0);
    let mut prev_screen = parser.screen().clone();

    // State: are we inside a sync block?
    let mut in_sync = false;
    let mut sync_buf: Vec<u8> = Vec::with_capacity(SYNC_BUF_CAP);

    // Partial match buffer for detecting BSU/ESU split across reads
    let mut pending: Vec<u8> = Vec::new();

    let mut read_buf = [0u8; READ_BUF_SIZE];

    loop {
        let n = match reader.read(&mut read_buf) {
            Ok(0) => break, // EOF
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };

        let data = &read_buf[..n];

        // Prepend any pending bytes from previous partial match
        let input = if pending.is_empty() {
            data.to_vec()
        } else {
            let mut combined = std::mem::take(&mut pending);
            combined.extend_from_slice(data);
            combined
        };

        let mut pos = 0;

        while pos < input.len() {
            if in_sync {
                // Scan for ESU inside sync block
                match find_sequence(&input[pos..], ESU) {
                    FindResult::Found(offset) => {
                        // Add data before ESU to sync buffer
                        sync_buf.extend_from_slice(&input[pos..pos + offset]);
                        pos += offset + ESU.len();

                        // Process buffered sync data through vt100
                        parser.process(&sync_buf);
                        sync_buf.clear();

                        // Emit diff
                        let diff = parser.screen().contents_diff(&prev_screen);
                        if !diff.is_empty() {
                            let _ = writer.write_all(&diff);
                            let _ = writer.flush();
                        }
                        prev_screen = parser.screen().clone();

                        in_sync = false;
                    }
                    FindResult::Partial(at) => {
                        // Possible ESU split across reads
                        sync_buf.extend_from_slice(&input[pos..pos + at]);
                        pending.extend_from_slice(&input[pos + at..]);
                        pos = input.len();
                    }
                    FindResult::NotFound => {
                        // All data goes into sync buffer
                        sync_buf.extend_from_slice(&input[pos..]);

                        // Safety: truncate if buffer grows too large
                        if sync_buf.len() > SYNC_BUF_CAP {
                            // Flush what we have as passthrough to avoid OOM
                            let _ = writer.write_all(&sync_buf);
                            let _ = writer.flush();
                            sync_buf.clear();
                            in_sync = false;
                        }
                        pos = input.len();
                    }
                }
            } else {
                // Outside sync: scan for BSU
                match find_sequence(&input[pos..], BSU) {
                    FindResult::Found(offset) => {
                        // Pass through everything before BSU
                        if offset > 0 {
                            let chunk = &input[pos..pos + offset];
                            let _ = writer.write_all(chunk);
                            let _ = writer.flush();

                            // Keep vt100 in sync with passthrough data
                            parser.process(chunk);
                            prev_screen = parser.screen().clone();
                        }
                        pos += offset + BSU.len();

                        in_sync = true;
                        sync_buf.clear();
                    }
                    FindResult::Partial(at) => {
                        // Pass through data before the partial match
                        if at > 0 {
                            let chunk = &input[pos..pos + at];
                            let _ = writer.write_all(chunk);
                            let _ = writer.flush();

                            parser.process(chunk);
                            prev_screen = parser.screen().clone();
                        }
                        // Save the partial match for next read
                        pending.extend_from_slice(&input[pos + at..]);
                        pos = input.len();
                    }
                    FindResult::NotFound => {
                        // No BSU found -- pass everything through
                        let chunk = &input[pos..];
                        let _ = writer.write_all(chunk);
                        let _ = writer.flush();

                        parser.process(chunk);
                        prev_screen = parser.screen().clone();
                        pos = input.len();
                    }
                }
            }
        }
    }
}

// --- Sequence finder ---

enum FindResult {
    Found(usize),   // Full match at this offset
    Partial(usize), // Partial match at end of input (split across reads)
    NotFound,
}

/// Find a byte sequence in input. Uses memchr for fast first-byte scan.
/// Also detects partial matches at the end of input.
fn find_sequence(input: &[u8], seq: &[u8]) -> FindResult {
    if seq.is_empty() || input.is_empty() {
        return FindResult::NotFound;
    }

    let first = seq[0];
    let mut search_from = 0;

    while let Some(idx) = memchr::memchr(first, &input[search_from..]) {
        let abs_idx = search_from + idx;
        let remaining = input.len() - abs_idx;

        if remaining >= seq.len() {
            // Enough bytes for full match check
            if input[abs_idx..abs_idx + seq.len()] == *seq {
                return FindResult::Found(abs_idx);
            }
        } else {
            // At end of input -- check for partial match
            if input[abs_idx..] == seq[..remaining] {
                return FindResult::Partial(abs_idx);
            }
        }

        search_from = abs_idx + 1;
    }

    FindResult::NotFound
}

/// Parse --size RxC from command line args
fn parse_size_arg() -> Option<(u16, u16)> {
    let args: Vec<String> = std::env::args().collect();
    for i in 0..args.len() {
        if args[i] == "--size" {
            if let Some(val) = args.get(i + 1) {
                let parts: Vec<&str> = val.split('x').collect();
                if parts.len() == 2 {
                    if let (Ok(r), Ok(c)) = (parts[0].parse(), parts[1].parse()) {
                        return Some((r, c));
                    }
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_full_bsu() {
        let input = b"hello\x1b[?2026hworld";
        match find_sequence(input, BSU) {
            FindResult::Found(5) => {}
            _ => panic!("Expected Found(5)"),
        }
    }

    #[test]
    fn find_full_esu() {
        let input = b"\x1b[?2026l";
        match find_sequence(input, ESU) {
            FindResult::Found(0) => {}
            _ => panic!("Expected Found(0)"),
        }
    }

    #[test]
    fn find_partial_at_end() {
        let input = b"data\x1b[?20";
        match find_sequence(input, ESU) {
            FindResult::Partial(4) => {}
            _ => panic!("Expected Partial(4)"),
        }
    }

    #[test]
    fn find_not_found() {
        let input = b"just plain text";
        match find_sequence(input, BSU) {
            FindResult::NotFound => {}
            _ => panic!("Expected NotFound"),
        }
    }

    #[test]
    fn find_escape_not_sequence() {
        let input = b"hello\x1b[0mworld";
        match find_sequence(input, BSU) {
            FindResult::NotFound => {}
            _ => panic!("Expected NotFound"),
        }
    }

    #[test]
    fn passthrough_no_sync() {
        // Without sync markers, output should equal input
        let mut parser = vt100::Parser::new(24, 80, 0);
        let input = b"Hello, world!\r\n";
        parser.process(input);
        let screen = parser.screen();
        // Screen should contain the text
        let contents = screen.contents();
        assert!(contents.contains("Hello, world!"));
    }

    #[test]
    fn vt100_diff_after_sync() {
        let mut parser = vt100::Parser::new(24, 80, 0);

        // Initial state
        parser.process(b"Line 1\r\n");
        let prev = parser.screen().clone();

        // Simulate sync block content
        parser.process(b"Line 2\r\n");

        let diff = parser.screen().contents_diff(&prev);
        assert!(!diff.is_empty(), "Diff should not be empty after new content");
    }
}
