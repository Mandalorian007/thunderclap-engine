//! Which web pages may open a connection: the browser `Origin` check on
//! the WebSocket handshake.
//!
//! A browser sends the page's origin with every WebSocket handshake, and
//! any page the browser has open can try to connect, so without a check a
//! web page on another site could connect to a server the browser can
//! reach and act with whatever token it can make. The server allows:
//!
//! - handshakes with no `Origin` (bots, the CLI, anything not a browser);
//! - pages served from loopback (`localhost`, `127.0.0.1`, `[::1]`, any
//!   port, http or https), such as the Vite dev server;
//! - origins named with `--allow-origin` (exactly; default ports may be
//!   written or left out).
//!
//! Everything else is refused with HTTP 403 and a log line naming the flag.

use std::collections::BTreeSet;
use std::sync::Mutex;

use tracing::{debug, warn};

/// Distinct refused origins logged as warnings; later ones log at debug,
/// so a flood of handshakes can't flood the log.
const MAX_WARNED: usize = 64;

/// The allowed browser origins.
#[derive(Debug, Default)]
pub struct Origins {
    /// Normalized (`scheme://host[:port]`, lowercase, no default port).
    allowed: BTreeSet<String>,
    /// Refused origins already warned about.
    warned: Mutex<BTreeSet<String>>,
}

impl Origins {
    /// Loopback pages plus each of `extra` (normalized with [`parse`]).
    pub fn new(extra: &[String]) -> Result<Origins, String> {
        let allowed = extra.iter().map(|o| parse(o)).collect::<Result<_, _>>()?;
        Ok(Origins {
            allowed,
            warned: Mutex::default(),
        })
    }

    /// True if a handshake with this `Origin` header (None: no header) is
    /// allowed.
    pub fn allows(&self, origin: Option<&str>) -> bool {
        let Some(origin) = origin else {
            return true;
        };
        match parse(origin) {
            Ok(o) => is_loopback(&o) || self.allowed.contains(&o),
            Err(_) => false,
        }
    }

    /// Logs a refused origin: a warning naming the flag the first time.
    pub fn log_refused(&self, origin: &str) {
        let shown: String = origin.chars().take(200).collect();
        let first = {
            let mut warned = self.warned.lock().unwrap_or_else(|e| e.into_inner());
            warned.len() < MAX_WARNED && warned.insert(shown.clone())
        };
        if first {
            warn!(
                "refused a connection from a web page at {shown:?}: that origin is not allowed. \
                 To let pages from it connect, add {shown} to the server's allowed origins \
                 (`ServerConfig::allow_origins`; a game's server usually takes \
                 --allow-origin)"
            );
        } else {
            debug!(origin = %shown, "refused a connection: origin not allowed");
        }
    }
}

/// Normalizes an origin, `scheme://host[:port]` with an http or https
/// scheme: lowercase, the default port (80, 443) dropped, a trailing `/`
/// allowed. The error explains what's wrong.
pub fn parse(origin: &str) -> Result<String, String> {
    let bad = |why: &str| {
        Err(format!(
            "invalid origin {origin:?}: {why} (expected scheme://host[:port], \
             e.g. https://example.ts.net:5173)"
        ))
    };
    let lower = origin.trim().to_ascii_lowercase();
    let lower = lower.strip_suffix('/').unwrap_or(&lower);
    let (scheme, rest) = match lower.split_once("://") {
        Some((s @ ("http" | "https"), rest)) => (s, rest),
        Some(_) => return bad("the scheme must be http or https"),
        None => return bad("no scheme"),
    };
    if rest.is_empty() {
        return bad("no host");
    }
    if rest.contains(['/', '?', '#', '@']) || rest.chars().any(char::is_whitespace) {
        return bad("only the scheme, host and port belong in an origin");
    }
    // The port follows the last `:` outside an IPv6 `[...]`.
    let (host, port) = match rest.rfind(':') {
        Some(i) if !rest[i..].contains(']') => (&rest[..i], Some(&rest[i + 1..])),
        _ => (rest, None),
    };
    if host.is_empty() {
        return bad("no host");
    }
    let port = match port {
        Some(p) => match p.parse::<u16>() {
            Ok(p) => Some(p),
            Err(_) => return bad("the port must be a number up to 65535"),
        },
        None => None,
    };
    let default = if scheme == "https" { 443 } else { 80 };
    Ok(match port {
        Some(p) if p != default => format!("{scheme}://{host}:{p}"),
        _ => format!("{scheme}://{host}"),
    })
}

/// A normalized origin served from this machine's loopback address.
fn is_loopback(origin: &str) -> bool {
    let rest = origin.split_once("://").map_or(origin, |(_, r)| r);
    let host = match rest.rfind(':') {
        Some(i) if !rest[i..].contains(']') => &rest[..i],
        _ => rest,
    };
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_normalize() {
        let ok = |o: &str| parse(o).unwrap();
        assert_eq!(ok("https://Host.ts.net:5173/"), "https://host.ts.net:5173");
        assert_eq!(ok("https://host.ts.net:443"), "https://host.ts.net");
        assert_eq!(ok("http://host:80"), "http://host");
        assert_eq!(ok("http://host:443"), "http://host:443");
        assert_eq!(ok("http://[::1]:8080"), "http://[::1]:8080");
        assert_eq!(ok("http://[::1]"), "http://[::1]");
        for bad in [
            "host.ts.net:5173",
            "ftp://host",
            "https://",
            "https://host/path",
            "https://host:port",
            "https://host:70000",
            "https://user@host",
            "null",
        ] {
            assert!(parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn loopback_and_no_origin_are_allowed_by_default() {
        let o = Origins::new(&[]).unwrap();
        for allowed in [
            None,
            Some("http://localhost:5173"),
            Some("https://localhost"),
            Some("http://127.0.0.1:4173"),
            Some("http://[::1]:5173"),
        ] {
            assert!(o.allows(allowed), "{allowed:?}");
        }
        for refused in [
            "https://mcf-home-server.tailfb7fd4.ts.net:5173",
            "http://localhost.evil.com",
            "http://127.0.0.1.evil.com",
            "https://evil.com",
            "null",
            "",
        ] {
            assert!(!o.allows(Some(refused)), "{refused}");
        }
    }

    #[test]
    fn allowed_origins_match_exactly() {
        let o = Origins::new(&["https://mcf-home-server.tailfb7fd4.ts.net:5173".into()]).unwrap();
        assert!(o.allows(Some("https://mcf-home-server.tailfb7fd4.ts.net:5173")));
        assert!(o.allows(Some("https://MCF-home-server.tailfb7fd4.ts.net:5173")));
        assert!(!o.allows(Some("https://mcf-home-server.tailfb7fd4.ts.net")));
        assert!(!o.allows(Some("http://mcf-home-server.tailfb7fd4.ts.net:5173")));
        assert!(!o.allows(Some("https://other.tailfb7fd4.ts.net:5173")));
        assert!(Origins::new(&["example.com".into()]).is_err());
    }
}
