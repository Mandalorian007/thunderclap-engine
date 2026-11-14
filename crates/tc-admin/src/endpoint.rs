//! The endpoint file: where a running server's control channel listens and
//! the token its requests must carry. Only the server's user can read it
//! (on Unix; on Windows a user's files are the user's by default), so
//! whoever can read the file may control the server, and no one else.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::proto::ADMIN_VERSION;

/// The endpoint file's name, in the directory the server holds.
pub const ENDPOINT_FILE: &str = "admin.endpoint";

/// What [`ENDPOINT_FILE`] says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoint {
    /// The server's process id.
    pub pid: u32,
    /// The loopback port the channel listens on.
    pub port: u16,
    /// The protocol's version ([`ADMIN_VERSION`]).
    pub version: u32,
    /// The token requests must carry: 256 bits, hex.
    pub token: String,
}

impl Endpoint {
    /// An endpoint for this process on `port`, with a fresh token.
    pub fn fresh(port: u16) -> Endpoint {
        Endpoint {
            pid: std::process::id(),
            port,
            version: ADMIN_VERSION,
            token: new_token(),
        }
    }

    fn text(&self) -> String {
        format!(
            "pid {}\nport {}\nversion {}\ntoken {}\n",
            self.pid, self.port, self.version, self.token
        )
    }

    fn parse(text: &str) -> Option<Endpoint> {
        let (mut pid, mut port, mut version, mut token) = (None, None, None, None);
        for line in text.lines() {
            match line.split_once(' ') {
                Some(("pid", n)) => pid = n.trim().parse().ok(),
                Some(("port", n)) => port = n.trim().parse().ok(),
                Some(("version", n)) => version = n.trim().parse().ok(),
                Some(("token", t)) => token = Some(t.trim().to_string()),
                _ => {}
            }
        }
        Some(Endpoint {
            pid: pid?,
            port: port?,
            version: version?,
            token: token.filter(|t| !t.is_empty())?,
        })
    }

    /// The file in `dir`, if there is one and it reads.
    pub fn read(dir: &Path) -> Option<Endpoint> {
        Endpoint::parse(&std::fs::read_to_string(dir.join(ENDPOINT_FILE)).ok()?)
    }

    /// Writes it into `dir`: to a temporary file only its owner can read
    /// (on Unix), renamed over the old one. Returns the file's path.
    pub fn write(&self, dir: &Path) -> std::io::Result<PathBuf> {
        let path = dir.join(ENDPOINT_FILE);
        let tmp = dir.join(format!(".{ENDPOINT_FILE}.tmp"));
        // A leftover is removed first: the mode below applies only to a
        // file this call creates.
        let _ = std::fs::remove_file(&tmp);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        {
            use std::io::Write;
            let mut file = options.open(&tmp)?;
            file.write_all(self.text().as_bytes())?;
            file.sync_all()?;
        }
        std::fs::rename(&tmp, &path)?;
        Ok(path)
    }
}

/// `a == b`, taking as long whatever the first difference.
pub fn same_token(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

/// A fresh token: 256 bits, hex. Its randomness is the 128-bit key std's
/// `RandomState` takes from the OS once per thread (no new dependency),
/// hashed with the pid and the time.
pub fn new_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut sha = Sha256::new();
    for i in 0u64..4 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(i);
        sha.update(h.finish().to_le_bytes());
    }
    sha.update(std::process::id().to_le_bytes());
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    sha.update(nanos.to_le_bytes());
    sha.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_round_trips_and_is_the_owners() {
        let dir = std::env::temp_dir().join(format!("tc-admin-endpoint-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(Endpoint::read(&dir), None);
        let e = Endpoint::fresh(4100);
        let path = e.write(&dir).unwrap();
        assert_eq!(Endpoint::read(&dir), Some(e.clone()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // Written again over the old one.
        let again = Endpoint::fresh(4101);
        again.write(&dir).unwrap();
        assert_eq!(Endpoint::read(&dir), Some(again));
        let _ = path;
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn tokens_are_fresh_long_and_compare_whole() {
        let (a, b) = (new_token(), new_token());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(same_token(&a, &a.clone()));
        assert!(!same_token(&a, &b));
        assert!(!same_token(&a, &a[..63]));
        assert!(!same_token("", "x"));
    }
}
