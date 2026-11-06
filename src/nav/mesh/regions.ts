/**
 * Navmesh bake, stage two: regions. A monotone sweep gives every walkable span a region such
 * that no region has a hole; small regions then merge into a neighbour when the merge stays
 * hole-free, and islands below `minRegionArea` are dropped. Recast's `rcBuildRegionsMonotone`
 * and `mergeAndFilterRegions`, in cells.
 */
import { type CompactHeightfield, NOT_CONNECTED, NULL_AREA } from './voxelize';

const NULL_NEI = 0xffff;

interface Region {
  spanCount: number;
  id: number;
  areaType: number;
  remap: boolean;
  visited: boolean;
  overlap: boolean;
  connections: number[];
  floors: number[];
}

function newRegion(id: number): Region {
  return {
    spanCount: 0,
    id,
    areaType: 0,
    remap: false,
    visited: false,
    overlap: false,
    connections: [],
    floors: [],
  };
}

function isSolidEdge(
  chf: CompactHeightfield,
  srcReg: Uint16Array,
  i: number,
  dir: number,
): boolean {
  const ai = chf.con[i * 4 + dir]!;
  const r = ai !== NOT_CONNECTED ? srcReg[ai]! : 0;
  return r !== srcReg[i];
}

/** Walks a region's boundary and lists the neighbour regions met, in order (RecastRegion `walkContour`). */
function walkContour(
  i0: number,
  dir0: number,
  chf: CompactHeightfield,
  srcReg: Uint16Array,
  cont: number[],
): void {
  let i = i0;
  let dir = dir0;
  let curReg = 0;
  const ai0 = chf.con[i * 4 + dir]!;
  if (ai0 !== NOT_CONNECTED) curReg = srcReg[ai0]!;
  cont.push(curReg);
  let iter = 0;
  while (++iter < 40000) {
    if (isSolidEdge(chf, srcReg, i, dir)) {
      const ai = chf.con[i * 4 + dir]!;
      const r = ai !== NOT_CONNECTED ? srcReg[ai]! : 0;
      if (r !== curReg) {
        curReg = r;
        cont.push(curReg);
      }
      dir = (dir + 1) & 3;
    } else {
      const ni = chf.con[i * 4 + dir]!;
      if (ni === NOT_CONNECTED) return;
      i = ni;
      dir = (dir + 3) & 3;
    }
    if (i0 === i && dir0 === dir) break;
  }
  // Remove adjacent duplicates.
  if (cont.length > 1) {
    for (let j = 0; j < cont.length; ) {
      const nj = (j + 1) % cont.length;
      if (cont[j] === cont[nj]) cont.splice(j, 1);
      else j++;
    }
  }
}

function removeAdjacentNeighbours(reg: Region): void {
  const c = reg.connections;
  for (let i = 0; i < c.length && c.length > 1; ) {
    const ni = (i + 1) % c.length;
    if (c[i] === c[ni]) c.splice(i, 1);
    else i++;
  }
}

function replaceNeighbour(reg: Region, oldId: number, newId: number): void {
  let changed = false;
  for (let i = 0; i < reg.connections.length; i++) {
    if (reg.connections[i] === oldId) {
      reg.connections[i] = newId;
      changed = true;
    }
  }
  for (let i = 0; i < reg.floors.length; i++) if (reg.floors[i] === oldId) reg.floors[i] = newId;
  if (changed) removeAdjacentNeighbours(reg);
}

function canMergeWithRegion(rega: Region, regb: Region): boolean {
  if (rega.areaType !== regb.areaType) return false;
  let n = 0;
  for (const c of rega.connections) if (c === regb.id) n++;
  if (n > 1) return false;
  for (const f of rega.floors) if (f === regb.id) return false;
  return true;
}

function addUniqueFloorRegion(reg: Region, n: number): void {
  if (!reg.floors.includes(n)) reg.floors.push(n);
}

function mergeRegions(rega: Region, regb: Region): boolean {
  const aid = rega.id;
  const bid = regb.id;
  const acon = rega.connections.slice();
  const bcon = regb.connections;
  const insa = acon.indexOf(bid);
  if (insa === -1) return false;
  const insb = bcon.indexOf(aid);
  if (insb === -1) return false;
  rega.connections = [];
  for (let i = 0, ni = acon.length; i < ni - 1; i++)
    rega.connections.push(acon[(insa + 1 + i) % ni]!);
  for (let i = 0, ni = bcon.length; i < ni - 1; i++)
    rega.connections.push(bcon[(insb + 1 + i) % ni]!);
  removeAdjacentNeighbours(rega);
  for (const f of regb.floors) addUniqueFloorRegion(rega, f);
  rega.spanCount += regb.spanCount;
  regb.spanCount = 0;
  regb.connections = [];
  return true;
}

function isRegionConnectedToBorder(reg: Region): boolean {
  return reg.connections.includes(0);
}

/** Removes islands under `minRegionArea`, merges small regions, compacts ids; returns the region count. */
function mergeAndFilterRegions(
  chf: CompactHeightfield,
  minRegionArea: number,
  mergeRegionSize: number,
  maxRegionId: number,
  srcReg: Uint16Array,
): number {
  const w = chf.width;
  const h = chf.height;
  const nreg = maxRegionId + 1;
  const regions: Region[] = [];
  for (let i = 0; i < nreg; i++) regions.push(newRegion(i));

  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const c = x + z * w;
      const start = chf.cellIndex[c]!;
      const end = start + chf.cellCount[c]!;
      for (let i = start; i < end; i++) {
        const r = srcReg[i]!;
        if (r === 0 || r >= nreg) continue;
        const reg = regions[r]!;
        reg.spanCount++;
        for (let j = start; j < end; j++) {
          if (i === j) continue;
          const floorId = srcReg[j]!;
          if (floorId === 0 || floorId >= nreg) continue;
          if (floorId === r) reg.overlap = true;
          addUniqueFloorRegion(reg, floorId);
        }
        if (reg.connections.length > 0) continue;
        reg.areaType = chf.areas[i]!;
        let ndir = -1;
        for (let dir = 0; dir < 4; dir++) {
          if (isSolidEdge(chf, srcReg, i, dir)) {
            ndir = dir;
            break;
          }
        }
        if (ndir !== -1) walkContour(i, ndir, chf, srcReg, reg.connections);
      }
    }
  }

  // Remove too small regions.
  const stack: number[] = [];
  const trace: number[] = [];
  for (let i = 0; i < nreg; i++) {
    const reg = regions[i]!;
    if (reg.id === 0) continue;
    if (reg.spanCount === 0) continue;
    if (reg.visited) continue;
    let spanCount = 0;
    stack.length = 0;
    trace.length = 0;
    reg.visited = true;
    stack.push(i);
    while (stack.length > 0) {
      const ri = stack.pop()!;
      const creg = regions[ri]!;
      spanCount += creg.spanCount;
      trace.push(ri);
      for (const nei of creg.connections) {
        // 0 is the null region (the world's edge or an obstacle), never a region to visit.
        if (nei === 0) continue;
        const neireg = regions[nei]!;
        if (neireg.visited) continue;
        if (neireg.id === 0) continue;
        stack.push(nei);
        neireg.visited = true;
      }
    }
    if (spanCount < minRegionArea) {
      for (const ri of trace) {
        regions[ri]!.spanCount = 0;
        regions[ri]!.id = 0;
      }
    }
  }

  // Merge too small regions to neighbour regions.
  let mergeCount: number;
  do {
    mergeCount = 0;
    for (let i = 0; i < nreg; i++) {
      const reg = regions[i]!;
      if (reg.id === 0) continue;
      if (reg.overlap) continue;
      if (reg.spanCount === 0) continue;
      if (reg.spanCount > mergeRegionSize && isRegionConnectedToBorder(reg)) continue;
      let smallest = 0xfffffff;
      let mergeId = reg.id;
      for (const nei of reg.connections) {
        if (nei === 0) continue;
        const mreg = regions[nei]!;
        if (mreg.id === 0 || mreg.overlap) continue;
        if (
          mreg.spanCount < smallest &&
          canMergeWithRegion(reg, mreg) &&
          canMergeWithRegion(mreg, reg)
        ) {
          smallest = mreg.spanCount;
          mergeId = mreg.id;
        }
      }
      if (mergeId !== reg.id) {
        const oldId = reg.id;
        const target = regions[mergeId]!;
        if (mergeRegions(target, reg)) {
          for (let j = 0; j < nreg; j++) {
            const rj = regions[j]!;
            if (rj.id === 0) continue;
            if (rj.id === oldId) rj.id = mergeId;
            replaceNeighbour(rj, oldId, mergeId);
          }
          mergeCount++;
        }
      }
    }
  } while (mergeCount > 0);

  // Compress region ids.
  for (let i = 0; i < nreg; i++) {
    regions[i]!.remap = false;
    if (regions[i]!.id === 0) continue;
    regions[i]!.remap = true;
  }
  let regIdGen = 0;
  for (let i = 0; i < nreg; i++) {
    if (!regions[i]!.remap) continue;
    const oldId = regions[i]!.id;
    const newId = ++regIdGen;
    for (let j = i; j < nreg; j++) {
      if (regions[j]!.id === oldId) {
        regions[j]!.id = newId;
        regions[j]!.remap = false;
      }
    }
  }
  for (let i = 0; i < chf.spanCount; i++) srcReg[i] = regions[srcReg[i]!]!.id;
  return regIdGen;
}

interface Sweep {
  rid: number;
  id: number;
  ns: number;
  nei: number;
}

/**
 * Assigns a region to every walkable span (`chf.regs`; 0 is none) and sets `chf.maxRegions`.
 * `minRegionArea` and `mergeRegionArea` are in cells.
 */
export function buildRegions(
  chf: CompactHeightfield,
  minRegionArea: number,
  mergeRegionArea: number,
): void {
  const w = chf.width;
  const h = chf.height;
  const srcReg = new Uint16Array(chf.spanCount);
  const sweeps: Sweep[] = [];
  for (let i = 0; i < w + 2; i++) sweeps.push({ rid: 0, id: 0, ns: 0, nei: 0 });
  let prev = new Int32Array(256);
  let regId = 1;

  for (let z = 0; z < h; z++) {
    if (prev.length < regId + 1) prev = new Int32Array(Math.max(regId + 1, prev.length * 2));
    prev.fill(0, 0, regId + 1);
    let rid = 1;
    for (let x = 0; x < w; x++) {
      const c = x + z * w;
      const end = chf.cellIndex[c]! + chf.cellCount[c]!;
      for (let i = chf.cellIndex[c]!; i < end; i++) {
        if (chf.areas[i] === NULL_AREA) continue;
        // -x
        let previd = 0;
        const ai0 = chf.con[i * 4 + 0]!;
        if (ai0 !== NOT_CONNECTED && chf.areas[i] === chf.areas[ai0]) previd = srcReg[ai0]!;
        if (previd === 0) {
          previd = rid++;
          const sw = sweeps[previd]!;
          sw.rid = previd;
          sw.ns = 0;
          sw.nei = 0;
        }
        // -z
        const ai3 = chf.con[i * 4 + 3]!;
        if (ai3 !== NOT_CONNECTED && chf.areas[i] === chf.areas[ai3]) {
          const nr = srcReg[ai3]!;
          if (nr !== 0) {
            const sw = sweeps[previd]!;
            if (sw.nei === 0 || sw.nei === nr) {
              sw.nei = nr;
              sw.ns++;
              prev[nr]!++;
            } else {
              sw.nei = NULL_NEI;
            }
          }
        }
        srcReg[i] = previd;
      }
    }
    // Create unique ids.
    for (let i = 1; i < rid; i++) {
      const sw = sweeps[i]!;
      if (sw.nei !== NULL_NEI && sw.nei !== 0 && prev[sw.nei] === sw.ns) sw.id = sw.nei;
      else sw.id = regId++;
    }
    // Remap ids.
    for (let x = 0; x < w; x++) {
      const c = x + z * w;
      const end = chf.cellIndex[c]! + chf.cellCount[c]!;
      for (let i = chf.cellIndex[c]!; i < end; i++) {
        if (srcReg[i]! > 0) srcReg[i] = sweeps[srcReg[i]!]!.id;
      }
    }
  }

  const maxRegionId = mergeAndFilterRegions(chf, minRegionArea, mergeRegionArea, regId - 1, srcReg);
  chf.maxRegions = maxRegionId;
  chf.regs.set(srcReg);
}
