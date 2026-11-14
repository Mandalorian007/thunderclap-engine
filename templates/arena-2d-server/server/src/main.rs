//! `arena-server [--host 127.0.0.1] [--port 4711]`: serves the arena
//! until Ctrl-C. Prints `listening on ws://HOST:PORT` once it is (with
//! `--port 0`, the port it picked).

fn main() {
    let mut host = "127.0.0.1".to_string();
    let mut port: u16 = 4711;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let value = args.next();
        match (arg.as_str(), value) {
            ("--host", Some(v)) => host = v,
            ("--port", Some(v)) => port = v.parse().expect("--port takes a number"),
            _ => {
                eprintln!("usage: arena-server [--host HOST] [--port PORT]");
                std::process::exit(2);
            }
        }
    }
    let runtime = tokio::runtime::Runtime::new().expect("a tokio runtime");
    runtime.block_on(async {
        let served = arena_server::serve(&host, port).await.unwrap_or_else(|e| {
            eprintln!("arena-server: {e}");
            std::process::exit(1);
        });
        println!("listening on ws://{}", served.server.local_addr());
        let _ = tokio::signal::ctrl_c().await;
        served.server.stop().await;
        served.running.stop();
    });
}
