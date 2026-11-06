// Types for scripts/snap.mjs, so e2e/golden.spec.ts can import it under tsconfig.e2e.json.
export const TOLERANCE: number;

export interface Png {
  width: number;
  height: number;
  data: Buffer;
}

export interface CompareResult {
  pass: boolean;
  sizeMismatch: boolean;
  maxDelta: number;
  differing: number;
  beyond: number;
  total: number;
  diff: Png | null;
}

export function decodePng(bytes: Buffer): Png;
export function encodePng(png: Png): Buffer;
export function comparePng(expected: Png, actual: Png, tolerance?: number): CompareResult;
export function describeCompare(name: string, r: CompareResult): string;
export function compareFiles(
  expectedPath: string,
  actualPath: string,
  diffPath?: string,
  tolerance?: number,
): CompareResult;
