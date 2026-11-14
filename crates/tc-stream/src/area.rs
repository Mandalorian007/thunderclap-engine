//! Interest shapes: an [`Area`]'s box, the boxes between two areas
//! ([`Bounds::minus`], what leaves when an area moves), and the table of
//! offsets an area's sections are sent in, nearest first ([`Offsets`]).
//! Ported from Forge Wilds' chunk interest, its radii per axis so a 2D
//! world (one layer) fits as well as a voxel one.

use crate::msg::{Area, SectionPos};

impl Area {
    /// The box of sections within the radii of `center`.
    pub fn new(center: SectionPos, rx: u8, ry: u8, rz: u8) -> Area {
        Area { center, rx, ry, rz }
    }

    fn radii(&self) -> [i64; 3] {
        [self.rx, self.ry, self.rz].map(i64::from)
    }

    fn center(&self) -> [i64; 3] {
        let c = self.center;
        [c.x, c.y, c.z].map(i64::from)
    }

    /// True if `p` is in the box grown by `extra` sections on every side.
    pub fn contains(&self, p: SectionPos, extra: i64) -> bool {
        let c = self.center();
        let r = self.radii();
        [p.x, p.y, p.z]
            .iter()
            .zip(c.iter().zip(r))
            .all(|(v, (c, r))| (i64::from(*v) - c).abs() <= r + extra)
    }

    /// The box grown by `extra`, as inclusive bounds per axis.
    pub fn bounds(&self, extra: i64) -> Bounds {
        let c = self.center();
        let r = self.radii();
        Bounds([0, 1, 2].map(|i| (c[i] - r[i] - extra, c[i] + r[i] + extra)))
    }

    /// True if every section of the box grown by `extra` has `i32`
    /// coordinates.
    pub fn in_range(&self, extra: i64) -> bool {
        let (lo, hi) = (i64::from(i32::MIN), i64::from(i32::MAX));
        self.bounds(extra)
            .0
            .iter()
            .all(|(a, b)| *a >= lo && *b <= hi)
    }

    /// The section at `o` from the center (inside the box, so no
    /// overflow once [`Area::in_range`] held).
    pub(crate) fn at(&self, o: &Offset) -> SectionPos {
        SectionPos {
            x: self.center.x.wrapping_add(i32::from(o.d[0])),
            y: self.center.y.wrapping_add(i32::from(o.d[1])),
            z: self.center.z.wrapping_add(i32::from(o.d[2])),
        }
    }

    /// True if offset `o` is inside the box.
    pub(crate) fn has(&self, o: &Offset) -> bool {
        o.d.iter()
            .zip(self.radii())
            .all(|(d, r)| i64::from(*d).abs() <= r)
    }

    /// Its squared distance bound: no offset past it is inside the box.
    pub(crate) fn reach(&self) -> i64 {
        self.radii().iter().map(|r| r * r).sum()
    }
}

/// An inclusive box of section coordinates, per axis.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bounds(pub [(i64, i64); 3]);

impl Bounds {
    /// Sections in it.
    pub fn volume(&self) -> u64 {
        self.0
            .iter()
            .map(|(a, b)| if b < a { 0 } else { (b - a + 1) as u64 })
            .product()
    }

    /// `self` minus `other`, as at most six disjoint boxes.
    pub fn minus(&self, other: &Bounds) -> Vec<Bounds> {
        let mut out = Vec::new();
        let mut rest = *self;
        for axis in 0..3 {
            let (a, b) = rest.0[axis];
            let (oa, ob) = other.0[axis];
            if ob < a || oa > b {
                out.push(rest);
                return out;
            }
            if a < oa {
                let mut slab = rest;
                slab.0[axis] = (a, oa - 1);
                out.push(slab);
            }
            if b > ob {
                let mut slab = rest;
                slab.0[axis] = (ob + 1, b);
                out.push(slab);
            }
            rest.0[axis] = (a.max(oa), b.min(ob));
        }
        out
    }

    /// Calls `f` with every section in it that has `i32` coordinates.
    pub fn for_each(&self, mut f: impl FnMut(SectionPos)) {
        let [(x0, x1), (y0, y1), (z0, z1)] = self.0;
        for y in y0..=y1 {
            for z in z0..=z1 {
                for x in x0..=x1 {
                    if let (Ok(x), Ok(y), Ok(z)) =
                        (i32::try_from(x), i32::try_from(y), i32::try_from(z))
                    {
                        f(SectionPos { x, y, z });
                    }
                }
            }
        }
    }
}

/// One offset from an area's center, with its squared distance.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Offset {
    pub(crate) d2: i64,
    pub(crate) d: [i8; 3],
}

/// Every offset inside the largest area a stream allows, nearest first,
/// ties by (dx, dy, dz): the order sections are sent in.
#[derive(Debug)]
pub(crate) struct Offsets(Vec<Offset>);

impl Offsets {
    /// The table for radii up to `max` (each at most 127).
    pub(crate) fn new(max: [u8; 3]) -> Offsets {
        let r = max.map(|m| i8::try_from(m).unwrap_or(i8::MAX));
        let mut out = Vec::new();
        for dx in -r[0]..=r[0] {
            for dy in -r[1]..=r[1] {
                for dz in -r[2]..=r[2] {
                    let d = [dx, dy, dz];
                    let d2 = d.iter().map(|v| i64::from(*v).pow(2)).sum();
                    out.push(Offset { d2, d });
                }
            }
        }
        out.sort_by_key(|o| (o.d2, o.d));
        Offsets(out)
    }

    /// The offsets an `area` covers lie in `[0, end)`.
    pub(crate) fn end(&self, area: &Area) -> usize {
        let reach = area.reach();
        self.0.partition_point(|o| o.d2 <= reach)
    }

    pub(crate) fn get(&self, i: usize) -> Option<&Offset> {
        self.0.get(i)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    fn wanted(offsets: &Offsets, a: &Area) -> Vec<SectionPos> {
        (0..offsets.end(a))
            .filter_map(|i| offsets.get(i))
            .filter(|o| a.has(o))
            .map(|o| a.at(o))
            .collect()
    }

    #[test]
    fn offsets_are_nearest_first_and_cover_the_box() {
        let offsets = Offsets::new([4, 2, 4]);
        for a in [
            Area::new(SectionPos::new(3, -1, 7), 3, 1, 2),
            Area::new(SectionPos::new(0, 0, 0), 4, 2, 4),
            Area::new(SectionPos::new(-5, 5, 0), 2, 2, 0),
        ] {
            let got = wanted(&offsets, &a);
            let set: BTreeSet<_> = got.iter().copied().collect();
            assert_eq!(set.len(), got.len(), "no repeats");
            let mut all = BTreeSet::new();
            a.bounds(0).for_each(|p| {
                all.insert(p);
            });
            assert_eq!(set, all, "exactly the box");
            let d2 = |p: &SectionPos| {
                let c = a.center;
                i64::from(p.x - c.x).pow(2)
                    + i64::from(p.y - c.y).pow(2)
                    + i64::from(p.z - c.z).pow(2)
            };
            assert!(
                got.windows(2).all(|w| d2(&w[0]) <= d2(&w[1])),
                "nearest first"
            );
        }
    }

    #[test]
    fn box_differences_cover_exactly_what_left() {
        let old = Area::new(SectionPos::new(0, 0, 0), 3, 2, 3).bounds(1);
        for new in [
            Area::new(SectionPos::new(2, 0, -1), 3, 2, 3).bounds(1),
            Area::new(SectionPos::new(20, 0, 0), 3, 2, 3).bounds(1),
            Area::new(SectionPos::new(0, 1, 0), 1, 1, 1).bounds(0),
        ] {
            let slabs = old.minus(&new);
            let mut from_slabs = Vec::new();
            for s in &slabs {
                s.for_each(|p| from_slabs.push(p));
            }
            let mut left = BTreeSet::new();
            old.for_each(|p| {
                let inside = [p.x, p.y, p.z]
                    .iter()
                    .zip(new.0)
                    .all(|(v, (a, b))| (a..=b).contains(&i64::from(*v)));
                if !inside {
                    left.insert(p);
                }
            });
            let set: BTreeSet<_> = from_slabs.iter().copied().collect();
            assert_eq!(set.len(), from_slabs.len(), "disjoint slabs");
            assert_eq!(set, left);
            assert_eq!(
                slabs.iter().map(Bounds::volume).sum::<u64>(),
                left.len() as u64
            );
        }
    }

    #[test]
    fn areas_past_the_edge_are_out_of_range() {
        let edge = SectionPos::new(i32::MAX - 1, 0, 0);
        assert!(Area::new(edge, 1, 0, 0).in_range(0));
        assert!(!Area::new(edge, 2, 0, 0).in_range(0));
        assert!(!Area::new(edge, 1, 0, 0).in_range(1));
    }
}
