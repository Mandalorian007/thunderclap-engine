//! The raw section encoding: the voxel client's `RAW_SECTION_CODEC`
//! (cells as little-endian `u32`s, or one `u32` when every cell is the
//! same), for a source with no codec of its own. Its
//! [`SectionSource::cells`](crate::SectionSource::cells) is
//! [`decode_raw`], which turns on `Edit` diffs.

/// Encodes `cells` into `out` (cleared first).
pub fn encode_raw(cells: &[u32], out: &mut Vec<u8>) {
    out.clear();
    let uniform = cells.windows(2).all(|w| w[0] == w[1]);
    let cells = if uniform && !cells.is_empty() {
        &cells[..1]
    } else {
        cells
    };
    out.reserve(cells.len() * 4);
    for c in cells {
        out.extend_from_slice(&c.to_le_bytes());
    }
}

/// Decodes a raw section of `len` cells into `out` (cleared first); false
/// if `bytes` is not one.
pub fn decode_raw(bytes: &[u8], len: usize, out: &mut Vec<u32>) -> bool {
    out.clear();
    let (words, rest) = bytes.as_chunks::<4>();
    if !rest.is_empty() {
        return false;
    }
    if let [one] = words {
        out.resize(len, u32::from_le_bytes(*one));
        return true;
    }
    if words.len() != len {
        return false;
    }
    out.extend(words.iter().map(|w| u32::from_le_bytes(*w)));
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_folds_uniform_sections() {
        let mut bytes = Vec::new();
        let mut cells = Vec::new();
        encode_raw(&[7; 64], &mut bytes);
        assert_eq!(bytes, 7u32.to_le_bytes());
        assert!(decode_raw(&bytes, 64, &mut cells));
        assert_eq!(cells, vec![7; 64]);
        let mixed: Vec<u32> = (0..64).collect();
        encode_raw(&mixed, &mut bytes);
        assert_eq!(bytes.len(), 256);
        assert!(decode_raw(&bytes, 64, &mut cells));
        assert_eq!(cells, mixed);
        assert!(!decode_raw(&bytes, 27, &mut cells));
    }
}
