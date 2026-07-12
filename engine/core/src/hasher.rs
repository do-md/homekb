use sha2::{Digest, Sha256};

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

#[allow(dead_code)]
pub fn sha256_str(s: &str) -> String {
    sha256_hex(s.as_bytes())
}
