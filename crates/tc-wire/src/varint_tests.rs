//! The codec's vectors: the one set every format's integers rest on.

use super::*;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}

fn write(v: u64) -> Vec<u8> {
    let mut out = Vec::new();
    write_varint(&mut out, v);
    out
}

/// Reads `hex` under `rule`: the result and where reading stopped.
fn read(hex: &str, rule: Varint) -> (Result<u64, WireError>, usize) {
    let mut at = 0;
    (read_varint(&bytes(hex), &mut at, rule), at)
}

const RULES: [Varint; 4] = [
    Varint::CANONICAL,
    Varint::LENIENT,
    Varint::WRAPPING,
    Varint::LENIENT.at_most(6),
];

#[test]
fn varint_vectors() {
    for (value, expected) in [
        (0u64, "00"),
        (1, "01"),
        (127, "7f"),
        (128, "8001"),
        (300, "ac02"),
        (16_383, "ff7f"),
        (16_384, "808001"),
        (u64::from(u32::MAX), "ffffffff0f"),
        (u64::MAX, "ffffffffffffffffff01"),
    ] {
        assert_eq!(hex(&write(value)), expected, "{value}");
        assert_eq!(varint_len(value), expected.len() / 2, "{value}");
        for rule in RULES {
            if expected.len() / 2 <= rule.max_bytes as usize {
                assert_eq!(read(expected, rule), (Ok(value), expected.len() / 2));
            }
        }
    }
}

#[test]
fn lengths_and_round_trips_at_every_boundary() {
    let mut values = vec![u64::MAX - 1, u64::MAX];
    for k in 1..10 {
        values.extend([(1u64 << (7 * k)) - 1, 1 << (7 * k)]);
    }
    // A spread of values of every width (xorshift).
    let mut s = 0x9e37_79b9_7f4a_7c15u64;
    for i in 0..2_000 {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        values.push(s >> (i % 64));
    }
    for v in values {
        let out = write(v);
        assert_eq!(out.len(), varint_len(v), "{v}");
        let mut at = 0;
        assert_eq!(read_varint(&out, &mut at, Varint::CANONICAL), Ok(v));
        assert_eq!(at, out.len());
        let signed = v as i64;
        assert_eq!(unzigzag(zigzag(signed)), signed);
    }
}

#[test]
fn zigzag_vectors() {
    assert_eq!(
        [0, -1, 1, -2, 2, i64::MAX, i64::MIN].map(zigzag),
        [0, 1, 2, 3, 4, u64::MAX - 1, u64::MAX]
    );
    for (value, expected) in [
        (0i64, "00"),
        (-1, "01"),
        (1, "02"),
        (-2, "03"),
        (i64::from(i32::MAX), "feffffff0f"),
        (i64::from(i32::MIN), "ffffffff0f"),
        (i64::MAX, "feffffffffffffffff01"),
        (i64::MIN, "ffffffffffffffffff01"),
    ] {
        assert_eq!(hex(&write(zigzag(value))), expected, "{value}");
        assert_eq!(
            unzigzag(read(expected, Varint::CANONICAL).0.unwrap()),
            value
        );
    }
}

#[test]
fn only_the_canonical_rule_refuses_overlong() {
    assert_eq!(
        read("8000", Varint::CANONICAL),
        (Err(WireError::Overlong), 2)
    );
    assert_eq!(
        read("ff8000", Varint::CANONICAL),
        (Err(WireError::Overlong), 3)
    );
    for rule in &RULES[1..] {
        assert_eq!(read("8000", *rule), (Ok(0), 2));
        assert_eq!(read("ff8000", *rule), (Ok(127), 3));
    }
}

#[test]
fn more_than_64_bits_is_refused_or_dropped() {
    for rule in [Varint::CANONICAL, Varint::LENIENT] {
        assert_eq!(
            read("ffffffffffffffffff02", rule),
            (Err(WireError::Overflow), 10)
        );
        assert_eq!(
            read("ffffffffffffffffff8001", rule),
            (Err(WireError::Overflow), 10)
        );
    }
    // The journal's tenth byte keeps its low bit and drops the rest.
    assert_eq!(
        read("ffffffffffffffffff02", Varint::WRAPPING),
        (Ok(u64::MAX >> 1), 10)
    );
    assert_eq!(
        read("ffffffffffffffffff7f", Varint::WRAPPING),
        (Ok(u64::MAX), 10)
    );
    assert_eq!(
        read("ffffffffffffffffff8001", Varint::WRAPPING),
        (Err(WireError::Overflow), 10)
    );
}

#[test]
fn a_byte_limit_refuses_a_longer_varint() {
    let six = Varint::LENIENT.at_most(6);
    assert_eq!(read("ffffffffff7f", six), (Ok((1 << 42) - 1), 6));
    assert_eq!(read("ffffffffffff01", six), (Err(WireError::Overflow), 6));
    assert_eq!(
        read("8001", Varint::LENIENT.at_most(1)),
        (Err(WireError::Overflow), 1)
    );
}

#[test]
fn truncation_stops_at_the_end() {
    for rule in RULES {
        assert_eq!(read("", rule), (Err(WireError::Truncated), 0));
        assert_eq!(read("8080", rule), (Err(WireError::Truncated), 2));
    }
    // A read starts at `at` and leaves the rest.
    let b = bytes("05ac0207");
    let mut at = 1;
    assert_eq!(read_varint(&b, &mut at, Varint::CANONICAL), Ok(300));
    assert_eq!(at, 3);
}

#[test]
fn a_bounded_read_refuses_a_larger_value() {
    let mut at = 0;
    let max = u64::from(u16::MAX);
    assert_eq!(
        read_varint_max(&bytes("ffff03"), &mut at, Varint::CANONICAL, max),
        Ok(max)
    );
    let mut at = 0;
    assert_eq!(
        read_varint_max(&bytes("808004"), &mut at, Varint::CANONICAL, max),
        Err(WireError::OverBound {
            value: 1 << 16,
            max
        })
    );
    assert_eq!(at, 3);
    let mut at = 0;
    assert_eq!(
        read_varint_max(&bytes("8000"), &mut at, Varint::CANONICAL, max),
        Err(WireError::Overlong)
    );
}

#[test]
fn errors_display() {
    assert_eq!(
        WireError::Truncated.to_string(),
        "the bytes end inside a varint"
    );
    assert_eq!(WireError::Overlong.to_string(), "overlong varint");
    assert_eq!(WireError::Overflow.to_string(), "varint too long");
    assert_eq!(
        WireError::OverBound { value: 9, max: 3 }.to_string(),
        "9 is over 3"
    );
}
