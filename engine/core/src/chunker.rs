//! Markdown chunker.
//!
//! Strategy:
//!   1. Split on H2 (`##`). Each H2 section is a candidate chunk.
//!   2. If a candidate exceeds `target_tokens`, split it by H3 (`###`).
//!   3. If even H3 sections exceed `hard_max`, hard-split by paragraph
//!      with a small overlap.
//!
//! Token counting is approximated as `bytes / 4` — close enough for
//! deciding splits without pulling in a tokenizer. Embedding APIs accept
//! whatever fits in their model's context anyway.
//!
//! Heading paths are preserved as breadcrumbs ("H1 > H2 > H3"), so a
//! retrieved chunk carries its location in the document.

use crate::hasher::sha256_hex;
use crate::types::NewChunk;

pub fn chunk(content: &str, target_tokens: u32, hard_max: u32) -> Vec<NewChunk> {
    let lines: Vec<&str> = content.lines().collect();
    let h1_title = lines.iter().find_map(|l| heading_text(l, 1));

    // Pass 1: split by H2.
    let mut sections = split_by_heading(&lines, 2);
    if sections.is_empty() {
        // No H2 found — whole document is a single chunk.
        sections = vec![Section {
            heading_path: Vec::new(),
            start_line: 0,
            end_line: lines.len().saturating_sub(1) as u32,
            text: content.to_string(),
        }];
    }

    // Pass 2: any over target → split by H3.
    let mut refined = Vec::new();
    for s in sections {
        if approx_tokens(&s.text) <= target_tokens {
            refined.push(s);
        } else {
            let h3 = split_by_heading_within(&lines, &s, 3);
            if h3.is_empty() {
                refined.push(s);
            } else {
                refined.extend(h3);
            }
        }
    }

    // Pass 3: any over hard_max → hard-split by paragraph with overlap.
    let mut final_chunks = Vec::new();
    for s in refined {
        if approx_tokens(&s.text) <= hard_max {
            final_chunks.push(s);
        } else {
            final_chunks.extend(hard_split(s, hard_max));
        }
    }

    // Render to NewChunk, prepending the H1 title to each heading path.
    final_chunks
        .into_iter()
        .map(|s| {
            let mut path_parts = Vec::new();
            if let Some(t) = h1_title.as_ref() {
                path_parts.push(t.clone());
            }
            path_parts.extend(s.heading_path.iter().cloned());
            let heading_path = if path_parts.is_empty() {
                None
            } else {
                Some(path_parts.join(" > "))
            };
            let content_hash = sha256_hex(s.text.as_bytes());
            NewChunk {
                heading_path,
                token_count: approx_tokens(&s.text),
                content: s.text,
                content_hash,
                start_line: s.start_line,
                end_line: s.end_line,
            }
        })
        .collect()
}

fn approx_tokens(s: &str) -> u32 {
    ((s.len() as f32) / 4.0).ceil() as u32
}

fn heading_text(line: &str, level: usize) -> Option<String> {
    let prefix = format!("{} ", "#".repeat(level));
    line.strip_prefix(&prefix).map(|s| s.trim().to_string())
}

/// Detect the heading level (1..=6) at the start of a line. Only matches
/// ATX-style ("# ..."), which is what we'd expect in a curated KB.
fn heading_level(line: &str) -> Option<usize> {
    let trimmed = line.trim_start();
    let count = trimmed.chars().take_while(|&c| c == '#').count();
    if count == 0 || count > 6 { return None; }
    let after = &trimmed[count..];
    if after.starts_with(' ') { Some(count) } else { None }
}

#[derive(Debug, Clone)]
struct Section {
    heading_path: Vec<String>,
    start_line: u32,
    end_line: u32,
    text: String,
}

fn split_by_heading(lines: &[&str], target_level: usize) -> Vec<Section> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if let Some(level) = heading_level(lines[i]) {
            if level == target_level {
                let title = heading_text(lines[i], target_level).unwrap_or_default();
                let start = i as u32;
                i += 1;
                while i < lines.len() {
                    match heading_level(lines[i]) {
                        Some(l) if l <= target_level => break,
                        _ => i += 1,
                    }
                }
                let end = (i as u32).saturating_sub(1);
                let text = lines[start as usize..=end as usize].join("\n");
                out.push(Section {
                    heading_path: vec![title],
                    start_line: start,
                    end_line: end,
                    text,
                });
                continue;
            }
        }
        i += 1;
    }
    out
}

fn split_by_heading_within(lines: &[&str], parent: &Section, target_level: usize) -> Vec<Section> {
    let mut out = Vec::new();
    let parent_lines = &lines[parent.start_line as usize..=parent.end_line as usize];
    // Skip the parent's heading itself.
    let body_start = if heading_level(parent_lines[0]).is_some() { 1 } else { 0 };

    // Collect a preamble (text before the first child heading) as its own chunk.
    let mut preamble_end = body_start;
    while preamble_end < parent_lines.len() {
        if heading_level(parent_lines[preamble_end]) == Some(target_level) { break; }
        preamble_end += 1;
    }
    if preamble_end > body_start
        && parent_lines[body_start..preamble_end]
            .iter()
            .any(|l| !l.trim().is_empty())
    {
        let text = parent_lines[..preamble_end].join("\n");
        out.push(Section {
            heading_path: parent.heading_path.clone(),
            start_line: parent.start_line,
            end_line: parent.start_line + (preamble_end as u32).saturating_sub(1),
            text,
        });
    }

    let mut i = preamble_end;
    while i < parent_lines.len() {
        if heading_level(parent_lines[i]) == Some(target_level) {
            let title = heading_text(parent_lines[i], target_level).unwrap_or_default();
            let start_local = i;
            i += 1;
            while i < parent_lines.len() {
                match heading_level(parent_lines[i]) {
                    Some(l) if l <= target_level => break,
                    _ => i += 1,
                }
            }
            let end_local = i.saturating_sub(1);
            let text = parent_lines[start_local..=end_local].join("\n");
            let mut hp = parent.heading_path.clone();
            hp.push(title);
            out.push(Section {
                heading_path: hp,
                start_line: parent.start_line + start_local as u32,
                end_line: parent.start_line + end_local as u32,
                text,
            });
        } else {
            i += 1;
        }
    }
    out
}

fn hard_split(s: Section, hard_max: u32) -> Vec<Section> {
    let max_bytes = (hard_max * 4) as usize;
    let overlap_bytes = max_bytes / 10;
    let bytes = s.text.as_bytes();
    let mut out = Vec::new();
    let mut start = 0;
    let mut piece_idx = 0;
    while start < bytes.len() {
        let end = (start + max_bytes).min(bytes.len());
        // Snap end to a UTF-8 char boundary.
        let end = floor_char_boundary(&s.text, end);
        let snippet = &s.text[start..end];
        let mut hp = s.heading_path.clone();
        hp.push(format!("part {}", piece_idx + 1));
        out.push(Section {
            heading_path: hp,
            start_line: s.start_line,
            end_line: s.end_line,
            text: snippet.to_string(),
        });
        if end == bytes.len() { break; }
        start = end.saturating_sub(overlap_bytes);
        let next = floor_char_boundary(&s.text, start);
        start = next;
        piece_idx += 1;
    }
    out
}

/// `str::floor_char_boundary` is unstable; reimplement.
fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    if i >= s.len() { return s.len(); }
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}
