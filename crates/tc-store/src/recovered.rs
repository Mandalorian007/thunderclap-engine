//! What recovery keeps in `recovered/`, never destroying anything: the
//! bytes cut off a log file.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::durable::{self, sync_dir};
use crate::error::StoreError;
use crate::{io_err, unix_now};

/// Copies the bytes `from..to` of `file` (at `path`) into a new file in
/// `dir`, named after the file, the range, and the time, and makes it
/// durable: what recovery cuts off a log file is kept, never destroyed.
pub(crate) fn save_tail(
    file: &File,
    path: &Path,
    from: u64,
    to: u64,
    dir: &Path,
) -> Result<PathBuf, StoreError> {
    use std::io::{Read, Seek, SeekFrom};
    let mut bytes = Vec::new();
    let mut reader = file;
    reader
        .seek(SeekFrom::Start(from))
        .and_then(|_| reader.take(to - from).read_to_end(&mut bytes))
        .map_err(io_err(path))?;
    let created = !dir.exists();
    fs::create_dir_all(dir).map_err(io_err(dir))?;
    if created && let Some(parent) = dir.parent() {
        sync_dir(parent)?;
    }
    let name = path
        .file_name()
        .map_or_else(|| "log".to_string(), |n| n.to_string_lossy().into_owned());
    // Only names the file: nothing reads it.
    let now = unix_now();
    let mut n = 0;
    loop {
        let suffix = if n == 0 {
            String::new()
        } else {
            format!(".{n}")
        };
        let saved = dir.join(format!("{name}.{from}-{to}.{now}{suffix}.tail"));
        match OpenOptions::new().write(true).create_new(true).open(&saved) {
            Ok(mut out) => {
                out.write_all(&bytes)
                    .and_then(|()| durable::full(&out, &saved))
                    .map_err(io_err(&saved))?;
                sync_dir(dir)?;
                return Ok(saved);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => n += 1,
            Err(e) => return Err(io_err(&saved)(e)),
        }
    }
}
