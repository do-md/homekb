//! sqlite-vec registration + Vec<f32> codec helpers.
//!
//! The sqlite-vec extension must be loaded once per process before any
//! Connection is opened. We register it via `sqlite3_auto_extension`
//! so every subsequent Connection automatically has access to vec0.

use std::sync::Once;

static REGISTER: Once = Once::new();

pub fn ensure_registered() {
    REGISTER.call_once(|| {
        unsafe {
            rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
                sqlite_vec::sqlite3_vec_init as *const (),
            )));
        }
    });
}

/// Encode an f32 vector as a little-endian byte slice (sqlite-vec's BLOB format).
pub fn encode(v: &[f32]) -> Vec<u8> {
    bytemuck::cast_slice(v).to_vec()
}

/// Decode bytes back to f32. Length must be a multiple of 4.
#[allow(dead_code)]
pub fn decode(bytes: &[u8]) -> Vec<f32> {
    bytemuck::cast_slice(bytes).to_vec()
}
