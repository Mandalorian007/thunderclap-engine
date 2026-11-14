//! The records as every backend keeps them, the store's JSON, and the
//! rules of a claim.

use std::collections::BTreeMap;

use serde_json::Value;

use super::{AccountError, Claim, Claimed, Record};
use crate::names::NameRules;

const FORMAT: u64 = 1;

/// The longest account id.
pub(crate) const MAX_ACCOUNT: usize = 64;

/// The records, by name.
#[derive(Clone, Debug, Default)]
pub(crate) struct Records {
    entries: BTreeMap<String, Entry>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Entry {
    generation: u32,
    account: Option<String>,
    created: u64,
    last_seen: u64,
}

impl Records {
    /// The store's JSON:
    /// `{"format":1,"names":{"<name>":{"generation":1,...}}}`. `account`,
    /// `created` and `last_seen` may be missing; unknown fields are
    /// ignored.
    pub(crate) fn parse(text: &str, rules: &NameRules) -> Result<Records, String> {
        let value: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
        let format = value.get("format").and_then(Value::as_u64);
        if format != Some(FORMAT) {
            return Err(format!("unknown format {format:?}"));
        }
        let names = value
            .get("names")
            .and_then(Value::as_object)
            .ok_or("no \"names\" object")?;
        let mut entries = BTreeMap::new();
        for (name, entry) in names {
            if !rules.valid(name) {
                return Err(format!("bad name {name:?}"));
            }
            let generation = entry
                .get("generation")
                .and_then(Value::as_u64)
                .and_then(|g| u32::try_from(g).ok())
                .ok_or_else(|| format!("{name}: bad generation"))?;
            let account = match entry.get("account") {
                None | Some(Value::Null) => None,
                Some(Value::String(a)) if valid_account(a) => Some(a.clone()),
                Some(_) => return Err(format!("{name}: bad account")),
            };
            let time = |key: &str| match entry.get(key) {
                None | Some(Value::Null) => Ok(0),
                Some(v) => v.as_u64().ok_or_else(|| format!("{name}: bad {key}")),
            };
            entries.insert(
                name.clone(),
                Entry {
                    generation,
                    account,
                    created: time("created")?,
                    last_seen: time("last_seen")?,
                },
            );
        }
        Ok(Records { entries })
    }

    /// The store's JSON, one name a line, keys sorted.
    pub(crate) fn to_json(&self) -> String {
        let mut out = format!("{{\"format\":{FORMAT},\"names\":{{");
        for (i, (name, e)) in self.entries.iter().enumerate() {
            let sep = if i == 0 { "" } else { "," };
            out.push_str(&format!("{sep}\n  {}:{{", Value::from(name.as_str())));
            if let Some(account) = &e.account {
                out.push_str(&format!("\"account\":{},", Value::from(account.as_str())));
            }
            out.push_str(&format!(
                "\"created\":{},\"generation\":{},\"last_seen\":{}}}",
                e.created, e.generation, e.last_seen
            ));
        }
        out.push_str("\n}}\n");
        out
    }

    /// `name`'s generation: 0 for a name it doesn't know.
    pub(crate) fn generation(&self, name: &str) -> u32 {
        self.entries.get(name).map_or(0, |e| e.generation)
    }

    /// `name`'s record.
    pub(crate) fn get(&self, name: &str) -> Option<Record> {
        self.entries.get(name).map(|e| Record {
            name: name.to_string(),
            account: e.account.clone(),
            generation: e.generation,
            created: e.created,
            last_seen: e.last_seen,
        })
    }

    /// The name `account` took.
    fn name_of(&self, account: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(_, e)| e.account.as_deref() == Some(account))
            .map(|(name, _)| name.as_str())
    }

    /// How many names.
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    /// True if the two hold the same names, accounts and generations:
    /// what a token's validity depends on (times aside).
    pub(crate) fn same_keys(&self, other: &Records) -> bool {
        self.entries.len() == other.entries.len()
            && self
                .entries
                .iter()
                .zip(&other.entries)
                .all(|((a, x), (b, y))| {
                    a == b && x.generation == y.generation && x.account == y.account
                })
    }

    /// Notes `name` seen at `now`; false if there is no such name or it
    /// was already seen as late.
    pub(crate) fn seen(&mut self, name: &str, now: u64) -> bool {
        match self.entries.get_mut(name) {
            Some(e) if e.last_seen < now => {
                e.last_seen = now;
                true
            }
            _ => false,
        }
    }

    /// Carries the later `last_seen` of each name over from `older` (what
    /// one process saw but has not written yet).
    pub(crate) fn keep_seen(&mut self, older: &Records) {
        for (name, e) in &mut self.entries {
            if let Some(o) = older.entries.get(name) {
                e.last_seen = e.last_seen.max(o.last_seen);
            }
        }
    }

    /// Applies `claim` at `now`: takes a name, or finds an account's, and
    /// bumps its generation if `claim.reset`. These are the rules every
    /// backend shares; the backend stores the records if they changed and
    /// adds its own warnings.
    pub(crate) fn claim(
        &mut self,
        claim: &Claim,
        rules: &NameRules,
        now: u64,
    ) -> Result<Claimed, AccountError> {
        check(claim, rules)?;
        let owned = claim.account.as_deref().and_then(|a| self.name_of(a));
        let name = match (owned, &claim.name) {
            (Some(owned), Some(name)) if owned != name => {
                return Err(AccountError(format!(
                    "this account already has the name {owned}: a name is chosen once"
                )));
            }
            (Some(owned), _) => owned.to_string(),
            (None, Some(name)) => name.clone(),
            (None, None) => {
                return Err(AccountError(match &claim.account {
                    Some(_) => "this account has no name yet: give one".into(),
                    None => "missing name".into(),
                }));
            }
        };
        let owned = owned.is_some();
        let created = !self.entries.contains_key(&name);
        if claim.account.is_some() && !owned && !created {
            return Err(AccountError(format!("the name {name} is taken")));
        }
        let entry = self.entries.entry(name.clone()).or_insert(Entry {
            generation: 1,
            account: claim.account.clone(),
            created: now,
            last_seen: now,
        });
        if claim.reset && !created {
            entry.generation = entry
                .generation
                .checked_add(1)
                .ok_or_else(|| AccountError(format!("{name}: no generations left")))?;
        }
        Ok(Claimed {
            name,
            generation: entry.generation,
            created,
            warnings: Vec::new(),
        })
    }
}

/// A claim's own mistakes, found before any store is touched.
pub(crate) fn check(claim: &Claim, rules: &NameRules) -> Result<(), AccountError> {
    if let Some(account) = &claim.account
        && !valid_account(account)
    {
        return Err(AccountError(format!(
            "bad account {account:?}: use 1 to {MAX_ACCOUNT} printable characters, no spaces"
        )));
    }
    if let Some(name) = &claim.name
        && !rules.valid(name)
    {
        return Err(AccountError(format!(
            "bad name {name:?}: use {}",
            rules.describe
        )));
    }
    Ok(())
}

/// True if `account` is a valid account id: 1 to [`MAX_ACCOUNT`] printable
/// ASCII characters, no spaces.
pub(crate) fn valid_account(account: &str) -> bool {
    (1..=MAX_ACCOUNT).contains(&account.len()) && account.bytes().all(|b| b.is_ascii_graphic())
}
