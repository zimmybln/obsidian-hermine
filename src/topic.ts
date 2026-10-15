import { App, MarkdownPostProcessorContext, MarkdownRenderChild, Notice, TFile, TFolder, debounce, normalizePath, setTooltip } from "obsidian";
import { t } from "./i18n";
import { QueryEngine } from "./query-engine";
import { unclosedBraces } from "./parser";
import { compileTransform } from "./value-transform";
import type { DocumentData } from "./types";

/**
 * Configuration of a `hermione-topic` code block.
 *
 * Scale variants (`skala` / `scale`):
 *   - "direkt" / "direct" (default): explicit min, max and number of steps
 *   - "liste" / "list": ordered list of values (`werte`); implied by `werte`
 *
 * A list scale is mapped onto positions 0 … n-1 (min = 0, max = n-1,
 * one step per entry), so slider, layout and dragging work on numbers
 * for both variants. Only labels and stored values use the list entries.
 */
export interface TopicConfig {
  title?: string;
  description?: string;
  scale: "direct" | "list";
  min: number;
  max: number;
  /** Number of intervals between min and max; undefined = continuous */
  steps?: number;
  /** Ordered scale entries of a list scale */
  values?: string[];
  /** Current slider position (for a list scale: index into values) */
  value?: number;
  /** Folder (or other QueryEngine source) whose documents are shown below the scale */
  source?: string;
  /** Frontmatter property holding each document's value on the scale */
  xAxis?: string;
  /** JavaScript arrow function (props) => style for the document circles */
  cardStyle?: string;
  /** Dragged documents keep the exact value instead of snapping to the steps */
  exact?: boolean;
}

/** Appearance of a single document circle, as returned by card-style */
interface DotStyle {
  color?: string;
  border?: string;
  size?: number;
}

interface PlacedDoc {
  doc: DocumentData;
  value: number;
  style: DotStyle;
}

/** Document without the scale property, shown at the foot of the view */
interface UnassignedDoc {
  doc: DocumentData;
  style: DotStyle;
}

const VALUE_KEYS = ["wert", "value"];
const CARD_STYLE_KEYS = ["card-style", "karten-stil", "cardstyle", "style", "stil"];

/** Above this many steps no individual tick marks are drawn */
const MAX_MARKS = 200;
/** Target maximum number of labelled tick marks */
const MAX_LABELS = 10;
/** Default diameter and minimum gap (px) of the document circles; keep in sync with styles.css */
const DOT_SIZE = 12;
const DOT_GAP = 4;
/** Pointer movement (px) before a press on a circle counts as a drag */
const DRAG_THRESHOLD = 3;

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

/**
 * Parses a hermione-topic code block content into configuration
 */
export function parseTopicBlock(content: string): TopicConfig {
  const config: Partial<TopicConfig> = {};
  // Resolved after parsing, once the scale variant is known
  let rawValue: string | undefined;

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
        break;
      case "description":
      case "beschreibung":
      case "desc":
        config.description = value;
        break;
      case "scale":
      case "skala": {
        const v = value.toLowerCase();
        if (v === "direkt" || v === "direct") config.scale = "direct";
        else if (v === "liste" || v === "list") config.scale = "list";
        else throw new Error(t().topic.unknownScale(value));
        break;
      }
      case "werte":
      case "values":
      case "skala-werte":
      case "scale-values":
        config.values = parseValueList(value);
        break;
      case "min":
      case "minimum":
        config.min = parseNumber(key, value);
        break;
      case "max":
      case "maximum":
        config.max = parseNumber(key, value);
        break;
      case "steps":
      case "schritte":
      case "zwischenschritte": {
        const steps = parseNumber(key, value);
        if (!Number.isInteger(steps) || steps < 1) throw new Error(t().topic.invalidSteps(value));
        config.steps = steps;
        break;
      }
      case "wert":
      case "value":
        if (value) rawValue = value;
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
      case "card-style":
      case "karten-stil":
      case "cardstyle":
      case "style":
      case "stil":
        config.cardStyle = value;
        break;
      case "exakt":
      case "exact":
        config.exact = value.toLowerCase() === "true" || value.toLowerCase() === "ja";
        break;
    }
  }

  config.scale ??= config.values ? "list" : "direct";

  if (config.scale === "list") {
    const values = config.values ?? [];
    if (values.length < 2) throw new Error(t().topic.valuesRequired);
    // min/max/steps are derived from the list
    config.min = 0;
    config.max = values.length - 1;
    config.steps = values.length - 1;
    config.exact = false;
    if (rawValue !== undefined) {
      const index = indexInList(values, rawValue.replace(/^["'](.*)["']$/, "$1"));
      if (index === -1) throw new Error(t().topic.unknownValue(rawValue));
      config.value = index;
    }
  } else {
    config.values = undefined;
    if (config.min === undefined) throw new Error(t().topic.minRequired);
    if (config.max === undefined) throw new Error(t().topic.maxRequired);
    if (config.min >= config.max) throw new Error(t().topic.minGreaterMax);
    if (rawValue !== undefined) config.value = parseNumber("wert", rawValue);
  }

  if (config.source && !config.xAxis) throw new Error(t().topic.xAxisRequired);

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

/** Round away floating point noise (e.g. 0.30000000000000004) */
function clean(num: number): number {
  return Math.round(num * 1e9) / 1e9;
}

/**
 * Renders an interactive slider for a hermione-topic block.
 * The chosen value is written back into the code block as `wert: <n>`.
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

  onload(): void {
    this.render();
  }

  private get stepSize(): number | undefined {
    const { min, max, steps } = this.config;
    return steps ? (max - min) / steps : undefined;
  }

  /** Display text for a scale position */
  private label(pos: number): string {
    return this.config.values ? this.config.values[Math.round(pos)] : String(pos);
  }

  /** Value stored in documents and in the code block for a scale position */
  private toStored(pos: number): string | number {
    return this.config.values ? this.config.values[Math.round(pos)] : pos;
  }

  /** Snap a value onto the scale and clamp it to [min, max] */
  private snap(num: number): number {
    const { min, max } = this.config;
    const step = this.stepSize;
    let v = Math.min(max, Math.max(min, num));
    if (step) v = min + Math.round((v - min) / step) * step;
    return clean(v);
  }

  private render(): void {
    const { config } = this;
    const el = this.containerEl;
    el.empty();

    const container = el.createDiv({ cls: "hermione-topic" });
    if (config.title) container.createEl("h4", { cls: "hermione-title", text: config.title });
    if (config.description) container.createEl("p", { cls: "hermione-description", text: config.description });

    // Grid: slider + value in the first row, tick marks and labels below the slider
    const grid = container.createDiv({ cls: "hermione-topic-grid" });
    const slider = grid.createEl("input", { cls: "hermione-topic-slider", type: "range" });
    slider.min = String(config.min);
    slider.max = String(config.max);
    slider.step = this.stepSize ? String(this.stepSize) : "any";

    const valueEl = grid.createSpan({ cls: "hermione-topic-value" });

    const initial = this.snap(config.value ?? config.min);
    slider.value = String(initial);
    valueEl.setText(this.label(initial));

    const marks = grid.createDiv({ cls: "hermione-topic-marks" });
    const labels = grid.createDiv({ cls: "hermione-topic-labels" });
    const addLabel = (fraction: number, text: string) => {
      labels.createSpan({ cls: "hermione-topic-label", text }).style.left = `${fraction * 100}%`;
    };

    const { steps } = config;
    if (steps && steps <= MAX_MARKS) {
      // Label at most ~MAX_LABELS marks (list scales: every entry); labelled marks are drawn larger
      const labelEvery = config.values ? 1 : Math.ceil(steps / MAX_LABELS);
      for (let i = 0; i <= steps; i++) {
        const major = i % labelEvery === 0 || i === steps;
        const mark = marks.createSpan({ cls: major ? "hermione-topic-mark is-major" : "hermione-topic-mark" });
        mark.style.left = `${(i / steps) * 100}%`;
        if (major) addLabel(i / steps, this.label(clean(config.min + i * this.stepSize!)));
      }
    } else {
      // Continuous scale or too many steps: only the end points
      for (const fraction of [0, 1]) {
        marks.createSpan({ cls: "hermione-topic-mark is-major" }).style.left = `${fraction * 100}%`;
      }
      addLabel(0, String(config.min));
      addLabel(1, String(config.max));
    }

    if (config.source && config.xAxis) {
      this.setupDocuments(
        grid.createDiv({ cls: "hermione-topic-docs" }),
        grid.createDiv({ cls: "hermione-topic-unassigned" }),
        grid.createDiv({ cls: "hermione-topic-docs-info" })
      );
    }

    // Double-click on the thumb creates a new document with the current value
    if (config.source && config.xAxis) {
      this.registerDomEvent(slider, "dblclick", (evt) => {
        if (!this.isOnThumb(slider, evt.clientX)) return;
        void this.createDocument(this.toStored(this.snap(parseFloat(slider.value))));
      });
    }

    // Live update while dragging, persist on release
    this.registerDomEvent(slider, "input", () => {
      valueEl.setText(this.label(this.snap(parseFloat(slider.value))));
    });
    this.registerDomEvent(slider, "change", () => {
      const v = this.snap(parseFloat(slider.value));
      config.value = v;
      void this.persistValue(this.toStored(v));
    });
  }

  // ── Documents below the scale ────────────────────────────────────

  /** Query documents, draw them and keep them up to date */
  private setupDocuments(dotsEl: HTMLElement, unassignedEl: HTMLElement, infoEl: HTMLElement): void {
    const engine = new QueryEngine(this.app);
    const styleFn = this.config.cardStyle ? compileTransform(this.config.cardStyle) : null;
    let docs: PlacedDoc[] = [];
    let unassigned: UnassignedDoc[] = [];

    const load = async () => {
      const { min, max, source, xAxis, values } = this.config;
      let notNumeric = 0;
      let notInList = 0;
      let outOfRange = 0;
      docs = [];
      unassigned = [];

      for (const file of engine.getSourceFiles(source!)) {
        const doc = await engine.getDocumentData(file);
        if (!doc) continue;
        const raw = engine.getPropertyValue(doc.properties, xAxis!);
        if (raw === undefined || raw === null || raw === "") {
          unassigned.push({ doc, style: evaluateDotStyle(doc, styleFn) });
          continue;
        }
        if (values) {
          // List scale: the property must be one of the list entries
          const index = indexInList(values, raw);
          if (index === -1) { notInList++; continue; }
          docs.push({ doc, value: index, style: evaluateDotStyle(doc, styleFn) });
          continue;
        }
        // Numeric scale, so the property must be a number as well
        if (typeof raw !== "number" || isNaN(raw)) { notNumeric++; continue; }
        if (raw < min || raw > max) { outOfRange++; continue; }
        docs.push({ doc, value: raw, style: evaluateDotStyle(doc, styleFn) });
      }

      infoEl.empty();
      if (notNumeric) infoEl.createDiv({ text: t().topic.notNumeric(notNumeric, xAxis!) });
      if (notInList) infoEl.createDiv({ text: t().topic.notInList(notInList, xAxis!) });
      if (outOfRange) infoEl.createDiv({ text: t().topic.outOfRange(outOfRange) });
      layout();
    };

    const layout = () => {
      // Never rebuild the circles underneath an active drag
      if (this.dragging) {
        this.pendingLayout = layout;
        return;
      }
      this.layoutDocuments(dotsEl, docs);
      this.layoutUnassigned(unassignedEl, dotsEl, unassigned);
    };

    // Row assignment depends on the pixel width, so re-layout on resize
    const observer = new ResizeObserver(debounce(layout, 50, true));
    observer.observe(dotsEl);
    this.register(() => observer.disconnect());

    // Reload when documents change, are renamed or deleted
    const reload = debounce(() => void load(), 300, true);
    this.registerEvent(this.app.metadataCache.on("changed", reload));
    this.registerEvent(this.app.vault.on("rename", reload));
    this.registerEvent(this.app.vault.on("delete", reload));

    void load();
  }

  /**
   * Place each document as a circle at the exact position of its value.
   * Documents are processed from left to right; each goes into the topmost
   * row where it does not overlap the previous circle of that row.
   * All rows share the height of the largest circle.
   */
  private layoutDocuments(dotsEl: HTMLElement, docs: PlacedDoc[]): void {
    const { min, max } = this.config;
    const width = dotsEl.clientWidth;
    dotsEl.empty();

    const sorted = [...docs].sort((a, b) => a.value - b.value || a.doc.name.localeCompare(b.doc.name));
    const rowHeight = Math.max(DOT_SIZE, ...sorted.map(d => d.style.size ?? DOT_SIZE)) + DOT_GAP;
    // Right edge (px) of the last circle per row
    const rowEnds: number[] = [];

    for (const { doc, value, style } of sorted) {
      const size = style.size ?? DOT_SIZE;
      const fraction = (value - min) / (max - min);
      const left = fraction * width - size / 2;

      let row = rowEnds.findIndex(end => left - end >= DOT_GAP);
      if (row === -1) row = rowEnds.length;
      rowEnds[row] = left + size;

      const dot = dotsEl.createDiv({ cls: "hermione-topic-doc" });
      dot.style.left = `${fraction * 100}%`;
      dot.style.top = `${row * rowHeight + (rowHeight - DOT_GAP - size) / 2}px`;
      if (style.size) {
        dot.style.width = `${size}px`;
        dot.style.height = `${size}px`;
      }
      if (style.color) dot.style.backgroundColor = style.color;
      if (style.border) dot.style.boxShadow = `inset 0 0 0 2px ${style.border}`;

      setTooltip(dot, t().topic.docTooltip(doc.name, this.label(value)));
      this.makeDraggable(dot, dotsEl, doc, value);
    }

    dotsEl.style.height = `${rowEnds.length * rowHeight}px`;
  }

  /**
   * Drag a circle horizontally within the scale to set the document's value.
   * A click without movement opens the document instead.
   * Listeners are attached directly: the dot is discarded on the next layout.
   */
  private makeDraggable(dot: HTMLElement, dotsEl: HTMLElement, doc: DocumentData, original: number): void {
    const { min, max } = this.config;
    let startX = 0;
    let moved = false;
    let current = original;
    let badge: HTMLElement | null = null;

    const valueAt = (clientX: number) => this.valueAt(clientX, dotsEl);

    dot.addEventListener("pointerdown", (evt) => {
      if (evt.button !== 0) return;
      evt.preventDefault();
      dot.setPointerCapture(evt.pointerId);
      startX = evt.clientX;
      moved = false;
      current = original;
    });

    dot.addEventListener("pointermove", (evt) => {
      if (!dot.hasPointerCapture(evt.pointerId)) return;
      if (!moved && Math.abs(evt.clientX - startX) < DRAG_THRESHOLD) return;

      if (!moved) {
        moved = true;
        this.dragging = true;
        dot.addClass("is-dragging");
        badge = dot.createSpan({ cls: "hermione-topic-doc-badge" });
      }

      current = valueAt(evt.clientX);
      // Only the horizontal position changes; the row stays the same
      dot.style.left = `${((current - min) / (max - min)) * 100}%`;
      badge!.setText(this.label(current));
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
      this.dragging = false;

      if (!cancelled && current !== original) {
        // processFrontMatter keeps the number type and handles CRLF files
        await this.app.fileManager.processFrontMatter(doc.file, (fm) => {
          fm[this.config.xAxis!] = this.toStored(current);
        });
      } else {
        dot.style.left = `${((original - min) / (max - min)) * 100}%`;
      }

      const pending = this.pendingLayout;
      this.pendingLayout = null;
      pending?.();
    };

    dot.addEventListener("pointerup", (evt) => void finish(evt, false));
    dot.addEventListener("pointercancel", (evt) => void finish(evt, true));
  }

  /** Scale position under clientX, snapped (or rounded for `exakt`) and clamped */
  private valueAt(clientX: number, dotsEl: HTMLElement): number {
    const { min, max } = this.config;
    const rect = dotsEl.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const raw = min + fraction * (max - min);
    return this.config.exact ? this.roundExact(raw) : this.snap(raw);
  }

  /** Draw documents without the scale property as a row of circles at the foot */
  private layoutUnassigned(unassignedEl: HTMLElement, dotsEl: HTMLElement, docs: UnassignedDoc[]): void {
    unassignedEl.empty();
    unassignedEl.toggle(docs.length > 0);
    if (!docs.length) return;

    unassignedEl.createDiv({ cls: "hermione-topic-unassigned-title", text: t().topic.unassigned(this.config.xAxis!) });
    const row = unassignedEl.createDiv({ cls: "hermione-topic-unassigned-dots" });

    for (const { doc, style } of [...docs].sort((a, b) => a.doc.name.localeCompare(b.doc.name))) {
      const dot = row.createDiv({ cls: "hermione-topic-doc is-unassigned" });
      if (style.size) {
        dot.style.width = `${style.size}px`;
        dot.style.height = `${style.size}px`;
      }
      if (style.color) dot.style.backgroundColor = style.color;
      if (style.border) dot.style.boxShadow = `inset 0 0 0 2px ${style.border}`;
      setTooltip(dot, doc.name);
      this.makeAssignable(dot, dotsEl, unassignedEl, doc);
    }
  }

  /**
   * Drag a circle from the foot onto the scale to give the document a value.
   * The circle follows the pointer freely; it is assigned only when released
   * above the foot area, using the scale position under the pointer.
   * A click without movement opens the document.
   */
  private makeAssignable(dot: HTMLElement, dotsEl: HTMLElement, footEl: HTMLElement, doc: DocumentData): void {
    let startX = 0;
    let startY = 0;
    let moved = false;
    let target: number | null = null;
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
      // Only a drop above the foot area assigns a value
      target = evt.clientY < footEl.getBoundingClientRect().top ? this.valueAt(evt.clientX, dotsEl) : null;
      badge!.setText(target === null ? "–" : this.label(target));
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
      this.dragging = false;

      if (!cancelled && target !== null) {
        const value = this.toStored(target);
        await this.app.fileManager.processFrontMatter(doc.file, (fm) => {
          fm[this.config.xAxis!] = value;
        });
      } else {
        dot.style.transform = "";
      }

      const pending = this.pendingLayout;
      this.pendingLayout = null;
      pending?.();
    };

    dot.addEventListener("pointerup", (evt) => void finish(evt, false));
    dot.addEventListener("pointercancel", (evt) => void finish(evt, true));
  }

  /** Round an unsnapped value to a precision that fits the scale range */
  private roundExact(num: number): number {
    const { min, max } = this.config;
    const decimals = Math.max(0, Math.ceil(-Math.log10((max - min) / 100)));
    return clean(Number(num.toFixed(decimals)));
  }

  /**
   * Whether clientX lies on the slider thumb. The thumb centre moves from
   * half a thumb width at min to (width - half a thumb width) at max.
   */
  private isOnThumb(slider: HTMLInputElement, clientX: number): boolean {
    const { min, max } = this.config;
    const rect = slider.getBoundingClientRect();
    const thumb = parseFloat(getComputedStyle(slider).getPropertyValue("--slider-thumb-width")) || 18;
    const fraction = (parseFloat(slider.value) - min) / (max - min);
    const centre = rect.left + thumb / 2 + fraction * (rect.width - thumb);
    return Math.abs(clientX - centre) <= thumb / 2 + 2;
  }

  /**
   * Create "<Dokument>-<n>.md" (first free n) in the source folder with the
   * scale property set to the given value. The document is not opened;
   * the change listener picks it up and draws its circle.
   */
  private async createDocument(value: string | number): Promise<void> {
    const source = this.config.source!.replace(/^"(.*)"$/, "$1");
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(source));
    if (!(folder instanceof TFolder)) {
      new Notice(t().topic.sourceNotFolder(source));
      return;
    }

    const base = t().topic.newDocBaseName;
    const prefix = folder.isRoot() ? "" : `${folder.path}/`;
    let n = 1;
    while (this.app.vault.getAbstractFileByPath(`${prefix}${base}-${n}.md`)) n++;

    const file = await this.app.vault.create(`${prefix}${base}-${n}.md`, "");
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm[this.config.xAxis!] = value;
    });
    new Notice(t().topic.created(file.basename));
  }

  /** Write `wert: <value>` into the code block source */
  private async persistValue(value: string | number): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
    if (!(file instanceof TFile)) return;
    const info = this.ctx.getSectionInfo(this.containerEl);

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
        if (match && VALUE_KEYS.includes(match[2].trim().toLowerCase())) {
          lines[i] = `${match[1]}${match[2].trim()}: ${value}`;
          return lines.join(eol);
        }
      }
      lines.splice(block.end, 0, `wert: ${value}`);
      return lines.join(eol);
    });

    // Keep in sync so a later lookup by content still matches
    this.source = this.source.replace(/^(\s*(?:wert|value)\s*:).*$/im, `$1 ${value}`);
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
