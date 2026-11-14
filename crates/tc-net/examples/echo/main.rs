//! The echo game on tc-net, for trying a client against by hand:
//! `cargo run -p tc-net --example echo -- [port]` (default: a free port).
//! It prints the address and the schema hash a client must send.

#[path = "../../tests/echo/mod.rs"]
mod echo;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let port = std::env::args()
        .nth(1)
        .map_or(0, |p| p.parse().expect("a port number"));
    let (requests, game) = std::sync::mpsc::channel();
    std::thread::spawn(move || echo::run(game));
    let mut config = tc_net::ServerConfig::new(echo::schema().hash());
    config.port = port;
    let server = tc_net::Server::<echo::Echo>::start(config, requests).await?;
    println!(
        "ws://{}  schema {}",
        server.local_addr(),
        echo::schema().hash()
    );
    // Runs until killed.
    std::future::pending::<()>().await;
    drop(server);
    Ok(())
}
