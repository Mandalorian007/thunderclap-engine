//! Which names a game allows: [`NameRules`]. A name is an account's key in
//! the store and the `name` field of its tokens, so it never contains `.`
//! (the tokens' separator), whatever the rules say.

use std::fmt;

/// What makes a name valid: a length in characters and the characters
/// allowed. [`NameRules::default`] is `1 to 32 of [a-z0-9_]`.
#[derive(Clone, Copy)]
pub struct NameRules {
    /// The fewest characters (at least 1).
    pub min: usize,
    /// The most characters.
    pub max: usize,
    /// Whether a character may appear. `.` is refused regardless.
    pub allowed: fn(char) -> bool,
    /// The rule in words, for refusals: `1 to 32 of [a-z0-9_]`.
    pub describe: &'static str,
}

impl NameRules {
    /// Lowercase ASCII letters, digits and `_`, `min` to `max` of them.
    /// `describe` should say so.
    pub const fn lower_snake(min: usize, max: usize, describe: &'static str) -> NameRules {
        NameRules {
            min,
            max,
            allowed: lower_snake,
            describe,
        }
    }

    /// True if `name` follows the rules.
    pub fn valid(&self, name: &str) -> bool {
        let n = name.chars().count();
        n >= self.min.max(1) && n <= self.max && name.chars().all(|c| c != '.' && (self.allowed)(c))
    }
}

impl Default for NameRules {
    fn default() -> NameRules {
        NameRules::lower_snake(1, 32, "1 to 32 of [a-z0-9_]")
    }
}

impl fmt::Debug for NameRules {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NameRules")
            .field("min", &self.min)
            .field("max", &self.max)
            .field("describe", &self.describe)
            .finish()
    }
}

fn lower_snake(c: char) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'
}

/// The longest piece of client-supplied text echoed in a reason or log.
const CLIP_CHARS: usize = 40;

/// Quotes client-supplied `text` for a reason or log line, cut to 40
/// characters so a client can't make the server repeat (or log) an
/// arbitrarily long string.
pub fn quote(text: &str) -> String {
    match text.char_indices().nth(CLIP_CHARS) {
        None => format!("{text:?}"),
        Some((end, _)) => format!("{:?}... ({} bytes)", &text[..end], text.len()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_rules() {
        let rules = NameRules::default();
        for good in ["a", "alice_2", &"a".repeat(32)] {
            assert!(rules.valid(good), "{good}");
        }
        for bad in ["", "Alice", "a.b", "a b", "é", &"a".repeat(33)] {
            assert!(!rules.valid(bad), "{bad}");
        }
    }

    #[test]
    fn a_game_names_its_own_rules() {
        let rules = NameRules {
            min: 3,
            max: 12,
            allowed: |c| c.is_alphanumeric() || c == '-',
            describe: "3 to 12 letters, digits or -",
        };
        assert!(rules.valid("Zoë-9"));
        assert!(!rules.valid("ab"));
        assert!(!rules.valid("abc.def"), "never a dot");
        let any = NameRules {
            min: 0,
            allowed: |_| true,
            ..rules
        };
        assert!(!any.valid(""), "never empty");
        assert!(!any.valid("a.b"));
    }

    #[test]
    fn quotes_are_clipped() {
        assert_eq!(quote("Bot"), "\"Bot\"");
        assert_eq!(
            quote(&"é".repeat(41)),
            format!("{:?}... (82 bytes)", "é".repeat(40))
        );
    }
}
