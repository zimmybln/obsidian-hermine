/**
 * Compiles a JavaScript arrow function string into a callable function.
 * The expression must be a single arrow function like "(v) => ..."
 */
export function compileTransform(expr: string): ((value: any) => any) | null {
  try {
    const trimmed = expr.trim();
    if (!trimmed.startsWith("(")) {
      console.error("Hermine: Transform must be an arrow function, e.g. (v) => ...");
      return null;
    }
    const fn = new Function(`"use strict"; return (${trimmed});`)();
    if (typeof fn !== "function") {
      console.error("Hermine: Transform did not evaluate to a function");
      return null;
    }
    return fn;
  } catch (e) {
    console.error("Hermine: Failed to compile transform:", e);
    return null;
  }
}

/**
 * Applies a transform to a raw value. Returns raw value if transform is null
 * or throws an error.
 */
export function applyTransform(
  rawValue: any,
  transformFn: ((v: any) => any) | null | undefined
): any {
  if (!transformFn) return rawValue;
  try {
    return transformFn(rawValue);
  } catch (e) {
    console.error("Hermine: Transform execution error for value", rawValue, e);
    return rawValue;
  }
}

/**
 * Builds a reverse map: transformed display value -> array of raw values.
 */
export function buildReverseMap(
  allRawValues: any[],
  transformFn: (v: any) => any
): Map<string, any[]> {
  const reverseMap = new Map<string, any[]>();

  for (const raw of allRawValues) {
    const transformed = String(applyTransform(raw, transformFn));
    if (!reverseMap.has(transformed)) {
      reverseMap.set(transformed, []);
    }
    const arr = reverseMap.get(transformed)!;
    // Avoid duplicates
    if (!arr.includes(raw)) {
      arr.push(raw);
    }
  }

  return reverseMap;
}
