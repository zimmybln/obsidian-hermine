import { HermioneConfig, DocumentData } from "./types";
import { applyTransform } from "./value-transform";

/**
 * Get property value from object, supporting nested paths (e.g. "file.name")
 */
export function getPropertyValue(obj: Record<string, any>, path: string): any {
  const parts = path.split(".");
  let value: any = obj;
  for (const part of parts) {
    if (value === null || value === undefined) return undefined;
    value = value[part];
  }
  return value;
}

/**
 * Format a value for display
 */
export function formatDisplayValue(value: any): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Evaluate the cardStyle function for a document.
 * Returns a normalized style object.
 */
export function evaluateCardStyle(
  doc: DocumentData,
  cardStyleFn: ((props: Record<string, any>) => any) | null
): { color?: string; background?: string; border?: string; textColor?: string } {
  if (!cardStyleFn) return {};
  try {
    const result = cardStyleFn(doc.properties);
    if (!result) return {};
    if (typeof result === "string") return { color: result };
    if (typeof result === "object") {
      return {
        color: result.color ?? result.farbe,
        background: result.background ?? result.hintergrund,
        border: result.border ?? result.rahmen,
        textColor: result.textColor ?? result.textFarbe ?? result.text,
      };
    }
  } catch (e) {
    console.error("Hermione: card-style evaluation error for", doc.name, e);
  }
  return {};
}

/**
 * Generate a consistent color for a document based on its name
 */
export function getDocumentColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 60%)`;
}

/**
 * Find which cell a numeric value belongs to (floor to nearest step).
 */
export function findBinCell(value: number, cellValues: any[]): number | null {
  const nums = cellValues
    .map(v => parseFloat(String(v)))
    .filter(n => !isNaN(n))
    .sort((a, b) => a - b);
  if (nums.length === 0) return null;
  let bin: number | null = null;
  for (const cv of nums) {
    if (cv <= value) bin = cv;
    else break;
  }
  if (bin === null) bin = nums[0];
  return bin;
}

/**
 * Check if a raw document value matches a cell value.
 */
export function matchesCellValue(
  rawValue: any,
  cellValue: any,
  transformFn: ((v: any) => any) | null,
  isExact: boolean,
  allCellValues: any[]
): boolean {
  const transformed = applyTransform(rawValue, transformFn);
  if (!isExact) return String(transformed) === String(cellValue);

  const numVal = parseFloat(String(transformed));
  const numCell = parseFloat(String(cellValue));
  if (isNaN(numVal) || isNaN(numCell)) return String(transformed) === String(cellValue);

  const bin = findBinCell(numVal, allCellValues);
  return bin !== null && String(bin) === String(cellValue);
}

/**
 * Find the index of the axis value that a raw value maps to.
 * Returns -1 if no match found.
 */
export function findValueIndex(
  rawValue: any,
  axisValues: any[],
  transformFn: ((v: any) => any) | null,
  isExact: boolean
): number {
  for (let i = 0; i < axisValues.length; i++) {
    if (matchesCellValue(rawValue, axisValues[i], transformFn, isExact, axisValues)) {
      return i;
    }
  }
  return -1;
}

/**
 * Check if a document is a range document (has range end values).
 */
export function isRangeDoc(doc: DocumentData, config: HermioneConfig): boolean {
  if (config.xAxisEnd) {
    const endVal = getPropertyValue(doc.properties, config.xAxisEnd);
    if (endVal !== undefined && endVal !== null && endVal !== "") return true;
  }
  if (config.yAxisEnd) {
    const endVal = getPropertyValue(doc.properties, config.yAxisEnd);
    if (endVal !== undefined && endVal !== null && endVal !== "") return true;
  }
  return false;
}

/**
 * Range layout information for a single card
 */
export interface RangeLayout {
  doc: DocumentData;
  xStartIdx: number;
  xEndIdx: number;
  yStartIdx: number;
  yEndIdx: number;
  hasXRange: boolean;
  hasYRange: boolean;
  lane: number;
  totalLanes: number;
}

/**
 * Assign stacking lanes to overlapping range cards using greedy interval graph coloring.
 */
export function assignRangeLanes(layouts: RangeLayout[]): void {
  const overlaps = (a: RangeLayout, b: RangeLayout): boolean => {
    return a.xStartIdx <= b.xEndIdx && b.xStartIdx <= a.xEndIdx
        && a.yStartIdx <= b.yEndIdx && b.yStartIdx <= a.yEndIdx;
  };

  layouts.sort((a, b) => a.yStartIdx !== b.yStartIdx ? a.yStartIdx - b.yStartIdx : a.xStartIdx - b.xStartIdx);

  for (const layout of layouts) {
    const usedLanes = new Set<number>();
    for (const other of layouts) {
      if (other === layout) continue;
      if (other.lane >= 0 && overlaps(layout, other)) usedLanes.add(other.lane);
    }
    let lane = 0;
    while (usedLanes.has(lane)) lane++;
    layout.lane = lane;
  }

  for (const layout of layouts) {
    let maxLane = layout.lane;
    for (const other of layouts) {
      if (other === layout) continue;
      if (overlaps(layout, other)) maxLane = Math.max(maxLane, other.lane);
    }
    layout.totalLanes = maxLane + 1;
  }
}

/**
 * Compute range card layouts with positions and assign stacking lanes.
 */
export function computeRangeLayouts(
  rangeDocs: DocumentData[],
  xValues: any[],
  yValues: any[],
  config: HermioneConfig,
  xTransformFn: ((v: any) => any) | null,
  yTransformFn: ((v: any) => any) | null
): RangeLayout[] {
  const layouts: RangeLayout[] = [];

  for (const doc of rangeDocs) {
    let xStartIdx = 0, xEndIdx = 0, hasXRange = false;
    let yStartIdx = 0, yEndIdx = 0, hasYRange = false;

    if (config.xAxis) {
      const rawXStart = getPropertyValue(doc.properties, config.xAxis);
      xStartIdx = findValueIndex(rawXStart, xValues, xTransformFn, !!config.xExact);
      if (config.xAxisEnd) {
        const rawXEnd = getPropertyValue(doc.properties, config.xAxisEnd);
        if (rawXEnd !== undefined && rawXEnd !== null && rawXEnd !== "") {
          xEndIdx = findValueIndex(rawXEnd, xValues, xTransformFn, !!config.xExact);
          hasXRange = xStartIdx >= 0 && xEndIdx >= 0;
        }
      }
      if (!hasXRange) {
        if (xStartIdx < 0) continue;
        xEndIdx = xStartIdx;
      }
      if (xStartIdx > xEndIdx) [xStartIdx, xEndIdx] = [xEndIdx, xStartIdx];
    }

    if (config.yAxis) {
      const rawYStart = getPropertyValue(doc.properties, config.yAxis);
      yStartIdx = findValueIndex(rawYStart, yValues, yTransformFn, !!config.yExact);
      if (config.yAxisEnd) {
        const rawYEnd = getPropertyValue(doc.properties, config.yAxisEnd);
        if (rawYEnd !== undefined && rawYEnd !== null && rawYEnd !== "") {
          yEndIdx = findValueIndex(rawYEnd, yValues, yTransformFn, !!config.yExact);
          hasYRange = yStartIdx >= 0 && yEndIdx >= 0;
        }
      }
      if (!hasYRange) {
        if (yStartIdx < 0) continue;
        yEndIdx = yStartIdx;
      }
      if (yStartIdx > yEndIdx) [yStartIdx, yEndIdx] = [yEndIdx, yStartIdx];
    }

    layouts.push({ doc, xStartIdx, xEndIdx, yStartIdx, yEndIdx, hasXRange, hasYRange, lane: -1, totalLanes: 1 });
  }

  assignRangeLanes(layouts);
  return layouts;
}

/**
 * Get the range boundaries for a cell in exact mode.
 */
export function getCellRange(cellValue: any, allCellValues: any[]): [number, number] {
  const nums = allCellValues
    .map(v => parseFloat(String(v)))
    .filter(n => !isNaN(n))
    .sort((a, b) => a - b);

  const numCell = parseFloat(String(cellValue));
  const idx = nums.indexOf(numCell);

  const min = numCell;
  const max = idx + 1 < nums.length ? nums[idx + 1] - 1 : numCell;

  return [Math.min(min, max), Math.max(min, max)];
}
