import { HermineConfig } from "./types";

/** Keys that accept JavaScript arrow functions (may span multiple lines) */
const FUNCTION_KEYS = new Set([
  "card-style", "karten-stil", "cardstyle", "style", "stil",
  "x-transform", "x-transformation", "xtransform",
  "y-transform", "y-transformation", "ytransform",
]);

/**
 * Count unbalanced opening braces in a string.
 * Returns > 0 when there are more '{' than '}'.
 */
function unclosedBraces(str: string): number {
  let depth = 0;
  for (const ch of str) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  return depth;
}

/**
 * Parse a value list that may be either:
 *   - A range expression: [from..to] or [from..to, Step size]
 *   - A comma-separated list: A, B, C
 *
 * Range examples:
 *   [0..100, Step 10]  → ["0","10","20",...,"100"]
 *   [1..5]             → ["1","2","3","4","5"]
 *   [-10..10, Step 5]  → ["-10","-5","0","5","10"]
 */
function parseAxisValues(value: string): { values: string[]; exact: boolean } {
  // Detect and strip "exakt" / "exact" keyword
  let exact = false;
  if (/\bexakt\b/i.test(value) || /\bexact\b/i.test(value)) {
    exact = true;
    value = value.replace(/,?\s*exakt\b/i, "").replace(/,?\s*exact\b/i, "").trim();
  }

  const rangeMatch = value.match(
    /^\[\s*(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)\s*(?:,\s*[Ss]tep\s+(\d+(?:\.\d+)?))?\s*\]$/
  );

  if (rangeMatch) {
    const from = parseFloat(rangeMatch[1]);
    const to = parseFloat(rangeMatch[2]);
    const step = rangeMatch[3] ? parseFloat(rangeMatch[3]) : 1;

    if (step <= 0) return { values: [String(from)], exact };

    const values: string[] = [];
    if (from <= to) {
      for (let v = from; v <= to + step * 1e-9; v += step) {
        values.push(String(Math.round(v * 1e9) / 1e9));
      }
    } else {
      for (let v = from; v >= to - step * 1e-9; v -= step) {
        values.push(String(Math.round(v * 1e9) / 1e9));
      }
    }
    return { values, exact };
  }

  // Fallback: comma-separated list
  return {
    values: value.split(",").map(s => s.trim()).filter(s => s),
    exact
  };
}

/**
 * Parses a Hermine code block content into configuration
 */
export function parseHermineBlock(content: string): HermineConfig {
  const lines = content.trim().split("\n");
  const config: Partial<HermineConfig> = {};

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) {
      continue;
    }

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue;

    const key = trimmed.substring(0, colonIndex).trim().toLowerCase();
    let value = trimmed.substring(colonIndex + 1).trim();

    // For function keys, collect continuation lines when braces are unbalanced
    if (FUNCTION_KEYS.has(key) && unclosedBraces(value) > 0) {
      while (i + 1 < lines.length && unclosedBraces(value) > 0) {
        i++;
        value += "\n" + lines[i];
      }
    }

    switch (key) {
      case "title":
      case "titel":
      case "überschrift":
        config.title = value;
        break;
      case "source":
      case "from":
      case "quelle":
        config.source = value;
        break;
      case "x":
      case "x-axis":
      case "x-achse":
      case "xaxis":
        config.xAxis = value;
        break;
      case "y":
      case "y-axis":
      case "y-achse":
      case "yaxis":
        config.yAxis = value || undefined;
        break;
      case "x-werte":
      case "x-values":
      case "xvalues":
      case "x-options":
        {
          const xParsed = parseAxisValues(value);
          config.xValues = xParsed.values;
          if (xParsed.exact) config.xExact = true;
        }
        break;
      case "y-werte":
      case "y-values":
      case "yvalues":
      case "y-options":
        {
          const yParsed = parseAxisValues(value);
          config.yValues = yParsed.values;
          if (yParsed.exact) config.yExact = true;
        }
        break;
      case "x-label":
      case "x-beschriftung":
      case "xlabel":
        config.xLabel = value;
        break;
      case "y-label":
      case "y-beschriftung":
      case "ylabel":
        config.yLabel = value;
        break;
      case "x-readonly":
      case "x-gesperrt":
      case "xreadonly":
        config.xReadonly = value.toLowerCase() !== "false" && value !== "0";
        break;
      case "y-readonly":
      case "y-gesperrt":
      case "yreadonly":
        config.yReadonly = value.toLowerCase() !== "false" && value !== "0";
        break;
      case "x-exakt":
      case "x-exact":
      case "xexact":
        config.xExact = value.toLowerCase() !== "false" && value !== "0";
        break;
      case "y-exakt":
      case "y-exact":
      case "yexact":
        config.yExact = value.toLowerCase() !== "false" && value !== "0";
        break;
      case "readonly":
      case "gesperrt":
        {
          const on = value.toLowerCase() !== "false" && value !== "0";
          config.xReadonly = on;
          config.yReadonly = on;
        }
        break;
      case "card-style":
      case "karten-stil":
      case "cardstyle":
      case "style":
      case "stil":
        config.cardStyle = value;
        break;
      case "x-transform":
      case "x-transformation":
      case "xtransform":
        config.xTransform = value;
        break;
      case "y-transform":
      case "y-transformation":
      case "ytransform":
        config.yTransform = value;
        break;
      case "display":
      case "anzeigen":
      case "show":
        config.display = value.split(",").map(s => s.trim()).filter(s => s);
        break;
      case "sort":
      case "sortieren":
        const sortParts = value.split(/\s+/);
        config.sort = {
          by: sortParts[0],
          order: (sortParts[1]?.toLowerCase() === "desc" ? "desc" : "asc")
        };
        break;
      case "where":
      case "filter":
        config.where = value;
        break;
      case "theme":
      case "thema":
      case "design":
        config.theme = value.toLowerCase();
        break;
      case "hide-unassigned":
      case "unzugeordnete-ausblenden":
      case "nicht-zugeordnet-ausblenden":
      case "hideunassigned":
        config.hideUnassigned = value.toLowerCase() !== "false" && value !== "0";
        break;
    }
  }

  // Validate required fields
  if (!config.source) {
    throw new Error("Missing required field: source (Quelle)");
  }
  if (!config.xAxis && !config.yAxis) {
    throw new Error("Mindestens eine Achse muss angegeben werden (X-Achse oder Y-Achse)");
  }

  return config as HermineConfig;
}

/**
 * Validates the configuration
 */
export function validateConfig(config: HermineConfig): string[] {
  const errors: string[] = [];

  if (!config.source) {
    errors.push("Source is required");
  }
  if (!config.xAxis) {
    errors.push("X-Axis property is required");
  }

  return errors;
}
