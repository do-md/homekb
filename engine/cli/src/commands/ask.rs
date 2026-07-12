//! `homekb ask` — one-shot Q&A: recall + LLM-synthesized answer.

use anyhow::Result;
use homekb_core::Config;
use std::io::Read;

pub fn run(question: Option<String>, json: bool) -> Result<()> {
    let question = match question {
        Some(q) => q,
        None => {
            let mut buf = String::new();
            std::io::stdin().read_to_string(&mut buf)?;
            buf
        }
    };
    let config = Config::load()?;
    let rt = super::runtime()?;
    let out = rt.block_on(homekb_core::ask(&config, &question))?;

    if json {
        println!("{}", serde_json::to_string_pretty(&out)?);
        return Ok(());
    }
    println!("{}", out.answer);
    if !out.citations.is_empty() {
        println!("\n—— 来源");
        for (i, c) in out.citations.iter().enumerate() {
            println!("[{}] {}（{}）", i + 1, c.title, c.path);
        }
    }
    Ok(())
}
