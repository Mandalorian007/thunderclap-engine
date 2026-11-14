//! `Fixed`: the one fixed-point number type (signed 32.32 in an `i64`).
//!
//! Arithmetic operators saturate at [`Fixed::MIN`] / [`Fixed::MAX`]; the
//! `checked_*` methods return `None` on overflow instead. Multiplication
//! rounds toward negative infinity.

use std::fmt;
use std::ops::{Add, Mul, Sub};

/// Signed fixed-point number with 32 integer and 32 fractional bits.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Fixed(i64);

/// Number of fractional bits.
pub const FRAC_BITS: u32 = 32;

impl Fixed {
    /// 0.
    pub const ZERO: Fixed = Fixed(0);
    /// 1.
    pub const ONE: Fixed = Fixed(1 << FRAC_BITS);
    /// Smallest value, -2^31.
    pub const MIN: Fixed = Fixed(i64::MIN);
    /// Largest value, 2^31 - 2^-32.
    pub const MAX: Fixed = Fixed(i64::MAX);

    /// From the raw 32.32 bits.
    pub const fn from_bits(bits: i64) -> Fixed {
        Fixed(bits)
    }

    /// The raw 32.32 bits.
    pub const fn to_bits(self) -> i64 {
        self.0
    }

    /// An integer, exactly (every `i32` fits).
    pub const fn from_int(n: i32) -> Fixed {
        Fixed((n as i64) << FRAC_BITS)
    }

    /// Largest integer less than or equal to `self`.
    pub const fn floor_int(self) -> i64 {
        self.0 >> FRAC_BITS
    }

    /// `self + rhs`, or `None` on overflow.
    pub const fn checked_add(self, rhs: Fixed) -> Option<Fixed> {
        match self.0.checked_add(rhs.0) {
            Some(v) => Some(Fixed(v)),
            None => None,
        }
    }

    /// `self - rhs`, or `None` on overflow.
    pub const fn checked_sub(self, rhs: Fixed) -> Option<Fixed> {
        match self.0.checked_sub(rhs.0) {
            Some(v) => Some(Fixed(v)),
            None => None,
        }
    }

    /// `self * rhs` rounded toward negative infinity, saturating.
    pub const fn saturating_mul(self, rhs: Fixed) -> Fixed {
        let wide = ((self.0 as i128) * (rhs.0 as i128)) >> FRAC_BITS;
        if wide < i64::MIN as i128 {
            Fixed::MIN
        } else if wide > i64::MAX as i128 {
            Fixed::MAX
        } else {
            Fixed(wide as i64)
        }
    }

    /// `self / rhs` rounded toward negative infinity, saturating, or `None`
    /// if `rhs` is zero. Exactly `floor(self_bits × 2^32 / rhs_bits)`.
    pub const fn checked_div_floor(self, rhs: Fixed) -> Option<Fixed> {
        if rhs.0 == 0 {
            return None;
        }
        let wide = ((self.0 as i128) << FRAC_BITS).div_euclid(rhs.0 as i128);
        // div_euclid rounds toward negative infinity only for positive divisors.
        let wide = if rhs.0 < 0 && wide * (rhs.0 as i128) != ((self.0 as i128) << FRAC_BITS) {
            wide - 1
        } else {
            wide
        };
        Some(Fixed(saturate(wide)))
    }

    /// `self × rhs / den` with a single rounding toward negative infinity:
    /// exactly `floor(self_bits × rhs_bits / (den × 2^32))`, saturating.
    /// `den` must be positive (zero gives [`Fixed::ZERO`]).
    pub const fn mul_div_floor(self, rhs: Fixed, den: u64) -> Fixed {
        if den == 0 {
            return Fixed::ZERO;
        }
        let num = (self.0 as i128) * (rhs.0 as i128);
        let den = (den as i128) << FRAC_BITS;
        Fixed(saturate(num.div_euclid(den)))
    }

    /// `self × n` for a whole number `n`, exactly, saturating.
    pub const fn saturating_mul_int(self, n: u64) -> Fixed {
        Fixed(saturate((self.0 as i128) * (n as i128)))
    }

    /// The smallest whole `n ≥ 0` with `n × step ≥ self`, for a positive
    /// `step`: exactly `ceil(self_bits / step_bits)`, or 0 if `self ≤ 0`.
    /// `None` if `step` is not positive.
    pub const fn ceil_div_steps(self, step: Fixed) -> Option<u64> {
        if step.0 <= 0 {
            return None;
        }
        if self.0 <= 0 {
            return Some(0);
        }
        let n = self.0 as u64;
        let d = step.0 as u64;
        Some(n.div_ceil(d))
    }

    /// The smaller of two values.
    pub const fn min(self, rhs: Fixed) -> Fixed {
        if self.0 <= rhs.0 { self } else { rhs }
    }

    /// Parses a decimal exactly: optional sign, integer digits, optional `.`
    /// and fraction digits. Rounds to the nearest representable value, ties
    /// away from zero. Exponents and anything else are rejected.
    pub fn parse_decimal(text: &str) -> Result<Fixed, ParseFixedError> {
        parse_decimal(text)
    }
}

/// Clamps a wide value to the `i64` bit range.
const fn saturate(wide: i128) -> i64 {
    if wide < i64::MIN as i128 {
        i64::MIN
    } else if wide > i64::MAX as i128 {
        i64::MAX
    } else {
        wide as i64
    }
}

impl Add for Fixed {
    type Output = Fixed;
    /// Saturating addition.
    fn add(self, rhs: Fixed) -> Fixed {
        Fixed(self.0.saturating_add(rhs.0))
    }
}

impl Sub for Fixed {
    type Output = Fixed;
    /// Saturating subtraction.
    fn sub(self, rhs: Fixed) -> Fixed {
        Fixed(self.0.saturating_sub(rhs.0))
    }
}

impl Mul for Fixed {
    type Output = Fixed;
    /// Saturating multiplication, rounded toward negative infinity.
    fn mul(self, rhs: Fixed) -> Fixed {
        self.saturating_mul(rhs)
    }
}

/// Why a decimal string couldn't become a [`Fixed`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParseFixedError {
    text: String,
    reason: &'static str,
}

impl fmt::Display for ParseFixedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid decimal {:?}: {}", self.text, self.reason)
    }
}

impl std::error::Error for ParseFixedError {}

/// Parses a decimal exactly; see [`Fixed::parse_decimal`].
pub fn parse_decimal(text: &str) -> Result<Fixed, ParseFixedError> {
    let err = |reason| ParseFixedError {
        text: text.to_string(),
        reason,
    };
    let (negative, rest) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let (int_digits, frac_digits) = match rest.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (rest, None),
    };
    if int_digits.is_empty() {
        return Err(err("missing integer digits"));
    }
    if frac_digits.is_some_and(str::is_empty) {
        return Err(err("missing fraction digits"));
    }
    let all_digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if !all_digits(int_digits) || !frac_digits.is_none_or(all_digits) {
        return Err(err("only digits, one '.', and a leading sign are allowed"));
    }

    // Magnitude in 32.32, as u128 so the range check happens once at the end.
    let mut int_part: u128 = 0;
    for b in int_digits.bytes() {
        int_part = int_part
            .checked_mul(10)
            .and_then(|v| v.checked_add(u128::from(b - b'0')))
            .filter(|v| *v <= 1 << 63)
            .ok_or_else(|| err("out of range"))?;
    }
    let frac_part = match frac_digits {
        Some(digits) => fraction_bits_rounded(digits),
        None => 0,
    };
    let magnitude = (int_part << FRAC_BITS) + frac_part;
    let limit: u128 = if negative { 1 << 63 } else { (1 << 63) - 1 };
    if magnitude > limit {
        return Err(err("out of range"));
    }
    let bits = if negative {
        (magnitude as i128).wrapping_neg() as i64
    } else {
        magnitude as i64
    };
    Ok(Fixed(bits))
}

/// `round(0.<digits> × 2^32)`, ties away from zero, exactly for any length:
/// doubling the decimal fraction yields one binary digit per step.
fn fraction_bits_rounded(digits: &str) -> u128 {
    let mut decimal: Vec<u8> = digits.bytes().map(|b| b - b'0').collect();
    let mut next_bit = || {
        let mut carry = 0;
        for d in decimal.iter_mut().rev() {
            let v = *d * 2 + carry;
            *d = v % 10;
            carry = v / 10;
        }
        u128::from(carry)
    };
    let mut bits: u128 = 0;
    for _ in 0..FRAC_BITS {
        bits = (bits << 1) | next_bit();
    }
    // The next bit is the half: set means at least half an ulp remains.
    bits + next_bit()
}

impl fmt::Display for Fixed {
    /// Exact decimal, without trailing zeros (`1`, `-0.25`).
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let magnitude = self.0.unsigned_abs();
        let int_part = magnitude >> FRAC_BITS;
        let mut frac = magnitude & 0xFFFF_FFFF;
        if self.0 < 0 {
            f.write_str("-")?;
        }
        write!(f, "{int_part}")?;
        if frac != 0 {
            f.write_str(".")?;
            while frac != 0 {
                frac *= 10;
                write!(f, "{}", frac >> FRAC_BITS)?;
                frac &= 0xFFFF_FFFF;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> Fixed {
        parse_decimal(s).unwrap()
    }

    #[test]
    fn parses_integers_and_simple_fractions() {
        assert_eq!(p("0"), Fixed::ZERO);
        assert_eq!(p("1"), Fixed::ONE);
        assert_eq!(p("-3"), Fixed::from_int(-3));
        assert_eq!(p("+7"), Fixed::from_int(7));
        assert_eq!(p("0.5"), Fixed::from_bits(1 << 31));
        assert_eq!(p("0.25"), Fixed::from_bits(1 << 30));
        assert_eq!(p("-1.5"), Fixed::from_bits(-(3 << 31)));
        assert_eq!(p("30"), Fixed::from_int(30));
        assert_eq!(p("007.500"), Fixed::from_bits(15 << 31));
        assert_eq!(p("-0"), Fixed::ZERO);
    }

    #[test]
    fn rounds_to_nearest_ties_away_from_zero() {
        // 0.1 * 2^32 = 429496729.6 -> 429496730
        assert_eq!(p("0.1"), Fixed::from_bits(429_496_730));
        assert_eq!(p("-0.1"), Fixed::from_bits(-429_496_730));
        // 2^-33 is exactly half an ulp: ties go away from zero.
        let half_ulp = "0.000000000116415321826934814453125";
        assert_eq!(p(half_ulp), Fixed::from_bits(1));
        assert_eq!(p(&format!("-{half_ulp}")), Fixed::from_bits(-1));
        // Just below half an ulp rounds down.
        assert_eq!(p("0.000000000116415321826934814453124"), Fixed::ZERO);
        // 2^-32 * 1.5 = 1.5 ulp -> 2 ulp.
        assert_eq!(
            p("0.0000000003492459654808044433593750"),
            Fixed::from_bits(2)
        );
        // Fraction rounding can carry into the integer part.
        assert_eq!(p("0.99999999999999999999"), Fixed::ONE);
    }

    #[test]
    fn handles_long_fractions_exactly() {
        let long = format!("0.25{}", "0".repeat(200));
        assert_eq!(p(&long), Fixed::from_bits(1 << 30));
        let long_half = format!("0.000000000116415321826934814453125{}", "0".repeat(100));
        assert_eq!(p(&long_half), Fixed::from_bits(1));
        let just_under = format!("0.000000000116415321826934814453124{}", "9".repeat(80));
        assert_eq!(p(&just_under), Fixed::ZERO);
        let just_over = format!("0.000000000116415321826934814453125{}1", "0".repeat(80));
        assert_eq!(p(&just_over), Fixed::from_bits(1));
    }

    #[test]
    fn range_limits() {
        assert_eq!(p("-2147483648"), Fixed::MIN);
        assert!(parse_decimal("2147483648").is_err());
        assert!(parse_decimal("-2147483648.0000000002").is_err());
        assert_eq!(p("2147483647.99999999976716935634613037109375"), Fixed::MAX);
        assert!(parse_decimal("2147483647.9999999999").is_err());
        assert!(parse_decimal(&"9".repeat(60)).is_err());
    }

    #[test]
    fn rejects_malformed_text() {
        for bad in [
            "", "-", "+", ".5", "5.", "1e3", "1E3", "1.5e-2", "0x10", " 1", "1 ", "1.2.3", "--1",
            "+-1", "NaN", "inf", "1_000",
        ] {
            assert!(parse_decimal(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn display_is_exact_and_round_trips() {
        assert_eq!(Fixed::ONE.to_string(), "1");
        assert_eq!(Fixed::ZERO.to_string(), "0");
        assert_eq!(p("-0.25").to_string(), "-0.25");
        assert_eq!(p("12.5").to_string(), "12.5");
        assert_eq!(Fixed::MIN.to_string(), "-2147483648");
        assert_eq!(
            Fixed::from_bits(1).to_string(),
            "0.00000000023283064365386962890625"
        );
        for bits in [1, -1, 12345, -987_654_321_012, i64::MAX, i64::MIN, 1 << 40] {
            let f = Fixed::from_bits(bits);
            assert_eq!(p(&f.to_string()), f);
        }
    }

    #[test]
    fn arithmetic() {
        let a = p("1.5");
        let b = p("2.25");
        assert_eq!(a + b, p("3.75"));
        assert_eq!(a - b, p("-0.75"));
        assert_eq!(a * b, p("3.375"));
        assert_eq!(p("-0.5") * p("0.5"), p("-0.25"));
        // Rounds toward negative infinity.
        let ulp = Fixed::from_bits(1);
        assert_eq!(ulp * p("0.5"), Fixed::ZERO);
        assert_eq!(Fixed::from_bits(-1) * p("0.5"), Fixed::from_bits(-1));
        assert_eq!(p("2.75").floor_int(), 2);
        assert_eq!(p("-2.25").floor_int(), -3);
    }

    #[test]
    fn division_rounds_toward_negative_infinity() {
        let ulp = Fixed::from_bits(1);
        assert_eq!(Fixed::ONE.checked_div_floor(Fixed::ZERO), None);
        assert_eq!(p("3").checked_div_floor(p("2")), Some(p("1.5")));
        // 1/3 = 0.333.. -> floor of 2^32/3 bits.
        assert_eq!(
            Fixed::ONE.checked_div_floor(p("3")),
            Some(Fixed::from_bits(1_431_655_765))
        );
        assert_eq!(
            p("-1").checked_div_floor(p("3")),
            Some(Fixed::from_bits(-1_431_655_766))
        );
        assert_eq!(
            Fixed::ONE.checked_div_floor(p("-3")),
            Some(Fixed::from_bits(-1_431_655_766))
        );
        assert_eq!(
            p("-1").checked_div_floor(p("-3")),
            Some(Fixed::from_bits(1_431_655_765))
        );
        assert_eq!(p("-7").checked_div_floor(p("-2")), Some(p("3.5")));
        assert_eq!(ulp.checked_div_floor(p("2")), Some(Fixed::ZERO));
        assert_eq!(
            Fixed::from_bits(-1).checked_div_floor(p("2")),
            Some(Fixed::from_bits(-1))
        );
        assert_eq!(Fixed::MAX.checked_div_floor(ulp), Some(Fixed::MAX));
        assert_eq!(Fixed::MIN.checked_div_floor(ulp), Some(Fixed::MIN));
    }

    #[test]
    fn mul_div_rounds_once() {
        // 5.3 × 1 / 1936, floored once from the exact product.
        let drops = p("5.3");
        let r = drops.mul_div_floor(Fixed::ONE, 1936);
        let exact = (drops.to_bits() as i128 * (1i128 << 32)) / (1936i128 << 32);
        assert_eq!(r.to_bits() as i128, exact);
        // Half of 3 ulps over one step: 1.5 ulps -> 1 ulp.
        assert_eq!(
            Fixed::from_bits(3).mul_div_floor(p("0.5"), 1),
            Fixed::from_bits(1)
        );
        assert_eq!(
            Fixed::from_bits(-3).mul_div_floor(p("0.5"), 1),
            Fixed::from_bits(-2)
        );
        assert_eq!(
            p("-1").mul_div_floor(Fixed::ONE, 3),
            Fixed::from_bits(-1_431_655_766)
        );
        assert_eq!(p("2").mul_div_floor(p("0.5"), 4), p("0.25"));
        assert_eq!(p("2").mul_div_floor(Fixed::ZERO, 4), Fixed::ZERO);
        assert_eq!(p("2").mul_div_floor(Fixed::ONE, 0), Fixed::ZERO);
    }

    #[test]
    fn whole_multiples_and_step_counts() {
        assert_eq!(p("0.125").saturating_mul_int(8), Fixed::ONE);
        assert_eq!(p("-0.5").saturating_mul_int(3), p("-1.5"));
        assert_eq!(Fixed::ONE.saturating_mul_int(u64::MAX), Fixed::MAX);
        assert_eq!(p("-1").saturating_mul_int(u64::MAX), Fixed::MIN);
        let step = p("0.25");
        assert_eq!(p("1").ceil_div_steps(step), Some(4));
        assert_eq!(p("1.01").ceil_div_steps(step), Some(5));
        assert_eq!(Fixed::from_bits(1).ceil_div_steps(step), Some(1));
        assert_eq!(Fixed::ZERO.ceil_div_steps(step), Some(0));
        assert_eq!(p("-3").ceil_div_steps(step), Some(0));
        assert_eq!(p("1").ceil_div_steps(Fixed::ZERO), None);
        assert_eq!(p("1").ceil_div_steps(p("-1")), None);
        assert_eq!(p("1").min(p("2")), p("1"));
        assert_eq!(p("2").min(p("-2")), p("-2"));
    }

    #[test]
    fn overflow_saturates_or_is_checked() {
        assert_eq!(Fixed::MAX + Fixed::ONE, Fixed::MAX);
        assert_eq!(Fixed::MIN - Fixed::ONE, Fixed::MIN);
        assert_eq!(Fixed::MAX.checked_add(Fixed::ONE), None);
        assert_eq!(Fixed::MIN.checked_sub(Fixed::ONE), None);
        let big = Fixed::from_int(100_000);
        assert_eq!(big * big, Fixed::MAX);
        assert_eq!(big * Fixed::from_int(-100_000), Fixed::MIN);
    }
}
