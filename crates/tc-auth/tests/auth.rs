//! The auths, against Forge Wilds' token tests and vectors: Forge's scheme
//! is `TokenFormat` with its prefixes (`fw1`, `fw2`) and permissions
//! (`dev`, `observer` alone), so its signatures must come out the same.

use std::sync::Arc;

use tc_auth::{
    Accounts, Claim, DevTokens, GUEST_PERMISSION, MemoryAccounts, SessionAuth, TokenError,
    TokenFormat, quote,
};
use tc_net::{Auth, Identity};

/// Forge Wilds' tokens, as a game configures them.
fn forge() -> TokenFormat {
    TokenFormat {
        dev_prefix: "fw1".into(),
        session_prefix: "fw2".into(),
        permissions: vec!["dev".into(), "observer".into()],
        exclusive: vec!["observer".into()],
        expired: "this link has expired: ask for a new one".into(),
        needs_session: "this server takes sign-in links only".into(),
        ..TokenFormat::default()
    }
}

fn who(name: &str, perms: &[&str]) -> Identity {
    Identity {
        name: name.into(),
        permissions: perms.iter().map(|p| p.to_string()).collect(),
    }
}

fn dev(secret: &str) -> DevTokens {
    DevTokens::new(secret, forge())
}

fn session(accounts: &Arc<MemoryAccounts>) -> SessionAuth {
    SessionAuth::new("s3cret", forge(), accounts.clone())
}

#[test]
fn known_vector() {
    // HMAC-SHA256(key "forge-dev", "fw1.bot.dev"), computed independently
    // with openssl and with node:crypto (Forge Wilds' vector).
    assert_eq!(
        dev("forge-dev").sign("bot", &["dev"]).unwrap(),
        "fw1.bot.dev.34ed7632a65776bacb152be9ef62185c10a443ff8958f67b14cb76d43e9aceaf"
    );
}

#[test]
fn known_session_vector() {
    // HMAC-SHA256(key "s3cret", "fw2.alice.-.3"), computed independently
    // with `openssl dgst -sha256 -hmac s3cret` (Forge Wilds' link vector).
    let auth = session(&Arc::new(MemoryAccounts::default()));
    assert_eq!(
        auth.sign("alice", &[], 3).unwrap(),
        "fw2.alice.-.3.8ff28d64f1c942db1a83f5669827b8442ffff4ff0c49b457d5b137cb84906a65"
    );
}

#[test]
fn round_trips() {
    let auth = dev("s3cret");
    let long = "a".repeat(32);
    for (name, perms) in [
        ("bot", &["dev"][..]),
        ("alice_2", &[][..]),
        (&*long, &["dev"][..]),
    ] {
        let token = auth.sign(name, perms).unwrap();
        assert_eq!(auth.check(&token).unwrap(), who(name, perms));
        assert_eq!(auth.verify(&token).unwrap(), who(name, perms));
    }
    assert!(auth.sign("bot", &[]).unwrap().starts_with("fw1.bot.-."));
    let observer = auth.sign("watcher", &["observer"]).unwrap();
    assert!(observer.starts_with("fw1.watcher.observer."));
    assert_eq!(
        auth.check(&observer).unwrap(),
        who("watcher", &["observer"])
    );
    assert!(auth.revisions().is_none(), "dev tokens are never revoked");
}

#[test]
fn refuses_bad_tokens() {
    let auth = dev("s3cret");
    let good = auth.sign("bot", &["dev"]).unwrap();
    let other = dev("other").sign("bot", &["dev"]).unwrap();
    assert_eq!(auth.check(&other), Err(TokenError::BadSignature));

    let forged = good.replace(".dev.", ".-.");
    assert_eq!(auth.check(&forged), Err(TokenError::BadSignature));
    let renamed = good.replace("fw1.bot.", "fw1.bob.");
    assert_eq!(auth.check(&renamed), Err(TokenError::BadSignature));
    let watching = good.replace(".dev.", ".observer.");
    assert_eq!(auth.check(&watching), Err(TokenError::BadSignature));

    let sig = good.rsplit('.').next().unwrap();
    for bad in [
        String::new(),
        "fw1.bot.dev".to_string(),
        format!("fw2.bot.dev.{sig}"),
        format!("fw1.bot.dev.{}", sig.to_uppercase()),
        format!("fw1.bot.dev.{}", &sig[..62]),
        format!("fw1.bot.dev.{sig}.x"),
        format!("fw1.bot.dev,.{sig}"),
        format!("fw1.bot.dev,observer.{sig}"),
        format!("fw1.bot.observer,dev.{sig}"),
    ] {
        assert!(
            matches!(auth.check(&bad), Err(TokenError::Malformed(_))),
            "{bad:?}"
        );
    }
    assert_eq!(
        auth.check(&format!("fw1.Bot.dev.{sig}")),
        Err(TokenError::InvalidName("Bot".into()))
    );
    let reason = auth.verify(&format!("fw1.Bot.dev.{sig}")).unwrap_err().0;
    assert!(reason.contains("1 to 32 of [a-z0-9_]"), "{reason}");
    assert_eq!(
        auth.check(&format!("fw1.bot.admin.{sig}")),
        Err(TokenError::UnknownPermission("admin".into()))
    );
    assert!(auth.sign("", &[]).is_err());
    assert!(auth.sign("a.b", &[]).is_err());
    assert!(auth.sign("bot", &["admin"]).is_err());
}

#[test]
fn long_client_text_is_clipped_in_reasons() {
    let auth = dev("s");
    let long = "X".repeat(60_000);
    let sig = "0".repeat(64);
    for token in [
        format!("fw1.{long}.dev.{sig}"),
        format!("{long}.bot.dev.{sig}"),
        format!("fw1.bot.{long}.{sig}"),
    ] {
        let reason = auth.verify(&token).unwrap_err().0;
        assert!(reason.len() < 200, "{reason}");
        assert!(reason.contains("(60000 bytes)"), "{reason}");
    }
    assert_eq!(quote("Bot"), "\"Bot\"");
}

#[test]
fn tokens_join_until_a_revoke_replaces_them() {
    let accounts = Arc::new(MemoryAccounts::default());
    let auth = session(&accounts);
    let first = auth.issue(&Claim::name("alice"), &[]).unwrap();
    assert_eq!(first.claimed.generation, 1);
    let old = first.token;
    assert_eq!(auth.verify(&old).unwrap(), who("alice", &[]));

    let mut revisions = auth.revisions().unwrap();
    assert_eq!(auth.revoke("alice").unwrap(), 2);
    let new = auth.issue(&Claim::name("alice"), &["dev"]).unwrap();
    assert_eq!(new.claimed.generation, 2);
    // The next Hello reads the store again: the old token is refused with
    // the game's reason, and live sessions are told.
    assert_eq!(auth.verify(&new.token).unwrap(), who("alice", &["dev"]));
    assert!(revisions.has_changed().unwrap());
    revisions.mark_unchanged();
    assert_eq!(auth.check(&old), Err(TokenError::Expired));
    assert!(
        auth.verify(&old)
            .unwrap_err()
            .0
            .contains("link has expired")
    );
    assert!(!revisions.has_changed().unwrap(), "nothing changed since");
    assert_eq!(auth.generation("alice"), 2);
    assert_eq!(auth.generation("nobody"), 0);

    // A name the store doesn't know (it was lost) joins: generation 0.
    let stranger = auth.sign("bob", &["observer"], 0).unwrap();
    assert_eq!(auth.verify(&stranger).unwrap(), who("bob", &["observer"]));
    // A revoke of a name never claimed refuses its generation-0 tokens.
    assert_eq!(auth.revoke("bob").unwrap(), 1);
    assert_eq!(auth.check(&stranger), Err(TokenError::Expired));
}

#[test]
fn a_verified_token_marks_its_account_seen() {
    let accounts = Arc::new(MemoryAccounts::default().with_clock(Arc::new(|| 10)));
    let auth = session(&accounts).with_clock(Arc::new(|| 25));
    let issued = auth
        .issue(
            &Claim {
                name: Some("ada".into()),
                account: Some("chat:1".into()),
                reset: false,
            },
            &[],
        )
        .unwrap();
    assert_eq!(accounts.get("ada").unwrap().last_seen, 10);
    auth.verify(&issued.token).unwrap();
    let rec = accounts.get("ada").unwrap();
    assert_eq!(
        (rec.created, rec.last_seen, rec.account.as_deref()),
        (10, 25, Some("chat:1"))
    );
    // Issuing by account finds the same name.
    let again = auth
        .issue(
            &Claim {
                account: Some("chat:1".into()),
                ..Claim::default()
            },
            &[],
        )
        .unwrap();
    assert_eq!(again.claimed.name, "ada");
    assert!(matches!(
        auth.issue(&Claim::name("ada"), &["admin"]),
        Err(TokenError::UnknownPermission(_))
    ));
    assert!(matches!(
        auth.issue(&Claim::default(), &[]),
        Err(TokenError::Account(_))
    ));
}

#[test]
fn session_auth_refuses_forgeries_and_dev_tokens() {
    let auth = session(&Arc::new(MemoryAccounts::default()));
    let good = auth.sign("alice", &[], 4).unwrap();
    assert!(auth.check(&good).is_ok());
    let other = SessionAuth::new("other", forge(), Arc::new(MemoryAccounts::default()))
        .sign("alice", &[], 4)
        .unwrap();
    assert_eq!(auth.check(&other), Err(TokenError::BadSignature));
    for altered in [
        good.replace(".-.", ".dev."),
        good.replace(".-.", ".observer."),
        good.replace("fw2.alice.", "fw2.alicf."),
        good.replace(".4.", ".5."),
    ] {
        assert_eq!(
            auth.check(&altered),
            Err(TokenError::BadSignature),
            "{altered}"
        );
    }
    let sig = good.rsplit('.').next().unwrap();
    for bad in [
        format!("fw2.alice.-.{sig}"),
        format!("fw2.alice.-.04.{sig}"),
        format!("fw2.alice.-.-1.{sig}"),
        format!("fw2.alice.-.4294967296.{sig}"),
        format!("fw2.alice.-..{sig}"),
        format!("fw3.alice.-.4.{sig}"),
        format!("fw2.alice.-.4.{}", sig.to_uppercase()),
        String::new(),
    ] {
        assert!(
            matches!(auth.check(&bad), Err(TokenError::Malformed(_))),
            "{bad:?}"
        );
    }
    let dev_token = dev("s3cret").sign("alice", &["dev"]).unwrap();
    assert_eq!(auth.check(&dev_token), Err(TokenError::NeedsSession));
    assert!(
        auth.verify(&dev_token)
            .unwrap_err()
            .0
            .contains("sign-in links only")
    );
    // And a dev server takes no session token.
    assert!(matches!(
        dev("s3cret").check(&good),
        Err(TokenError::Malformed(_))
    ));
}

#[test]
fn guest_mode_lets_an_empty_token_in() {
    let accounts = Arc::new(MemoryAccounts::default());
    let strict = session(&accounts);
    assert!(strict.verify("").is_err(), "off by default");
    let auth = session(&accounts).with_guests();
    let a = auth.verify("").unwrap();
    let b = auth.verify("").unwrap();
    assert_eq!(a, who("guest_1", &[GUEST_PERMISSION]));
    assert_eq!(b.name, "guest_2");
    assert!(accounts.get("guest_1").is_none(), "guests are not stored");
    // Real tokens still go through the full check.
    let good = auth.issue(&Claim::name("ada"), &[]).unwrap();
    assert_eq!(auth.verify(&good.token).unwrap().name, "ada");
    assert!(auth.verify("guest").is_err());
}

#[test]
fn guest_mode_lets_a_page_pick_its_name() {
    let accounts = Arc::new(MemoryAccounts::default());
    let strict = session(&accounts);
    assert!(strict.verify("guest:bo").is_err(), "off by default");
    let auth = session(&accounts).with_guests();
    assert_eq!(
        auth.verify("guest:bo").unwrap(),
        who("bo", &[GUEST_PERMISSION])
    );
    assert!(accounts.get("bo").is_none(), "guests are not stored");
    // A bad name, or one an account holds, is refused.
    assert!(auth.verify("guest:Bo!").is_err());
    assert!(auth.verify("guest:").is_err());
    auth.issue(&Claim::name("ada"), &[]).unwrap();
    let held = auth.verify("guest:ada").unwrap_err();
    assert!(held.0.contains("has an account"), "{held:?}");
}

#[test]
fn the_default_format_names_no_game() {
    let auth = SessionAuth::new(
        "k",
        TokenFormat::default(),
        Arc::new(MemoryAccounts::default()),
    );
    let issued = auth.issue(&Claim::name("ada"), &[]).unwrap();
    assert!(issued.token.starts_with("tc2.ada.-.1."));
    auth.revoke("ada").unwrap();
    assert!(
        auth.verify(&issued.token)
            .unwrap_err()
            .0
            .contains("revoked")
    );
    assert!(
        DevTokens::new("k", TokenFormat::default())
            .sign("ada", &["dev"])
            .is_err(),
        "no permissions unless the game declares them"
    );
}
