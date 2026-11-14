//! The caller's side of the control channel: one blocking exchange with
//! the server that holds a directory (a CLI's `status`, `stop`, ...).

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::Path;
use std::time::Duration;

use crate::endpoint::{ENDPOINT_FILE, Endpoint};
use crate::proto::{MAX_LINE, Reply, Request};

/// How long connecting to the channel may take (it is on this machine).
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

/// How long the server may take to answer: a backup or a reload takes a
/// while.
pub const REPLY_TIMEOUT: Duration = Duration::from_secs(70);

/// Why [`ask`] has no reply.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AdminError {
    /// Nothing answers: no server holds the directory, or its endpoint
    /// file is missing or another process's, or it can't be reached.
    /// Nothing was sent.
    NoChannel(String),
    /// The request was sent and no reply read.
    Failed(String),
}

impl std::fmt::Display for AdminError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AdminError::NoChannel(why) | AdminError::Failed(why) => f.write_str(why),
        }
    }
}

impl std::error::Error for AdminError {}

/// Asks the server holding `dir` (its [`tc_store::StoreLock`]) `request`,
/// through the endpoint its [`ENDPOINT_FILE`] names, and returns its
/// reply. Only a server holding the lock is asked, and only if the file
/// names its pid, so a file left by a server that crashed is never used.
pub fn ask(dir: &Path, request: &Request) -> Result<Reply, AdminError> {
    let no = |why: String| AdminError::NoChannel(why);
    let Some(holder) = tc_store::holder(dir) else {
        return Err(no(format!("no server runs {}", dir.display())));
    };
    let Some(endpoint) = Endpoint::read(dir) else {
        return Err(no(format!(
            "no {ENDPOINT_FILE} in {}: the server ({holder}) has no admin channel",
            dir.display()
        )));
    };
    if holder.pid.is_some_and(|pid| pid != endpoint.pid) {
        return Err(no(format!(
            "{ENDPOINT_FILE} names pid {}, not the server's ({holder})",
            endpoint.pid
        )));
    }
    ask_endpoint(&endpoint, request)
}

/// Asks the channel `endpoint` names, without checking who holds what.
pub fn ask_endpoint(endpoint: &Endpoint, request: &Request) -> Result<Reply, AdminError> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, endpoint.port));
    let stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|e| {
        AdminError::NoChannel(format!("connecting to the admin channel at {addr}: {e}"))
    })?;
    let failed = |e: std::io::Error| AdminError::Failed(format!("the admin channel: {e}"));
    stream
        .set_read_timeout(Some(REPLY_TIMEOUT))
        .map_err(failed)?;
    stream
        .set_write_timeout(Some(REPLY_TIMEOUT))
        .map_err(failed)?;
    let mut line = request.encode(&endpoint.token);
    line.push('\n');
    (&stream).write_all(line.as_bytes()).map_err(failed)?;
    let mut reply = String::new();
    BufReader::new(std::io::Read::take(&stream, MAX_LINE as u64 + 1))
        .read_line(&mut reply)
        .map_err(failed)?;
    if reply.is_empty() {
        return Err(AdminError::Failed(
            "the admin channel closed without a reply".into(),
        ));
    }
    Reply::decode(reply.trim_end())
        .map_err(|e| AdminError::Failed(format!("the admin channel's reply: {e}")))
}
