//! The varint and zigzag codec every byte format here writes and reads
//! its integers with.
//!
//! - **Varint:** unsigned LEB128, 7 bits a byte, least significant first,
//!   the top bit set on every byte but the last. A `u64` takes 1 to 10
//!   bytes ([`varint_len`]).
//! - **Zigzag:** a signed integer folded into an unsigned one so small
//!   magnitudes stay short: 0, -1, 1, -2, 2 are 0, 1, 2, 3, 4.
//!
//! The writers are one encoding. The readers differ, because stored bytes
//! are forever: each format keeps the edge cases it shipped with, named by
//! a [`Varint`] rule. A reader consumes every byte it looks at, the failing
//! one included, so a caller's offset after an error is where reading
//! stopped; [`WireError::Truncated`] leaves it at the end of the bytes.
//! Each format maps a [`WireError`] to its own error and message.

use std::fmt;

/// Why a varint didn't read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WireError {
    /// The bytes end inside the varint.
    Truncated,
    /// The varint took more bytes than its value needs (a last byte of 0
    /// after the first), under a [`Varint::CANONICAL`] rule.
    Overlong,
    /// The varint carries more than 64 bits, or runs past its rule's bytes.
    Overflow,
    /// The value is over the bound a bounded read ([`read_varint_max`]) set.
    OverBound {
        /// The value read.
        value: u64,
        /// The largest value allowed.
        max: u64,
    },
}

impl fmt::Display for WireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WireError::Truncated => write!(f, "the bytes end inside a varint"),
            WireError::Overlong => write!(f, "overlong varint"),
            WireError::Overflow => write!(f, "varint too long"),
            WireError::OverBound { value, max } => write!(f, "{value} is over {max}"),
        }
    }
}

impl std::error::Error for WireError {}

/// How strictly a reader takes a varint: the edge cases a format shipped
/// with. Every rule reads every canonical encoding the same.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Varint {
    canonical: bool,
    max_bytes: u32,
    wrap: bool,
}

impl Varint {
    /// The wire's: an overlong encoding and more than 64 bits are
    /// refused.
    pub const CANONICAL: Varint = Varint {
        canonical: true,
        max_bytes: 10,
        wrap: false,
    };

    /// For stored formats that shipped lenient: an overlong encoding is
    /// read, more than 64 bits is refused.
    pub const LENIENT: Varint = Varint {
        canonical: false,
        max_bytes: 10,
        wrap: false,
    };

    /// For stored formats that shipped wrapping: an overlong encoding is
    /// read, a tenth byte's bits past 64 are dropped, and a tenth byte that
    /// continues is refused.
    pub const WRAPPING: Varint = Varint {
        canonical: false,
        max_bytes: 10,
        wrap: true,
    };

    /// This rule, refusing a varint that continues past `bytes` bytes
    /// (1 to 10).
    pub const fn at_most(self, bytes: u32) -> Varint {
        assert!(bytes >= 1 && bytes <= 10, "a varint takes 1 to 10 bytes");
        Varint {
            max_bytes: bytes,
            ..self
        }
    }
}

/// Appends `v` as a varint.
#[inline]
pub fn write_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

/// The bytes [`write_varint`] takes for `v`.
#[inline]
pub const fn varint_len(v: u64) -> usize {
    let bits = 64 - v.leading_zeros();
    if bits == 0 {
        1
    } else {
        bits.div_ceil(7) as usize
    }
}

/// `v` zigzagged: its sign in the low bit.
#[inline]
pub const fn zigzag(v: i64) -> u64 {
    ((v << 1) ^ (v >> 63)) as u64
}

/// The signed integer [`zigzag`] made `v` from.
#[inline]
pub const fn unzigzag(v: u64) -> i64 {
    ((v >> 1) as i64) ^ -((v & 1) as i64)
}

/// Reads the varint at `bytes[*at..]` under `rule`, moving `*at` past
/// every byte it looked at (see the module docs).
#[inline]
pub fn read_varint(bytes: &[u8], at: &mut usize, rule: Varint) -> Result<u64, WireError> {
    let last = 7 * (rule.max_bytes - 1);
    let mut v = 0u64;
    let mut shift = 0u32;
    loop {
        let Some(&b) = bytes.get(*at) else {
            return Err(WireError::Truncated);
        };
        *at += 1;
        if shift == 63 && b > 1 && !rule.wrap {
            return Err(WireError::Overflow);
        }
        v |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            if rule.canonical && b == 0 && shift > 0 {
                return Err(WireError::Overlong);
            }
            return Ok(v);
        }
        if shift == last {
            return Err(WireError::Overflow);
        }
        shift += 7;
    }
}

/// [`read_varint`], refusing a value over `max` with
/// [`WireError::OverBound`].
#[inline]
pub fn read_varint_max(
    bytes: &[u8],
    at: &mut usize,
    rule: Varint,
    max: u64,
) -> Result<u64, WireError> {
    let value = read_varint(bytes, at, rule)?;
    if value > max {
        return Err(WireError::OverBound { value, max });
    }
    Ok(value)
}

#[cfg(test)]
#[path = "varint_tests.rs"]
mod tests;
