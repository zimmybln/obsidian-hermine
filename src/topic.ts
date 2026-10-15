import { App, MarkdownPostProcessorContext, MarkdownRenderChild, Notice, TFile, TFolder, debounce, normalizePath, setTooltip } from "obsidian";
import { t } from "./i18n";
import { QueryEngine } from "./query-engine";
import { unclosedBraces } from "./parser";
import { compileTransform } from "./value-transform";
import type { DocumentData } from "./types";

export type AxisKey = "x" | "y";

/**
 * Scale of one axis.
 *
 * Scale variants (`skala` / `scale`):
 *   - "direkt" / "direct" (default): explicit min, max and number of steps
 *   - "liste" / "list": ordered list of values (`werte`); implied by `werte`
 *
 * A list scale is mapped onto positions 0 … n-1 (min = 0, max = n-1,
 * one step per entry), so slider, layout and dragging work on numbers
 * for both variants. Only labels and stored values use the list entries.
 */
export interface AxisConfig {
  scale: "direct" | "list";
  min: number;
  max: number;
  /** Number of intervals between min and max; undefined = continuous */
  steps?: number;
  /** Ordered scale entries of a list scale */
  values?: string[];
  /** Current slider position (for a list scale: index into values) */
  value?: number;
  /** Dragged documents keep the exact value instead of snapping to the steps */
  exact?: boolean;
  /** Frontmatter property holding each document's value on this axis */
  property?: string;
}

/**
 * Configuration of a `hermione-topic` code block.
 *
 * Axis keys take an optional `x-` / `y-` prefix (`x-min`, `y-werte`, …);
 * unprefixed keys belong to the x axis. A y axis exists as soon as any
 * y key is given; it is drawn vertically on the left, the x axis on top.
 */
export interface TopicConfig {
  title?: string;
  description?: string;
  x: AxisConfig;
  y?: AxisConfig;
  /** Folder (or other QueryEngine source) whose documents are shown in the position matrix */
  source?: string;
  /** JavaScript arrow function (props) => style for the document circles */
  cardStyle?: string;
  /** Length (px) of the vertical axis, i.e. height of the position matrix */
  height: number;
}

/** Appearance of a single document circle, as returned by card-style */
interface DotStyle {
  color?: string;
  border?: string;
  size?: number;
}

/** Scale positions of a document (y only with two axes) */
interface Point {
  x: number;
  y?: number;
}

interface PlacedDoc {
  doc: DocumentData;
  point: Point;
  style: DotStyle;
}

/** Document without (all) scale properties, shown at the foot of the view */
interface UnassignedDoc {
  doc: DocumentData;
  style: DotStyle;
}

type Resolved = number | "missing" | "notNumeric" | "notInList" | "outOfRange";

/** Code block keys holding the persisted slider value per axis */
const VALUE_KEYS: Record<AxisKey, string[]> = {
  x: ["wert", "value", "x-wert", "x-value"],
  y: ["y-wert", "y-value"],
};
const CARD_STYLE_KEYS = ["card-style", "karten-stil", "cardstyle", "style", "stil"];
/** Shorthand keys naming the property of an axis */
const AXIS_PROPERTY_KEYS: Record<string, AxisKey> = { x: "x", xaxis: "x", y: "y", yaxis: "y" };

/** Above this many steps no individual tick marks are drawn */
const MAX_MARKS = 200;
/** Target maximum number of labelled tick marks */
const MAX_LABELS = 10;
/** Default diameter and minimum gap (px) of the document circles; keep in sync with styles.css */
const DOT_SIZE = 12;
const DOT_GAP = 4;
/** Pointer movement (px) before a press on a circle counts as a drag */
const DRAG_THRESHOLD = 3;
/** Default length (px) of the vertical axis */
const DEFAULT_HEIGHT = 240;

function parseNumber(key: string, raw: string): number {
  const num = parseFloat(raw.replace(",", "."));
  if (isNaN(num)) throw new Error(t().topic.notANumber(key, raw));
  return num;
}

/**
 * Parse a list of scale values. Accepts quoted or unquoted entries,
 * optionally wrapped in brackets:
 *   "Nicht wichtig", "mittel wichtig", wichtig
 *   ["Nicht wichtig", "mittel wichtig", "wichtig"]
 */
function parseValueList(raw: string): string[] {
  const inner = raw.trim().replace(/^\[(.*)\]$/s, "$1");
  const values: string[] = [];
  const re = /\s*(?:"([^"]*)"|'([^']*)'|([^,]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(inner)) !== null) {
    const v = (match[1] ?? match[2] ?? match[3]).trim();
    if (v) values.push(v);
  }
  return values;
}

/** Index of a property value in the list scale (trimmed, case-insensitive); -1 if absent */
function indexInList(values: string[], raw: unknown): number {
  if (typeof raw !== "string" && typeof raw !== "number") return -1;
  const needle = String(raw).trim().toLowerCase();
  return values.findIndex(v => v.toLowerCase() === needle);
}

/** Axis settings as written in the code block, before validation */
interface RawAxis {
  scale?: "direct" | "list";
  min?: number;
  max?: number;
  steps?: number;
  values?: string[];
  exact?: boolean;
  value?: string;
  property?: string;
}

/** Apply one (unprefixed) axis key; returns false for unknown keys */
function applyAxisKey(axis: RawAxis, key: string, value: string): boolean {
  switch (key) {
    case "scale":
    case "skala": {
      const v = value.toLowerCase();
      if (v === "direkt" || v === "direct") axis.scale = "direct";
      else if (v === "liste" || v === "list") axis.scale = "list";
      else throw new Error(t().topic.unknownScale(value));
      return true;
    }
    case "werte":
    case "values":
    case "skala-werte":
    case "scale-values":
      axis.values = parseValueList(value);
      return true;
    case "min":
    case "minimum":
      axis.min = parseNumber(key, value);
      return true;
    case "max":
    case "maximum":
      axis.max = parseNumber(key, value);
      return true;
    case "steps":
    case "schritte":
    case "zwischenschritte": {
      const steps = parseNumber(key, value);
      if (!Number.isInteger(steps) || steps < 1) throw new Error(t().topic.invalidSteps(value));
      axis.steps = steps;
      return true;
    }
    case "wert":
    case "value":
      if (value) axis.value = value;
      return true;
    case "exakt":
    case "exact":
      axis.exact = value.toLowerCase() === "true" || value.toLowerCase() === "ja";
      return true;
    case "achse":
    case "axis":
      axis.property = value;
      return true;
  }
  return false;
}

/** Validate an axis and derive min/max/steps for list scales */
function finalizeAxis(raw: RawAxis): AxisConfig {
  const scale = raw.scale ?? (raw.values ? "list" : "direct");

  if (scale === "list") {
    const values = raw.values ?? [];
    if (values.length < 2) throw new Error(t().topic.valuesRequired);
    let value: number | undefined;
    if (raw.value !== undefined) {
      value = indexInList(values, raw.value.replace(/^["'](.*)["']$/, "$1"));
      if (value === -1) throw new Error(t().topic.unknownValue(raw.value));
    }
    return {
      scale, values, value, property: raw.property,
      min: 0, max: values.length - 1, steps: values.length - 1, exact: false,
    };
  }

  if (raw.min === undefined) throw new Error(t().topic.minRequired);
  if (raw.max === undefined) throw new Error(t().topic.maxRequired);
  if (raw.min >= raw.max) throw new Error(t().topic.minGreaterMax);
  return {
    scale, min: raw.min, max: raw.max, steps: raw.steps, exact: raw.exact, property: raw.property,
    value: raw.value !== undefined ? parseNumber("wert", raw.value) : undefined,
  };
}

/**
 * Parses a hermione-topic code block content into configuration
 */
export function parseTopicBlock(content: string): TopicConfig {
  const config: Partial<TopicConfig> = { height: DEFAULT_HEIGHT };
  const raw: Record<AxisKey, RawAxis> = { x: {}, y: {} };
  let hasY = false;

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue;

    const key = trimmed.substring(0, colonIndex).trim().toLowerCase();
    let value = trimmed.substring(colonIndex + 1).trim();

    // Functions may span multiple lines while braces are unbalanced
    if (CARD_STYLE_KEYS.includes(key)) {
      while (i + 1 < lines.length && unclosedBraces(value) > 0) {
        value += "\n" + lines[++i];
      }
    }

    switch (key) {
      case "title":
      case "titel":
      case "überschrift":
        config.title = value;
        continue;
      case "description":
      case "beschreibung":
      case "desc":
        config.description = value;
        continue;
      case "source":
      case "from":
      case "quelle":
        config.source = value;
        continue;
      case "card-style":
      case "karten-stil":
      case "cardstyle":
      case "style":
      case "stil":
        config.cardStyle = value;
        continue;
      case "height":
      case "hoehe":
      case "höhe":
      case "matrix-height":
      case "matrix-hoehe":
      case "matrix-höhe": {
        const height = parseNumber(key, value);
        if (height > 0) config.height = height;
        continue;
      }
    }

    // Axis keys: "x" / "y" / "xaxis" / "yaxis", "x-<key>", "y-<key>" or unprefixed (= x)
    let axis: AxisKey = "x";
    let sub = key;
    if (key in AXIS_PROPERTY_KEYS) {
      axis = AXIS_PROPERTY_KEYS[key];
      sub = "achse";
    } else {
      const prefixed = key.match(/^([xy])-(.+)$/);
      if (prefixed) {
        axis = prefixed[1] as AxisKey;
        sub = prefixed[2];
      }
    }
    if (applyAxisKey(raw[axis], sub, value) && axis === "y") hasY = true;
  }

  config.x = finalizeAxis(raw.x);
  if (hasY) {
    try {
      config.y = finalizeAxis(raw.y);
    } catch (e) {
      throw new Error(t().topic.axisError("y", e.message));
    }
  }

  if (config.source && !config.x.property) throw new Error(t().topic.xAxisRequired);
  if (config.source && config.y && !config.y.property) throw new Error(t().topic.yAxisRequired);

  return config as TopicConfig;
}

/**
 * Evaluate card-style for one document. The function receives all document
 * properties and may return:
 *   - a string  → fill color of the circle
 *   - an object → { color/farbe, border/rahmen, size/größe/groesse }
 *                 (background/hintergrund is accepted as fill as well)
 *   - null/undefined → default styling
 */
function evaluateDotStyle(doc: DocumentData, fn: ((props: Record<string, any>) => any) | null): DotStyle {
  if (!fn) return {};
  try {
    const result = fn(doc.properties);
    if (!result) return {};
    if (typeof result === "string") return { color: result };
    if (typeof result === "object") {
      const size = Number(result.size ?? result.größe ?? result.groesse);
      return {
        color: result.color ?? result.farbe ?? result.background ?? result.hintergrund,
        border: result.border ?? result.rahmen,
        size: size > 0 ? size : undefined,
      };
    }
  } catch (e) {
    console.error("Hermione: card-style evaluation error for", doc.name, e);
  }
  return {};
}

/** Apply card-style results to a circle element */
function applyDotStyle(dot: HTMLElement, style: DotStyle): void {
  if (style.size) {
    dot.style.width = `${style.size}px`;
    dot.style.height = `${style.size}px`;
  }
  if (style.color) dot.style.backgroundColor = style.color;
  if (style.border) dot.style.boxShadow = `inset 0 0 0 2px ${style.border}`;
}

/** Round away floating point noise (e.g. 0.30000000000000004) */
function clean(num: number): number {
  return Math.round(num * 1e9) / 1e9;
}

function clamp01(num: number): number {
  return Math.min(1, Math.max(0, num));
}

/**
 * Renders the sliders of a hermione-topic block and, with a source, the
 * position matrix with one circle per document.
 *
 * Layout (two axes): the x slider runs along the top, the y slider
 * vertically on the left; both meet in the top left corner. The position
 * matrix lies right of the y labels and below the x labels. With one axis
 * the matrix is the area below the x labels.
 *
 * Slider values are written back into the code block (`wert` / `x-wert`, `y-wert`).
 */
export class TopicRenderer extends MarkdownRenderChild {
  constructor(
    containerEl: HTMLElement,
    private app: App,
    private config: TopicConfig,
    private ctx: MarkdownPostProcessorContext,
    private source: string
  ) {
    super(containerEl);
  }

  /** True while a document circle is being dragged */
  private dragging = false;
  /** Layout requested during a drag; executed once the drag ends */
  private pendingLayout: (() => void) | null = null;
  private sliders: Partial<Record<AxisKey, HTMLInputElement>> = {};

  onload(): void {
    this.render();
  }

  // ── Scale helpers ────────────────────────────────────────────────

  private get axes(): AxisKey[] {
    return this.config.y ? ["x", "y"] : ["x"];
  }

  private axis(k: AxisKey): AxisConfig {
    return k === "x" ? this.config.x : this.config.y!;
  }

  private stepSize(k: AxisKey): number | undefined {
    const { min, max, steps } = this.axis(k);
    return steps ? (max - min) / steps : undefined;
  }

  /** Snap a value onto the scale and clamp it to [min, max] */
  private snap(k: AxisKey, num: number): number {
    const { min, max } = this.axis(k);
    const step = this.stepSize(k);
    let v = Math.min(max, Math.max(min, num));
    if (step) v = min + Math.round((v - min) / step) * step;
    return clean(v);
  }

  /** Round an unsnapped value to a precision that fits the scale range */
  private roundExact(k: AxisKey, num: number): number {
    const { min, max } = this.axis(k);
    const decimals = Math.max(0, Math.ceil(-Math.log10((max - min) / 100)));
    return clean(Number(num.toFixed(decimals)));
  }

  /** Relative position (0…1) of a scale value */
  private fraction(k: AxisKey, pos: number): number {
    const { min, max } = this.axis(k);
    return (pos - min) / (max - min);
  }

  /** Scale value at a relative position, snapped (or rounded for `exakt`) */
  private fromFraction(k: AxisKey, fraction: number): number {
    const { min, max, exact } = this.axis(k);
    const raw = min + clamp01(fraction) * (max - min);
    return exact ? this.roundExact(k, raw) : this.snap(k, raw);
  }

  /** Display text for a scale position */
  private label(k: AxisKey, pos: number): string {
    const { values } = this.axis(k);
    return values ? values[Math.round(pos)] : String(pos);
  }

  /** Display text for a point, e.g. "wichtig / 40" */
  private pointLabel(point: Point): string {
    return this.axes.map(k => this.label(k, point[k]!)).join(" / ");
  }

  /** Value stored in documents and in the code block for a scale position */
  private toStored(k: AxisKey, pos: number): string | number {
    const { values } = this.axis(k);
    return values ? values[Math.round(pos)] : pos;
  }

  /** Tick positions of an axis; labelled ticks are "major" */
  private ticks(k: AxisKey): { pos: number; major: boolean }[] {
    const { min, max, steps, values } = this.axis(k);
    if (!steps || steps > MAX_MARKS) {
      // Continuous scale or too many steps: only the end points
      return [{ pos: min, major: true }, { pos: max, major: true }];
    }
    // Label at most ~MAX_LABELS marks (list scales: every entry)
    const labelEvery = values ? 1 : Math.ceil(steps / MAX_LABELS);
    const ticks = [];
    for (let i = 0; i <= steps; i++) {
      ticks.push({ pos: clean(min + i * this.stepSize(k)!), major: i % labelEvery === 0 || i === steps });
    }
    return ticks;
  }

  /** Half the slider thumb width: the thumb centre's distance from the slider ends */
  private thumbInset(): number {
    const width = parseFloat(getComputedStyle(this.containerEl).getPropertyValue("--slider-thumb-width"));
    return (width || 18) / 2;
  }

  /** Vertical pixel position inside the matrix for a y scale value */
  private yToPx(pos: number): number {
    const inset = this.thumbInset();
    return inset + this.fraction("y", pos) * (this.config.height - 2 * inset);
  }

  /** Scale point under the pointer (x always, y with two axes) */
  private pointAt(clientX: number, clientY: number, matrixEl: HTMLElement): Point {
    const rect = matrixEl.getBoundingClientRect();
    const point: Point = { x: this.fromFraction("x", (clientX - rect.left) / rect.width) };
    if (this.config.y) {
      const inset = this.thumbInset();
      point.y = this.fromFraction("y", (clientY - rect.top - inset) / (this.config.height - 2 * inset));
    }
    return point;
  }

  // ── Rendering ────────────────────────────────────────────────────

  private render(): void {
    const { config } = this;
    const el = this.containerEl;
    el.empty();

    const container = el.createDiv({ cls: "hermione-topic" });
    container.toggleClass("is-2d", !!config.y);
    if (config.title) container.createEl("h4", { cls: "hermione-title", text: config.title });
    if (config.description) container.createEl("p", { cls: "hermione-description", text: config.description });

    // Grid areas: see styles.css (.hermione-topic-grid)
    const grid = container.createDiv({ cls: "hermione-topic-grid" });
    for (const k of this.axes) this.renderAxis(grid, k);

    if (config.source) {
      this.setupDocuments(
        grid.createDiv({ cls: "hermione-topic-matrix" }),
        grid.createDiv({ cls: "hermione-topic-unassigned" }),
        grid.createDiv({ cls: "hermione-topic-docs-info" })
      );
    }
  }

  /** Slider, value display, tick marks and labels of one axis */
  private renderAxis(grid: HTMLElement, k: AxisKey): void {
    const a = this.axis(k);
    const vertical = k === "y";

    // The vertical slider is a rotated horizontal one inside a fixed-height wrapper
    const sliderParent = vertical
      ? grid.createDiv({ cls: "hermione-topic-yslider", attr: { style: `height: ${this.config.height}px` } })
      : grid;
    const slider = sliderParent.createEl("input", { cls: `hermione-topic-slider is-${k}`, type: "range" });
    if (vertical) slider.style.width = `${this.config.height}px`;
    slider.min = String(a.min);
    slider.max = String(a.max);
    slider.step = this.stepSize(k) ? String(this.stepSize(k)) : "any";
    this.sliders[k] = slider;

    const valueEl = grid.createSpan({ cls: `hermione-topic-value is-${k}` });
    const initial = this.snap(k, a.value ?? a.min);
    slider.value = String(initial);
    valueEl.setText(this.label(k, initial));

    const marks = grid.createDiv({ cls: `hermione-topic-marks is-${k}` });
    const labels = grid.createDiv({ cls: `hermione-topic-labels is-${k}` });
    const place = (el: HTMLElement, pos: number) => {
      const percent = `${this.fraction(k, pos) * 100}%`;
      if (vertical) el.style.top = percent;
      else el.style.left = percent;
    };
    if (vertical) {
      const length = `calc(${this.config.height}px - 2 * var(--hermione-topic-inset))`;
      marks.style.height = length;
      labels.style.height = length;
    }

    for (const { pos, major } of this.ticks(k)) {
      place(marks.createSpan({ cls: major ? "hermione-topic-mark is-major" : "hermione-topic-mark" }), pos);
      if (!major) continue;
      place(labels.createSpan({ cls: "hermione-topic-label", text: this.label(k, pos) }), pos);
      // Labels are positioned absolutely; invisible copies give the column its width
      if (vertical) labels.createDiv({ cls: "hermione-topic-label-sizer", text: this.label(k, pos) });
    }

    // Double-click on a thumb creates a new document at the current slider values
    if (this.config.source) {
      this.registerDomEvent(slider, "dblclick", (evt) => {
        if (this.isOnThumb(slider, k, evt)) void this.createDocument();
      });
    }

    // Live update while dragging, persist on release
    this.registerDomEvent(slider, "input", () => {
      valueEl.setText(this.label(k, this.snap(k, parseFloat(slider.value))));
    });
    this.registerDomEvent(slider, "change", () => {
      const v = this.snap(k, parseFloat(slider.value));
      a.value = v;
      void this.persistValue(k, this.toStored(k, v));
    });
  }

  /**
   * Whether the pointer lies on the slider thumb. The thumb centre moves from
   * half a thumb width at min to (length - half a thumb width) at max.
   */
  private isOnThumb(slider: HTMLInputElement, k: AxisKey, evt: MouseEvent): boolean {
    const rect = slider.getBoundingClientRect();
    const thumb = this.thumbInset() * 2;
    const f = this.fraction(k, parseFloat(slider.value));
    const [start, length, pointer] = k === "x"
      ? [rect.left, rect.width, evt.clientX]
      : [rect.top, rect.height, evt.clientY];
    const centre = start + thumb / 2 + f * (length - thumb);
    return Math.abs(pointer - centre) <= thumb / 2 + 2;
  }

  // ── Documents in the position matrix ─────────────────────────────

  /** Map a document property onto an axis position, or report why it can't be placed */
  private resolve(k: AxisKey, raw: unknown): Resolved {
    if (raw === undefined || raw === null || raw === "") return "missing";
    const { min, max, values } = this.axis(k);
    if (values) {
      const index = indexInList(values, raw);
      return index === -1 ? "notInList" : index;
    }
    // Numeric scale, so the property must be a number as well
    if (typeof raw !== "number" || isNaN(raw)) return "notNumeric";
    if (raw < min || raw > max) return "outOfRange";
    return raw;
  }

  /** Query documents, draw them and keep them up to date */
  private setupDocuments(matrixEl: HTMLElement, unassignedEl: HTMLElement, infoEl: HTMLElement): void {
    const engine = new QueryEngine(this.app);
    const styleFn = this.config.cardStyle ? compileTransform(this.config.cardStyle) : null;
    let docs: PlacedDoc[] = [];
    let unassigned: UnassignedDoc[] = [];

    const load = async () => {
      // "<reason>:<axis>" → number of documents
      const problems = new Map<string, number>();
      docs = [];
      unassigned = [];

      for (const file of engine.getSourceFiles(this.config.source!)) {
        const doc = await engine.getDocumentData(file);
        if (!doc) continue;

        const point: Partial<Point> = {};
        let missing = false;
        let invalid = false;
        for (const k of this.axes) {
          const res = this.resolve(k, engine.getPropertyValue(doc.properties, this.axis(k).property!));
          if (res === "missing") {
            missing = true;
          } else if (typeof res === "string") {
            invalid = true;
            problems.set(`${res}:${k}`, (problems.get(`${res}:${k}`) ?? 0) + 1);
          } else {
            point[k] = res;
          }
        }

        // Invalid values are only reported; missing ones can be set by dragging
        if (invalid) continue;
        const style = evaluateDotStyle(doc, styleFn);
        if (missing) unassigned.push({ doc, style });
        else docs.push({ doc, point: point as Point, style });
      }

      infoEl.empty();
      for (const [key, count] of problems) {
        const [reason, k] = key.split(":") as [Exclude<Resolved, number | "missing">, AxisKey];
        infoEl.createDiv({ text: t().topic[reason](count, this.axis(k).property!) });
      }
      layout();
    };

    const layout = () => {
      // Never rebuild the circles underneath an active drag
      if (this.dragging) {
        this.pendingLayout = layout;
        return;
      }
      this.layoutDocuments(matrixEl, docs);
      this.layoutUnassigned(unassignedEl, matrixEl, unassigned);
    };

    // Placement depends on the pixel width, so re-layout on resize
    const observer = new ResizeObserver(debounce(layout, 50, true));
    observer.observe(matrixEl);
    this.register(() => observer.disconnect());

    // Reload when documents change, are renamed or deleted
    const reload = debounce(() => void load(), 300, true);
    this.registerEvent(this.app.metadataCache.on("changed", reload));
    this.registerEvent(this.app.vault.on("rename", reload));
    this.registerEvent(this.app.vault.on("delete", reload));

    void load();
  }

  /**
   * Place each document as a circle at the exact position of its values.
   * Processing starts top left (sorted by y, then x). A circle that would
   * overlap an already placed one moves down by one row until it is free;
   * later circles are again aligned with the scale.
   * With one axis all circles start in the top row, which yields rows.
   */
  private layoutDocuments(matrixEl: HTMLElement, docs: PlacedDoc[]): void {
    const twoD = !!this.config.y;
    const width = matrixEl.clientWidth;
    matrixEl.empty();
    if (twoD) this.drawGridLines(matrixEl);

    const sorted = [...docs].sort((a, b) =>
      (a.point.y ?? 0) - (b.point.y ?? 0) || a.point.x - b.point.x || a.doc.name.localeCompare(b.doc.name));
    const rowStep = Math.max(DOT_SIZE, ...sorted.map(d => d.style.size ?? DOT_SIZE)) + DOT_GAP;
    const placed: { cx: number; cy: number; r: number }[] = [];
    let bottom = 0;

    for (const { doc, point, style } of sorted) {
      const size = style.size ?? DOT_SIZE;
      const r = size / 2;
      const fx = this.fraction("x", point.x);
      const cx = fx * width;
      let cy = twoD ? this.yToPx(point.y!) : (rowStep - DOT_GAP) / 2;
      while (placed.some(p => Math.hypot(p.cx - cx, p.cy - cy) < p.r + r + DOT_GAP)) cy += rowStep;
      placed.push({ cx, cy, r });
      bottom = Math.max(bottom, cy + r);

      const dot = matrixEl.createDiv({ cls: "hermione-topic-doc" });
      dot.style.left = `${fx * 100}%`;
      dot.style.top = `${cy - r}px`;
      applyDotStyle(dot, style);
      setTooltip(dot, t().topic.docTooltip(doc.name, this.pointLabel(point)));
      this.makeDraggable(dot, matrixEl, doc, point, size);
    }

    const needed = placed.length ? bottom + DOT_GAP : 0;
    matrixEl.style.height = `${twoD ? Math.max(this.config.height, needed) : needed}px`;
  }

  /** Faint lines at the labelled ticks of both axes (two axes only) */
  private drawGridLines(matrixEl: HTMLElement): void {
    for (const { pos, major } of this.ticks("x")) {
      if (major) matrixEl.createDiv({ cls: "hermione-topic-gridline is-x" }).style.left = `${this.fraction("x", pos) * 100}%`;
    }
    for (const { pos, major } of this.ticks("y")) {
      if (major) matrixEl.createDiv({ cls: "hermione-topic-gridline is-y" }).style.top = `${this.yToPx(pos)}px`;
    }
  }

  /** Write the given point into the document's axis properties */
  private async writePoint(file: TFile, point: Point): Promise<void> {
    // processFrontMatter keeps number types and handles CRLF files
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      for (const k of this.axes) fm[this.axis(k).property!] = this.toStored(k, point[k]!);
    });
  }

  /** Run a layout that was deferred because of an active drag */
  private endDrag(): void {
    this.dragging = false;
    const pending = this.pendingLayout;
    this.pendingLayout = null;
    pending?.();
  }

  /**
   * Drag a circle within the position matrix to set the document's values:
   * horizontally only with one axis, freely with two. The circle snaps to
   * the scale while dragging. A click without movement opens the document.
   * Listeners are attached directly: the dot is discarded on the next layout.
   */
  private makeDraggable(dot: HTMLElement, matrixEl: HTMLElement, doc: DocumentData, original: Point, size: number): void {
    const originalLeft = dot.style.left;
    const originalTop = dot.style.top;
    let startX = 0;
    let startY = 0;
    let moved = false;
    let current = original;
    let badge: HTMLElement | null = null;

    dot.addEventListener("pointerdown", (evt) => {
      if (evt.button !== 0) return;
      evt.preventDefault();
      dot.setPointerCapture(evt.pointerId);
      startX = evt.clientX;
      startY = evt.clientY;
      moved = false;
      current = original;
    });

    dot.addEventListener("pointermove", (evt) => {
      if (!dot.hasPointerCapture(evt.pointerId)) return;
      if (!moved && Math.hypot(evt.clientX - startX, evt.clientY - startY) < DRAG_THRESHOLD) return;

      if (!moved) {
        moved = true;
        this.dragging = true;
        dot.addClass("is-dragging");
        badge = dot.createSpan({ cls: "hermione-topic-doc-badge" });
      }

      current = this.pointAt(evt.clientX, evt.clientY, matrixEl);
      dot.style.left = `${this.fraction("x", current.x) * 100}%`;
      // With one axis the row stays the same
      if (this.config.y) dot.style.top = `${this.yToPx(current.y!) - size / 2}px`;
      badge!.setText(this.pointLabel(current));
    });

    const finish = async (evt: PointerEvent, cancelled: boolean) => {
      if (dot.hasPointerCapture(evt.pointerId)) dot.releasePointerCapture(evt.pointerId);

      if (!moved) {
        if (!cancelled) {
          this.app.workspace.openLinkText(doc.path, this.ctx.sourcePath, evt.ctrlKey || evt.metaKey);
        }
        return;
      }

      dot.removeClass("is-dragging");
      badge?.remove();
      badge = null;

      const changed = this.axes.some(k => current[k] !== original[k]);
      if (!cancelled && changed) {
        await this.writePoint(doc.file, current);
      } else {
        dot.style.left = originalLeft;
        dot.style.top = originalTop;
      }
      this.endDrag();
    };

    dot.addEventListener("pointerup", (evt) => void finish(evt, false));
    dot.addEventListener("pointercancel", (evt) => void finish(evt, true));
  }

  /** Draw documents without (all) axis properties as a row of circles at the foot */
  private layoutUnassigned(unassignedEl: HTMLElement, matrixEl: HTMLElement, docs: UnassignedDoc[]): void {
    unassignedEl.empty();
    unassignedEl.toggle(docs.length > 0);
    if (!docs.length) return;

    const props = this.axes.map(k => this.axis(k).property!);
    unassignedEl.createDiv({ cls: "hermione-topic-unassigned-title", text: t().topic.unassigned(props) });
    const row = unassignedEl.createDiv({ cls: "hermione-topic-unassigned-dots" });

    for (const { doc, style } of [...docs].sort((a, b) => a.doc.name.localeCompare(b.doc.name))) {
      const dot = row.createDiv({ cls: "hermione-topic-doc is-unassigned" });
      applyDotStyle(dot, style);
      setTooltip(dot, doc.name);
      this.makeAssignable(dot, matrixEl, unassignedEl, doc);
    }
  }

  /**
   * Drag a circle from the foot onto the position matrix to give the document
   * its values. The circle follows the pointer freely; it is assigned only
   * when released above the foot area, using the scale point under the
   * pointer. A click without movement opens the document.
   */
  private makeAssignable(dot: HTMLElement, matrixEl: HTMLElement, footEl: HTMLElement, doc: DocumentData): void {
    let startX = 0;
    let startY = 0;
    let moved = false;
    let target: Point | null = null;
    let badge: HTMLElement | null = null;

    dot.addEventListener("pointerdown", (evt) => {
      if (evt.button !== 0) return;
      evt.preventDefault();
      dot.setPointerCapture(evt.pointerId);
      startX = evt.clientX;
      startY = evt.clientY;
      moved = false;
      target = null;
    });

    dot.addEventListener("pointermove", (evt) => {
      if (!dot.hasPointerCapture(evt.pointerId)) return;
      const dx = evt.clientX - startX;
      const dy = evt.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;

      if (!moved) {
        moved = true;
        this.dragging = true;
        dot.addClass("is-dragging");
        badge = dot.createSpan({ cls: "hermione-topic-doc-badge" });
      }

      dot.style.transform = `translate(${dx}px, ${dy}px)`;
      // Only a drop above the foot area assigns values
      target = evt.clientY < footEl.getBoundingClientRect().top
        ? this.pointAt(evt.clientX, evt.clientY, matrixEl)
        : null;
      badge!.setText(target === null ? "–" : this.pointLabel(target));
    });

    const finish = async (evt: PointerEvent, cancelled: boolean) => {
      if (dot.hasPointerCapture(evt.pointerId)) dot.releasePointerCapture(evt.pointerId);

      if (!moved) {
        if (!cancelled) {
          this.app.workspace.openLinkText(doc.path, this.ctx.sourcePath, evt.ctrlKey || evt.metaKey);
        }
        return;
      }

      dot.removeClass("is-dragging");
      badge?.remove();
      badge = null;

      if (!cancelled && target !== null) {
        await this.writePoint(doc.file, target);
      } else {
        dot.style.transform = "";
      }
      this.endDrag();
    };

    dot.addEventListener("pointerup", (evt) => void finish(evt, false));
    dot.addEventListener("pointercancel", (evt) => void finish(evt, true));
  }

  // ── Creating documents ───────────────────────────────────────────

  /**
   * Create "<Dokument>-<n>.md" (first free n) in the source folder with the
   * axis properties set to the current slider values. The document is not
   * opened; the change listener picks it up and draws its circle.
   */
  private async createDocument(): Promise<void> {
    const source = this.config.source!.replace(/^"(.*)"$/, "$1");
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(source));
    if (!(folder instanceof TFolder)) {
      new Notice(t().topic.sourceNotFolder(source));
      return;
    }

    const point: Point = { x: this.snap("x", parseFloat(this.sliders.x!.value)) };
    if (this.config.y) point.y = this.snap("y", parseFloat(this.sliders.y!.value));

    const base = t().topic.newDocBaseName;
    const prefix = folder.isRoot() ? "" : `${folder.path}/`;
    let n = 1;
    while (this.app.vault.getAbstractFileByPath(`${prefix}${base}-${n}.md`)) n++;

    const file = await this.app.vault.create(`${prefix}${base}-${n}.md`, "");
    await this.writePoint(file, point);
    new Notice(t().topic.created(file.basename));
  }

  // ── Persisting slider values in the code block ───────────────────

  /** Write the slider value of an axis into the code block (`wert` / `x-wert`, `y-wert`) */
  private async persistValue(k: AxisKey, value: string | number): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
    if (!(file instanceof TFile)) return;
    const info = this.ctx.getSectionInfo(this.containerEl);
    const keys = VALUE_KEYS[k];
    const newKey = k === "y" ? "y-wert" : this.config.y ? "x-wert" : "wert";

    await this.app.vault.process(file, (data) => {
      const eol = data.includes("\r\n") ? "\r\n" : "\n";
      const lines = data.split(/\r?\n/);
      const block = this.findBlock(lines, info?.lineStart);
      if (!block) {
        console.warn("Hermione: hermione-topic block not found, value not saved");
        return data;
      }

      for (let i = block.start + 1; i < block.end; i++) {
        const match = lines[i].match(/^(\s*)([^:]+):/);
        if (match && keys.includes(match[2].trim().toLowerCase())) {
          lines[i] = `${match[1]}${match[2].trim()}: ${value}`;
          return lines.join(eol);
        }
      }
      lines.splice(block.end, 0, `${newKey}: ${value}`);
      return lines.join(eol);
    });

    // Keep in sync so a later lookup by content still matches
    const keyPattern = new RegExp(`^(\\s*(?:${keys.join("|")})\\s*:).*$`, "im");
    this.source = keyPattern.test(this.source)
      ? this.source.replace(keyPattern, `$1 ${value}`)
      : `${this.source.replace(/\s*$/, "")}\n${newKey}: ${value}`;
  }

  /**
   * Locate this block (opening/closing fence line indices).
   * Prefers the position reported by Obsidian; falls back to matching the
   * block content, then to the only hermione-topic block in the file.
   */
  private findBlock(lines: string[], hint?: number): { start: number; end: number } | null {
    const blocks: { start: number; end: number }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const open = lines[i].match(/^\s*(`{3,}|~{3,})\s*hermione-topic\s*$/);
      if (!open) continue;
      const fence = open[1];
      let end = i + 1;
      while (end < lines.length && !lines[end].trim().startsWith(fence)) end++;
      if (end >= lines.length) break;
      blocks.push({ start: i, end });
      i = end;
    }

    const byHint = blocks.find(b => b.start === hint);
    if (byHint) return byHint;

    const normalize = (s: string) => s.split(/\r?\n/).map(l => l.trim()).filter(l => l).join("\n");
    const wanted = normalize(this.source);
    const byContent = blocks.filter(b => normalize(lines.slice(b.start + 1, b.end).join("\n")) === wanted);
    if (byContent.length === 1) return byContent[0];

    return blocks.length === 1 ? blocks[0] : null;
  }
}
