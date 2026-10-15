import { App, TFile, MarkdownRenderChild, setIcon, MarkdownRenderer, Component } from "obsidian";
import { t } from "./i18n";
import { HermioneConfig, DocumentData, QueryResult } from "./types";
import { FrontmatterUpdater } from "./frontmatter-updater";
import { compileTransform, applyTransform, buildReverseMap } from "./value-transform";
import { ValuePickerModal } from "./value-picker-modal";
import { ExactValueModal } from "./exact-value-modal";
import {
  getPropertyValue, formatDisplayValue, evaluateCardStyle, getDocumentColor,
  matchesCellValue, findValueIndex, isRangeDoc,
  computeRangeLayouts, getCellRange, RangeLayout
} from "./renderer-utils";

// ── Types ────────────────────────────────────────────────────────────

interface Rect { x: number; y: number; w: number; h: number; }

interface CardInfo {
  doc: DocumentData;
  rect: Rect;
  style: { color?: string; background?: string; border?: string; textColor?: string };
  colorBarColor: string;
  isRange: boolean;
  isVertical: boolean;
  rangeLayout?: RangeLayout;
  textLines: string[];
}

interface CellInfo {
  rect: Rect;
  xVal: any;
  yVal: any;
  xIdx: number;
  yIdx: number;
}

interface HeaderInfo {
  rect: Rect;
  label: string;
  axis: "x" | "y";
}

type HitRegion =
  | { type: "card"; card: CardInfo }
  | { type: "cell"; cell: CellInfo }
  | { type: "handle"; edge: "start" | "end"; axis: "x" | "y"; card: CardInfo };

// ── Constants ────────────────────────────────────────────────────────

const GAP = 8;
const HEADER_PAD = 12;
const CELL_PAD = 8;
const CARD_PAD_V = 6;
const LINE_HEIGHT = 16;
const CARD_FONT = `500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
const COLOR_BAR_W = 4;
const CARD_RADIUS = 4;
const CELL_RADIUS = 6;
const HEADER_RADIUS = 4;
const MIN_CELL_W = 120;
const MIN_CELL_H = 80;
const Y_HEADER_W = 110;
const HANDLE_SIZE = 8;
const DRAG_THRESHOLD = 5;

// Dot mode constants
const DOT_RADIUS = 12;
const DOT_GAP = 6;
const DOT_SPACING = DOT_RADIUS * 2 + DOT_GAP; // 30
const GROUP_BG_PAD = 12;
const GROUP_BG_ALPHA = 0.12;

const ZOOM_MIN = 50;
const ZOOM_MAX = 150;
const ZOOM_STEP = 10;

// ── Canvas Renderer ──────────────────────────────────────────────────

export class CanvasRenderer extends MarkdownRenderChild {
  private updater: FrontmatterUpdater;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private dpr = 1;

  // Layout data
  private cells: CellInfo[] = [];
  private xHeaders: HeaderInfo[] = [];
  private yHeaders: HeaderInfo[] = [];
  private cards: CardInfo[] = [];
  private totalW = 0;
  private totalH = 0;

  // Axis values
  private xValues: any[] = [];
  private yValues: any[] = [];
  private isYOnly = false;
  private isSingleAxis = false;

  // Transforms
  private xTransformFn: ((v: any) => any) | null = null;
  private yTransformFn: ((v: any) => any) | null = null;
  private xReverseMap: Map<string, any[]> | null = null;
  private yReverseMap: Map<string, any[]> | null = null;
  private cardStyleFn: ((props: Record<string, any>) => any) | null = null;

  // Interaction state
  private zoomLevel = 100;
  private zoomDisplay: HTMLElement | null = null;
  private previewEl: HTMLElement | null = null;
  private previewTimeout: ReturnType<typeof setTimeout> | null = null;
  private hoveredCard: CardInfo | null = null;

  private dragState: {
    card: CardInfo;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    dragging: boolean;
    targetCell: CellInfo | null;
  } | null = null;

  private resizeState: {
    card: CardInfo;
    edge: "start" | "end";
    axis: "x" | "y";
    mousePos: number;
  } | null = null;

  // Text measurement (offscreen)
  private measureCtx: CanvasRenderingContext2D | null = null;

  // Dot-mode: groups of multiple dots sharing the same cell
  private dotGroups: Array<{ cx: number; cy: number; r: number }> = [];

  // Theme colors (resolved from CSS vars)
  private colors = {
    bg: "#1e1e2e",
    bgSecondary: "#313244",
    bgPrimary: "#181825",
    accent: "#89b4fa",
    accentText: "#1e1e2e",
    text: "#cdd6f4",
    textMuted: "#a6adc8",
    border: "#45475a",
    borderHover: "#585b70",
    cellBg: "#181825",
    cellBorder: "#45475a",
    headerXBg: "#89b4fa",
    headerYBg: "#313244",
    cardBg: "#313244",
    dropActive: "rgba(137, 180, 250, 0.15)",
    dropHover: "rgba(137, 180, 250, 0.3)",
  };

  constructor(
    containerEl: HTMLElement,
    private app: App,
    private config: HermioneConfig,
    private result: QueryResult,
    private onRefresh: () => void
  ) {
    super(containerEl);
    this.updater = new FrontmatterUpdater(app);
  }

  onload(): void {
    // Compile transforms
    if (this.config.xTransform) {
      this.xTransformFn = compileTransform(this.config.xTransform);
      if (this.xTransformFn && this.result.xAxisRawValues) {
        this.xReverseMap = buildReverseMap(this.result.xAxisRawValues, this.xTransformFn);
      }
    }
    if (this.config.yTransform) {
      this.yTransformFn = compileTransform(this.config.yTransform);
      if (this.yTransformFn && this.result.yAxisRawValues) {
        this.yReverseMap = buildReverseMap(this.result.yAxisRawValues, this.yTransformFn);
      }
    }
    if (this.config.cardStyle) {
      this.cardStyleFn = compileTransform(this.config.cardStyle);
    }

    this.render();
  }

  onunload(): void {
    this.hidePreview();
  }

  // ── Main Render ──────────────────────────────────────────────────

  private render(): void {
    this.containerEl.empty();
    this.containerEl.addClass("hermione-container");
    if (this.config.theme) {
      this.containerEl.addClass(`hermione-theme-${this.config.theme}`);
    }

    if (this.config.title) {
      this.containerEl.createEl("h3", { cls: "hermione-title", text: this.config.title });
    }
    if (this.config.description) {
      this.containerEl.createEl("p", { cls: "hermione-description", text: this.config.description });
    }

    if (this.result.errors.length > 0) {
      const errorContainer = this.containerEl.createDiv({ cls: "hermione-errors" });
      for (const error of this.result.errors) {
        errorContainer.createDiv({ cls: "hermione-error", text: error });
      }
      return;
    }

    if (this.result.documents.length === 0) {
      this.containerEl.createDiv({ cls: "hermione-empty", text: t().renderer.noDocuments });
      return;
    }

    // Resolve theme colors from CSS variables
    this.resolveColors();

    // Determine axes
    this.isYOnly = !this.config.xAxis && !!this.config.yAxis;
    this.isSingleAxis = !this.config.xAxis || !this.config.yAxis;

    this.xValues = this.config.xValues
      ? this.config.xValues
      : Array.from(this.result.xAxisValues).sort();
    this.yValues = this.config.yValues
      ? this.config.yValues
      : Array.from(this.result.yAxisValues).sort();

    // Calculate layout and build cards
    this.calculateLayout();

    // Create canvas wrapper
    const wrapper = this.containerEl.createDiv({ cls: "hermione-canvas-wrapper" });

    // Axis labels
    if (!this.isSingleAxis && this.config.yLabel) {
      const yLabelEl = wrapper.createDiv({ cls: "hermione-axis-label-y" });
      yLabelEl.createSpan({ text: this.config.yLabel });
    }

    const canvasContainer = wrapper.createDiv({ cls: "hermione-canvas-container" });

    // Create canvas
    this.dpr = window.devicePixelRatio || 1;
    this.canvas = document.createElement("canvas");
    this.canvas.classList.add("hermione-canvas");
    canvasContainer.appendChild(this.canvas);

    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    this.ctx = ctx;

    this.applyCanvasSize();
    this.draw();
    this.setupEventListeners();

    // Axis label below
    if (this.config.xLabel || (this.isSingleAxis && (this.config.xLabel || this.config.yLabel))) {
      const label = this.isSingleAxis
        ? (this.isYOnly ? (this.config.yLabel || this.config.xLabel) : (this.config.xLabel || this.config.yLabel))
        : this.config.xLabel;
      if (label) {
        const xLabelEl = canvasContainer.createDiv({ cls: "hermione-canvas-xlabel" });
        xLabelEl.createSpan({ text: label });
      }
    }

    // Unassigned section (DOM-based)
    this.renderUnassigned();

    // Toolbar
    this.renderToolbar();
  }

  // ── Color Resolution ─────────────────────────────────────────────

  private resolveColors(): void {
    const el = this.containerEl;
    const cs = getComputedStyle(el);
    const get = (v: string, fallback: string): string => {
      const val = cs.getPropertyValue(v).trim();
      return val || fallback;
    };

    this.colors.bg = get("--background-secondary", "#313244");
    this.colors.bgSecondary = get("--background-secondary", "#313244");
    this.colors.bgPrimary = get("--background-primary", "#181825");
    this.colors.accent = get("--interactive-accent", "#89b4fa");
    this.colors.accentText = get("--text-on-accent", "#1e1e2e");
    this.colors.text = get("--text-normal", "#cdd6f4");
    this.colors.textMuted = get("--text-muted", "#a6adc8");
    this.colors.border = get("--background-modifier-border", "#45475a");
    this.colors.borderHover = get("--background-modifier-border-hover", "#585b70");
    this.colors.cellBg = this.colors.bgPrimary;
    this.colors.cellBorder = this.colors.border;
    this.colors.headerXBg = this.colors.accent;
    this.colors.headerYBg = this.colors.bgSecondary;
    this.colors.cardBg = this.colors.bgSecondary;

    if (this.config.theme === "glass") {
      this.colors.cellBg = "rgba(255,255,255,0.02)";
      this.colors.cellBorder = "rgba(255,255,255,0.06)";
      this.colors.headerXBg = "rgba(137,180,250,0.2)";
      this.colors.headerYBg = "rgba(255,255,255,0.06)";
      this.colors.cardBg = "rgba(255,255,255,0.08)";
      this.colors.bg = "rgba(255,255,255,0.03)";
      this.colors.dropActive = "rgba(137,180,250,0.06)";
      this.colors.dropHover = "rgba(137,180,250,0.12)";
    }
  }

  // ── Text Measurement ─────────────────────────────────────────────

  private getMeasureCtx(): CanvasRenderingContext2D {
    if (!this.measureCtx) {
      const offscreen = document.createElement("canvas");
      this.measureCtx = offscreen.getContext("2d")!;
    }
    return this.measureCtx;
  }

  private wrapText(text: string, maxWidth: number): string[] {
    if (maxWidth <= 0) return [text];
    const ctx = this.getMeasureCtx();
    ctx.font = CARD_FONT;

    if (ctx.measureText(text).width <= maxWidth) return [text];

    const words = text.split(/\s+/);
    const lines: string[] = [];
    let currentLine = "";

    for (const word of words) {
      const testLine = currentLine ? currentLine + " " + word : word;
      if (ctx.measureText(testLine).width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines.length > 0 ? lines : [""];
  }

  // ── Value-to-Pixel Interpolation ─────────────────────────────────

  /**
   * Maps a raw numeric value to an exact pixel position on the given axis.
   * Uses piecewise linear interpolation between adjacent cell centers so that
   * non-uniform axis spacing and variable cell heights are handled correctly.
   */
  private interpolatePosition(rawValue: number, axisValues: any[], axis: "x" | "y"): number | null {
    if (isNaN(rawValue)) return null;

    // Collect valid numeric axis entries with their cell centers
    const entries: { val: number; center: number }[] = [];
    for (let i = 0; i < axisValues.length; i++) {
      const v = parseFloat(String(axisValues[i]));
      if (isNaN(v)) continue;
      const cell = this.cells.find(c =>
        axis === "x" ? c.xIdx === i : c.yIdx === i
      );
      if (!cell) continue;
      entries.push({
        val: v,
        center: axis === "x"
          ? cell.rect.x + cell.rect.w / 2
          : cell.rect.y + cell.rect.h / 2
      });
    }
    if (entries.length < 2) return null;

    // Sort ascending by numeric value
    entries.sort((a, b) => a.val - b.val);

    // Clamp to known range
    if (rawValue <= entries[0].val) return entries[0].center;
    if (rawValue >= entries[entries.length - 1].val) return entries[entries.length - 1].center;

    // Piecewise linear interpolation between adjacent entries
    for (let i = 0; i < entries.length - 1; i++) {
      const a = entries[i];
      const b = entries[i + 1];
      if (rawValue >= a.val && rawValue <= b.val) {
        if (a.val === b.val) return a.center;
        const t = (rawValue - a.val) / (b.val - a.val);
        return a.center + t * (b.center - a.center);
      }
    }

    return null;
  }

  // ── Layout Calculation ───────────────────────────────────────────

  private calculateLayout(): void {
    this.cells = [];
    this.xHeaders = [];
    this.yHeaders = [];
    this.cards = [];
    this.dotGroups = [];

    if (this.isSingleAxis) {
      this.calculateSingleAxisLayout();
    } else {
      this.calculateMatrixLayout();
    }
  }

  private calculateMatrixLayout(): void {
    const xCount = this.xValues.length;
    const yCount = this.yValues.length;
    if (xCount === 0 || yCount === 0) return;

    const cellW = Math.max(MIN_CELL_W, 180);
    const headerH = 44;

    // Separate range docs from point docs
    const hasRangeConfig = !!this.config.xAxisEnd || !!this.config.yAxisEnd;
    const rangeDocs = hasRangeConfig
      ? this.result.documents.filter(doc => isRangeDoc(doc, this.config))
      : [];
    const rangeDocPaths = new Set(rangeDocs.map(d => d.path));

    // Assign point docs to cells and compute cell heights
    const cellDocs: DocumentData[][][] = [];
    for (let yi = 0; yi < yCount; yi++) {
      cellDocs[yi] = [];
      for (let xi = 0; xi < xCount; xi++) {
        cellDocs[yi][xi] = this.result.documents.filter(doc => {
          if (rangeDocPaths.has(doc.path)) return false;
          const rawX = getPropertyValue(doc.properties, this.config.xAxis!);
          const rawY = getPropertyValue(doc.properties, this.config.yAxis!);
          const xMatch = Array.isArray(rawX)
            ? rawX.some(v => matchesCellValue(v, this.xValues[xi], this.xTransformFn, !!this.config.xExact, this.xValues))
            : matchesCellValue(rawX, this.xValues[xi], this.xTransformFn, !!this.config.xExact, this.xValues);
          const yMatch = Array.isArray(rawY)
            ? rawY.some(v => matchesCellValue(v, this.yValues[yi], this.yTransformFn, !!this.config.yExact, this.yValues))
            : matchesCellValue(rawY, this.yValues[yi], this.yTransformFn, !!this.config.yExact, this.yValues);
          return xMatch && yMatch;
        });
      }
    }

    // Row heights based on dot cluster size
    const rowHeights: number[] = [];
    for (let yi = 0; yi < yCount; yi++) {
      let maxClusterH = 0;
      for (let xi = 0; xi < xCount; xi++) {
        maxClusterH = Math.max(maxClusterH, this.dotClusterHeight(cellDocs[yi][xi].length));
      }
      rowHeights[yi] = Math.max(MIN_CELL_H, maxClusterH + CELL_PAD * 2);
    }

    // Build layout
    const originX = GAP;
    const originY = GAP;
    let curY = originY;

    // X headers
    const xHeaderY = curY;
    for (let xi = 0; xi < xCount; xi++) {
      const x = originX + Y_HEADER_W + GAP + xi * (cellW + GAP);
      this.xHeaders.push({
        rect: { x, y: xHeaderY, w: cellW, h: headerH },
        label: String(this.xValues[xi]),
        axis: "x"
      });
    }
    curY += headerH + GAP;

    // Rows
    for (let yi = 0; yi < yCount; yi++) {
      const rowH = rowHeights[yi];

      // Y header
      this.yHeaders.push({
        rect: { x: originX, y: curY, w: Y_HEADER_W, h: rowH },
        label: String(this.yValues[yi]),
        axis: "y"
      });

      // Cells
      for (let xi = 0; xi < xCount; xi++) {
        const cx = originX + Y_HEADER_W + GAP + xi * (cellW + GAP);
        const cellRect: Rect = { x: cx, y: curY, w: cellW, h: rowH };
        this.cells.push({
          rect: cellRect,
          xVal: this.xValues[xi],
          yVal: this.yValues[yi],
          xIdx: xi,
          yIdx: yi
        });

        // Place dots for this cell (centered)
        const docs = cellDocs[yi][xi];
        const cellCX = cx + cellW / 2;
        const cellCY = curY + rowHeights[yi] / 2;
        this.placeDots(docs, cellCX, cellCY);
      }

      curY += rowH + GAP;
    }

    // Range cards
    if (rangeDocs.length > 0) {
      const layouts = computeRangeLayouts(rangeDocs, this.xValues, this.yValues, this.config, this.xTransformFn, this.yTransformFn);
      const rangeGap = 2;

      for (const layout of layouts) {
        const startCell = this.findCell(layout.xStartIdx, layout.yStartIdx);
        const endCell = this.findCell(layout.xEndIdx, layout.yEndIdx);
        if (!startCell || !endCell) continue;

        // Default to cell boundaries
        let left = startCell.rect.x;
        let top = startCell.rect.y;
        let right = endCell.rect.x + endCell.rect.w;
        let bottom = endCell.rect.y + endCell.rect.h;

        // Interpolate exact positions for range dimensions
        if (layout.hasXRange && this.config.xAxis && this.config.xAxisEnd) {
          const rawStart = getPropertyValue(layout.doc.properties, this.config.xAxis);
          const rawEnd = getPropertyValue(layout.doc.properties, this.config.xAxisEnd);
          const displayStart = applyTransform(rawStart, this.xTransformFn);
          const displayEnd = applyTransform(rawEnd, this.xTransformFn);
          const p1 = this.interpolatePosition(parseFloat(String(displayStart)), this.xValues, "x");
          const p2 = this.interpolatePosition(parseFloat(String(displayEnd)), this.xValues, "x");
          if (p1 !== null && p2 !== null) {
            left = Math.min(p1, p2);
            right = Math.max(p1, p2);
          }
        }
        if (layout.hasYRange && this.config.yAxis && this.config.yAxisEnd) {
          const rawStart = getPropertyValue(layout.doc.properties, this.config.yAxis);
          const rawEnd = getPropertyValue(layout.doc.properties, this.config.yAxisEnd);
          const displayStart = applyTransform(rawStart, this.yTransformFn);
          const displayEnd = applyTransform(rawEnd, this.yTransformFn);
          const p1 = this.interpolatePosition(parseFloat(String(displayStart)), this.yValues, "y");
          const p2 = this.interpolatePosition(parseFloat(String(displayEnd)), this.yValues, "y");
          if (p1 !== null && p2 !== null) {
            top = Math.min(p1, p2);
            bottom = Math.max(p1, p2);
          }
        }

        const totalWidth = right - left;
        const totalHeight = bottom - top;

        const stackVertically = layout.hasXRange || !layout.hasYRange;
        const isVertical = layout.hasYRange && !layout.hasXRange;

        let cardRect: Rect;
        if (stackVertically) {
          const laneH = (totalHeight - (layout.totalLanes - 1) * rangeGap) / layout.totalLanes;
          cardRect = {
            x: left,
            y: top + layout.lane * (laneH + rangeGap),
            w: totalWidth,
            h: laneH
          };
        } else {
          const laneW = (totalWidth - (layout.totalLanes - 1) * rangeGap) / layout.totalLanes;
          cardRect = {
            x: left + layout.lane * (laneW + rangeGap),
            y: top,
            w: laneW,
            h: totalHeight
          };
        }

        const style = evaluateCardStyle(layout.doc, this.cardStyleFn);
        const textMaxW = cardRect.w - COLOR_BAR_W - 16;
        const textLines = this.wrapText(layout.doc.name, textMaxW);
        this.cards.push({
          doc: layout.doc,
          rect: cardRect,
          style,
          colorBarColor: style.color || getDocumentColor(layout.doc.name),
          isRange: true,
          isVertical,
          rangeLayout: layout,
          textLines
        });
      }
    }

    // Total dimensions
    this.totalW = originX + Y_HEADER_W + GAP + xCount * (cellW + GAP) + GAP;
    this.totalH = curY + GAP;
  }

  private calculateSingleAxisLayout(): void {
    const axisProperty = this.isYOnly ? this.config.yAxis! : this.config.xAxis!;
    const axisValues = this.isYOnly ? this.yValues : this.xValues;
    const transformFn = this.isYOnly ? this.yTransformFn : this.xTransformFn;
    const isExact = this.isYOnly ? !!this.config.yExact : !!this.config.xExact;

    const rangeEndProp = this.isYOnly ? this.config.yAxisEnd : this.config.xAxisEnd;
    const hasRangeConfig = !!rangeEndProp;
    const rangeDocs = hasRangeConfig
      ? this.result.documents.filter(doc => isRangeDoc(doc, this.config))
      : [];
    const rangeDocPaths = new Set(rangeDocs.map(d => d.path));

    // Assign docs to axis values
    const axisDocs: DocumentData[][] = [];
    for (let i = 0; i < axisValues.length; i++) {
      axisDocs[i] = this.result.documents.filter(doc => {
        if (rangeDocPaths.has(doc.path)) return false;
        const raw = getPropertyValue(doc.properties, axisProperty);
        return Array.isArray(raw)
          ? raw.some(v => matchesCellValue(v, axisValues[i], transformFn, isExact, axisValues))
          : matchesCellValue(raw, axisValues[i], transformFn, isExact, axisValues);
      });
    }

    const originX = GAP;
    const originY = GAP;

    if (this.isYOnly) {
      // Y-only: vertical layout — header left, cell right per row
      const cellW = Math.max(MIN_CELL_W, 180);
      let curY = originY;

      for (let i = 0; i < axisValues.length; i++) {
        const docs = axisDocs[i];
        const rowH = Math.max(60, this.dotClusterHeight(docs.length) + CELL_PAD * 2);

        this.yHeaders.push({
          rect: { x: originX, y: curY, w: Y_HEADER_W, h: rowH },
          label: String(axisValues[i]),
          axis: "y"
        });

        const cx = originX + Y_HEADER_W + GAP;
        const cellRect: Rect = { x: cx, y: curY, w: cellW, h: rowH };
        this.cells.push({
          rect: cellRect,
          xVal: undefined,
          yVal: axisValues[i],
          xIdx: -1,
          yIdx: i
        });

        this.placeDots(docs, cx + cellW / 2, curY + rowH / 2);
        curY += rowH + GAP;
      }

      this.totalW = originX + Y_HEADER_W + GAP + cellW + GAP;
      this.totalH = curY + GAP;

      // Range cards for Y-only
      if (rangeDocs.length > 0) {
        this.addSingleAxisRangeCards(rangeDocs, axisValues, "y");
      }
    } else {
      // X-only: horizontal layout — columns
      const cellW = Math.max(MIN_CELL_W, 160);
      const headerH = 44;
      let curY = originY;

      // X headers
      for (let i = 0; i < axisValues.length; i++) {
        const x = originX + i * (cellW + GAP);
        this.xHeaders.push({
          rect: { x, y: curY, w: cellW, h: headerH },
          label: String(axisValues[i]),
          axis: "x"
        });
      }
      curY += headerH + GAP;

      // Row height based on max dot cluster
      let maxClusterH = 0;
      for (let i = 0; i < axisValues.length; i++) {
        maxClusterH = Math.max(maxClusterH, this.dotClusterHeight(axisDocs[i].length));
      }
      const rowH = Math.max(120, maxClusterH + CELL_PAD * 2);

      for (let i = 0; i < axisValues.length; i++) {
        const cx = originX + i * (cellW + GAP);
        const cellRect: Rect = { x: cx, y: curY, w: cellW, h: rowH };
        this.cells.push({
          rect: cellRect,
          xVal: axisValues[i],
          yVal: undefined,
          xIdx: i,
          yIdx: -1
        });
        this.placeDots(axisDocs[i], cx + cellW / 2, curY + rowH / 2);
      }

      curY += rowH + GAP;
      this.totalW = originX + axisValues.length * (cellW + GAP) + GAP;
      this.totalH = curY + GAP;

      // Range cards for X-only
      if (rangeDocs.length > 0) {
        this.addSingleAxisRangeCards(rangeDocs, axisValues, "x");
      }
    }
  }

  private addSingleAxisRangeCards(rangeDocs: DocumentData[], axisValues: any[], axis: "x" | "y"): void {
    const axisProperty = axis === "x" ? this.config.xAxis! : this.config.yAxis!;
    const axisEndProperty = axis === "x" ? this.config.xAxisEnd! : this.config.yAxisEnd!;
    const transformFn = axis === "x" ? this.xTransformFn : this.yTransformFn;
    const isExact = axis === "x" ? !!this.config.xExact : !!this.config.yExact;

    // Compute layouts
    const layouts: { doc: DocumentData; startIdx: number; endIdx: number; lane: number; totalLanes: number }[] = [];
    for (const doc of rangeDocs) {
      const rawStart = getPropertyValue(doc.properties, axisProperty);
      const rawEnd = getPropertyValue(doc.properties, axisEndProperty);
      let startIdx = findValueIndex(rawStart, axisValues, transformFn, isExact);
      let endIdx = findValueIndex(rawEnd, axisValues, transformFn, isExact);
      if (startIdx < 0 || endIdx < 0) continue;
      if (startIdx > endIdx) [startIdx, endIdx] = [endIdx, startIdx];
      layouts.push({ doc, startIdx, endIdx, lane: -1, totalLanes: 1 });
    }

    // Assign lanes (1D)
    const overlaps = (a: typeof layouts[0], b: typeof layouts[0]): boolean =>
      a.startIdx <= b.endIdx && b.startIdx <= a.endIdx;
    layouts.sort((a, b) => a.startIdx - b.startIdx);
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

    const rangeGap = 2;
    for (const layout of layouts) {
      const startCell = this.cells.find(c => (axis === "x" ? c.xIdx : c.yIdx) === layout.startIdx);
      const endCell = this.cells.find(c => (axis === "x" ? c.xIdx : c.yIdx) === layout.endIdx);
      if (!startCell || !endCell) continue;

      let cardRect: Rect;
      const isVertical = axis === "y";

      // Interpolate exact positions from raw property values
      const rawStart = getPropertyValue(layout.doc.properties, axisProperty);
      const rawEnd = getPropertyValue(layout.doc.properties, axisEndProperty);
      const displayStart = applyTransform(rawStart, transformFn);
      const displayEnd = applyTransform(rawEnd, transformFn);
      const p1 = this.interpolatePosition(parseFloat(String(displayStart)), axisValues, axis);
      const p2 = this.interpolatePosition(parseFloat(String(displayEnd)), axisValues, axis);

      if (axis === "x") {
        const interpLeft = (p1 !== null && p2 !== null) ? Math.min(p1, p2) : startCell.rect.x;
        const interpRight = (p1 !== null && p2 !== null) ? Math.max(p1, p2) : endCell.rect.x + endCell.rect.w;
        const top = startCell.rect.y;
        const cellHeight = startCell.rect.h;
        const laneH = (cellHeight - (layout.totalLanes - 1) * rangeGap) / layout.totalLanes;
        cardRect = {
          x: interpLeft,
          y: top + layout.lane * (laneH + rangeGap),
          w: interpRight - interpLeft,
          h: laneH
        };
      } else {
        const interpTop = (p1 !== null && p2 !== null) ? Math.min(p1, p2) : startCell.rect.y;
        const interpBottom = (p1 !== null && p2 !== null) ? Math.max(p1, p2) : endCell.rect.y + endCell.rect.h;
        const left = startCell.rect.x;
        const cellWidth = startCell.rect.w;
        const laneW = (cellWidth - (layout.totalLanes - 1) * rangeGap) / layout.totalLanes;
        cardRect = {
          x: left + layout.lane * (laneW + rangeGap),
          y: interpTop,
          w: laneW,
          h: interpBottom - interpTop
        };
      }

      const style = evaluateCardStyle(layout.doc, this.cardStyleFn);
      const textMaxW = cardRect.w - COLOR_BAR_W - 16;
      const textLines = this.wrapText(layout.doc.name, textMaxW);
      this.cards.push({
        doc: layout.doc,
        rect: cardRect,
        style,
        colorBarColor: style.color || getDocumentColor(layout.doc.name),
        isRange: true,
        isVertical,
        textLines,
        rangeLayout: {
          doc: layout.doc,
          xStartIdx: axis === "x" ? layout.startIdx : 0,
          xEndIdx: axis === "x" ? layout.endIdx : 0,
          yStartIdx: axis === "y" ? layout.startIdx : 0,
          yEndIdx: axis === "y" ? layout.endIdx : 0,
          hasXRange: axis === "x",
          hasYRange: axis === "y",
          lane: layout.lane,
          totalLanes: layout.totalLanes
        }
      });
    }
  }

  private findCell(xIdx: number, yIdx: number): CellInfo | undefined {
    return this.cells.find(c => c.xIdx === xIdx && c.yIdx === yIdx);
  }

  // ── Canvas Size ──────────────────────────────────────────────────

  private applyCanvasSize(): void {
    const scale = this.zoomLevel / 100;
    const w = this.totalW * scale;
    const h = this.totalH * scale;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.ceil(w * this.dpr);
    this.canvas.height = Math.ceil(h * this.dpr);
  }

  // ── Drawing ──────────────────────────────────────────────────────

  private draw(): void {
    const ctx = this.ctx;
    const scale = (this.zoomLevel / 100) * this.dpr;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    // Clear
    ctx.clearRect(0, 0, this.totalW, this.totalH);

    // Board background
    this.drawRoundRect(0, 0, this.totalW, this.totalH, 8, this.colors.bg);

    // Draw cells
    for (const cell of this.cells) {
      const isDropTarget = this.dragState?.dragging && this.dragState.targetCell === cell;
      const fillColor = isDropTarget ? this.colors.dropHover : this.colors.cellBg;
      const strokeColor = isDropTarget ? this.colors.accent : this.colors.cellBorder;

      this.drawRoundRectStroke(cell.rect.x, cell.rect.y, cell.rect.w, cell.rect.h, CELL_RADIUS, fillColor, strokeColor, isDropTarget ? 2 : 1, true);
    }

    // Draw headers
    for (const h of this.xHeaders) {
      this.drawRoundRect(h.rect.x, h.rect.y, h.rect.w, h.rect.h, HEADER_RADIUS, this.colors.headerXBg);
      ctx.fillStyle = this.colors.accentText;
      ctx.font = `bold 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(h.label, h.rect.x + h.rect.w / 2, h.rect.y + h.rect.h / 2);
    }

    for (const h of this.yHeaders) {
      this.drawRoundRectStroke(h.rect.x, h.rect.y, h.rect.w, h.rect.h, HEADER_RADIUS, this.colors.headerYBg, this.colors.border, 1, false);
      ctx.fillStyle = this.colors.text;
      ctx.font = `bold 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      this.drawTruncatedText(h.label, h.rect.x + h.rect.w - HEADER_PAD, h.rect.y + h.rect.h / 2, h.rect.w - HEADER_PAD * 2);
    }

    // Draw group background circles (multi-dot clusters)
    for (const g of this.dotGroups) {
      this.drawGroupCircle(g.cx, g.cy, g.r);
    }

    // Draw non-range dots
    for (const card of this.cards) {
      if (card.isRange) continue;
      if (this.dragState?.dragging && this.dragState.card === card) continue;
      this.drawDot(card);
    }

    // Draw range cards
    for (const card of this.cards) {
      if (!card.isRange) continue;
      this.drawCard(card);
      if (this.hoveredCard === card && card.rangeLayout) {
        this.drawResizeHandles(card);
      }
    }

    // Draw drag ghost (dot)
    if (this.dragState?.dragging) {
      ctx.save();
      ctx.globalAlpha = 0.6;
      const dx = this.dragState.currentX - this.dragState.startX;
      const dy = this.dragState.currentY - this.dragState.startY;
      const card = this.dragState.card;
      const ghostCard: CardInfo = {
        ...card,
        rect: {
          x: card.rect.x + dx,
          y: card.rect.y + dy,
          w: card.rect.w,
          h: card.rect.h
        }
      };
      this.drawDot(ghostCard);
      ctx.restore();
    }
  }

  private drawCard(card: CardInfo): void {
    const ctx = this.ctx;
    const { x, y, w, h } = card.rect;
    const isHovered = this.hoveredCard === card;

    // Shadow
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.15)";
    ctx.shadowBlur = isHovered ? 12 : 4;
    ctx.shadowOffsetY = isHovered ? 4 : 2;

    // Card background
    const bg = card.style.background || this.colors.cardBg;
    this.drawRoundRect(x, y, w, h, CARD_RADIUS, bg);
    ctx.restore();

    // Border for style
    if (card.style.border) {
      ctx.strokeStyle = card.style.border;
      ctx.lineWidth = 2;
      this.strokeRoundRect(x, y, w, h, CARD_RADIUS);
    }

    // Clip all subsequent drawing to card bounds
    ctx.save();
    this.traceRoundRect(x, y, w, h, CARD_RADIUS);
    ctx.clip();

    // Color bar
    if (card.isVertical) {
      // Top color bar for vertical range cards
      ctx.fillStyle = card.colorBarColor;
      ctx.fillRect(x, y, w, 4);
    } else {
      // Left color bar
      ctx.fillStyle = card.colorBarColor;
      ctx.fillRect(x, y, COLOR_BAR_W, h);
    }

    // Title text (always horizontal, wrapped)
    const textColor = card.style.textColor || this.colors.text;
    ctx.fillStyle = isHovered ? this.colors.accent : textColor;
    ctx.font = CARD_FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    const textX = x + COLOR_BAR_W + 8;
    const textMaxW = w - COLOR_BAR_W - 16;
    const textY = y + CARD_PAD_V + (card.isVertical ? 4 : 0);
    const lines = card.textLines;
    for (let i = 0; i < lines.length; i++) {
      this.drawTruncatedText(lines[i], textX, textY + i * LINE_HEIGHT, textMaxW);
    }

    ctx.restore(); // Remove clip
  }

  private drawResizeHandles(card: CardInfo): void {
    const ctx = this.ctx;
    const rl = card.rangeLayout!;

    ctx.fillStyle = this.colors.accent;
    ctx.globalAlpha = 0.6;

    if (rl.hasXRange && !this.config.xReadonly) {
      // Left handle
      this.drawRoundRectPartial(card.rect.x, card.rect.y, HANDLE_SIZE, card.rect.h, CARD_RADIUS, true, false, false, true);
      // Right handle
      this.drawRoundRectPartial(card.rect.x + card.rect.w - HANDLE_SIZE, card.rect.y, HANDLE_SIZE, card.rect.h, CARD_RADIUS, false, true, true, false);
    }
    if (rl.hasYRange && !this.config.yReadonly) {
      // Top handle
      this.drawRoundRectPartial(card.rect.x, card.rect.y, card.rect.w, HANDLE_SIZE, CARD_RADIUS, true, true, false, false);
      // Bottom handle
      this.drawRoundRectPartial(card.rect.x, card.rect.y + card.rect.h - HANDLE_SIZE, card.rect.w, HANDLE_SIZE, CARD_RADIUS, false, false, true, true);
    }

    ctx.globalAlpha = 1;
  }

  // ── Dot Mode Helpers ─────────────────────────────────────────────

  /** Returns {dx,dy} offsets from center for n dots arranged in a compact grid. */
  private arrangeDots(n: number): { dx: number; dy: number }[] {
    if (n === 1) return [{ dx: 0, dy: 0 }];
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const offsets: { dx: number; dy: number }[] = [];
    for (let i = 0; i < n; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const rowDotCount = row === rows - 1 ? n - row * cols : cols;
      const rowShift = ((cols - rowDotCount) / 2) * DOT_SPACING;
      const dx = (col - (cols - 1) / 2) * DOT_SPACING + (row === rows - 1 ? rowShift : 0);
      const dy = (row - (rows - 1) / 2) * DOT_SPACING;
      offsets.push({ dx, dy });
    }
    return offsets;
  }

  /** Radius of the group background circle for n dots. */
  private computeGroupRadius(n: number): number {
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const halfW = ((cols - 1) / 2) * DOT_SPACING + DOT_RADIUS;
    const halfH = ((rows - 1) / 2) * DOT_SPACING + DOT_RADIUS;
    return Math.sqrt(halfW * halfW + halfH * halfH) + GROUP_BG_PAD;
  }

  /** Pixel height needed for a cluster of n dots. */
  private dotClusterHeight(n: number): number {
    if (n <= 1) return DOT_RADIUS * 2;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    return DOT_RADIUS * 2 + (rows - 1) * DOT_SPACING;
  }

  /** Creates CardInfos for point docs, centered at (cx, cy). Registers group if n > 1. */
  private placeDots(docs: DocumentData[], cx: number, cy: number): void {
    if (docs.length === 0) return;
    const offsets = this.arrangeDots(docs.length);
    for (let i = 0; i < docs.length; i++) {
      const dotCX = cx + offsets[i].dx;
      const dotCY = cy + offsets[i].dy;
      const style = evaluateCardStyle(docs[i], this.cardStyleFn);
      this.cards.push({
        doc: docs[i],
        rect: { x: dotCX - DOT_RADIUS, y: dotCY - DOT_RADIUS, w: DOT_RADIUS * 2, h: DOT_RADIUS * 2 },
        style,
        colorBarColor: style.color || getDocumentColor(docs[i].name),
        isRange: false,
        isVertical: false,
        textLines: []
      });
    }
    if (docs.length > 1) {
      this.dotGroups.push({ cx, cy, r: this.computeGroupRadius(docs.length) });
    }
  }

  private drawDot(card: CardInfo): void {
    const ctx = this.ctx;
    const cx = card.rect.x + DOT_RADIUS;
    const cy = card.rect.y + DOT_RADIUS;
    const isHovered = this.hoveredCard === card;

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.2)";
    ctx.shadowBlur = isHovered ? 14 : 5;
    ctx.shadowOffsetY = isHovered ? 3 : 2;

    ctx.beginPath();
    ctx.arc(cx, cy, DOT_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = card.style.background || card.colorBarColor;
    ctx.fill();
    ctx.restore();

    // Border / hover ring (no shadow)
    ctx.beginPath();
    ctx.arc(cx, cy, DOT_RADIUS, 0, Math.PI * 2);
    if (isHovered) {
      ctx.strokeStyle = this.colors.accent;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    } else if (card.style.border) {
      ctx.strokeStyle = card.style.border;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  private drawGroupCircle(cx: number, cy: number, r: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = GROUP_BG_ALPHA;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = this.colors.accent;
    ctx.fill();
    ctx.restore();
  }

  private pointInDot(px: number, py: number, card: CardInfo): boolean {
    const cx = card.rect.x + DOT_RADIUS;
    const cy = card.rect.y + DOT_RADIUS;
    const dx = px - cx;
    const dy = py - cy;
    const hitR = DOT_RADIUS + 3;
    return dx * dx + dy * dy <= hitR * hitR;
  }

  // ── Drawing Helpers ──────────────────────────────────────────────

  private traceRoundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  private drawRoundRect(x: number, y: number, w: number, h: number, r: number, fillColor: string): void {
    this.traceRoundRect(x, y, w, h, r);
    this.ctx.fillStyle = fillColor;
    this.ctx.fill();
  }

  private strokeRoundRect(x: number, y: number, w: number, h: number, r: number): void {
    this.traceRoundRect(x, y, w, h, r);
    this.ctx.stroke();
  }

  private drawRoundRectStroke(
    x: number, y: number, w: number, h: number, r: number,
    fillColor: string, strokeColor: string, lineWidth: number, dashed: boolean
  ): void {
    this.traceRoundRect(x, y, w, h, r);
    const ctx = this.ctx;
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;
    if (dashed) ctx.setLineDash([4, 4]);
    ctx.stroke();
    if (dashed) ctx.setLineDash([]);
  }

  private drawRoundRectPartial(
    x: number, y: number, w: number, h: number, r: number,
    tl: boolean, tr: boolean, br: boolean, bl: boolean
  ): void {
    const ctx = this.ctx;
    const rtl = tl ? r : 0;
    const rtr = tr ? r : 0;
    const rbr = br ? r : 0;
    const rbl = bl ? r : 0;
    ctx.beginPath();
    ctx.moveTo(x + rtl, y);
    ctx.lineTo(x + w - rtr, y);
    if (rtr) ctx.arcTo(x + w, y, x + w, y + rtr, rtr);
    else ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h - rbr);
    if (rbr) ctx.arcTo(x + w, y + h, x + w - rbr, y + h, rbr);
    else ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + rbl, y + h);
    if (rbl) ctx.arcTo(x, y + h, x, y + h - rbl, rbl);
    else ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + rtl);
    if (rtl) ctx.arcTo(x, y, x + rtl, y, rtl);
    else ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fill();
  }

  private drawTruncatedText(text: string, x: number, y: number, maxWidth: number): void {
    const ctx = this.ctx;
    if (maxWidth <= 0) return;
    if (ctx.measureText(text).width <= maxWidth) {
      ctx.fillText(text, x, y);
      return;
    }
    const ellipsis = "\u2026";
    let truncated = text;
    while (truncated.length > 0 && ctx.measureText(truncated + ellipsis).width > maxWidth) {
      truncated = truncated.slice(0, -1);
    }
    ctx.fillText(truncated + ellipsis, x, y);
  }

  // ── Hit Testing ──────────────────────────────────────────────────

  private canvasToLayout(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const scale = this.zoomLevel / 100;
    return {
      x: (clientX - rect.left) / scale,
      y: (clientY - rect.top) / scale
    };
  }

  private hitTest(lx: number, ly: number): HitRegion | null {
    // Check handles first (highest priority)
    for (const card of this.cards) {
      if (!card.isRange || !card.rangeLayout) continue;
      const rl = card.rangeLayout;
      const r = card.rect;

      if (rl.hasXRange && !this.config.xReadonly) {
        // Left handle
        if (lx >= r.x && lx <= r.x + HANDLE_SIZE && ly >= r.y && ly <= r.y + r.h) {
          return { type: "handle", edge: "start", axis: "x", card };
        }
        // Right handle
        if (lx >= r.x + r.w - HANDLE_SIZE && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h) {
          return { type: "handle", edge: "end", axis: "x", card };
        }
      }
      if (rl.hasYRange && !this.config.yReadonly) {
        // Top handle
        if (lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + HANDLE_SIZE) {
          return { type: "handle", edge: "start", axis: "y", card };
        }
        // Bottom handle
        if (lx >= r.x && lx <= r.x + r.w && ly >= r.y + r.h - HANDLE_SIZE && ly <= r.y + r.h) {
          return { type: "handle", edge: "end", axis: "y", card };
        }
      }
    }

    // Check cards (reverse order for z-order — range cards drawn last)
    for (let i = this.cards.length - 1; i >= 0; i--) {
      const card = this.cards[i];
      const hit = card.isRange
        ? this.pointInRect(lx, ly, card.rect)
        : this.pointInDot(lx, ly, card);
      if (hit) {
        return { type: "card", card };
      }
    }

    // Check cells
    for (const cell of this.cells) {
      if (this.pointInRect(lx, ly, cell.rect)) {
        return { type: "cell", cell };
      }
    }

    return null;
  }

  private pointInRect(x: number, y: number, rect: Rect): boolean {
    return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
  }

  private findCellAt(lx: number, ly: number): CellInfo | null {
    for (const cell of this.cells) {
      if (this.pointInRect(lx, ly, cell.rect)) return cell;
    }
    return null;
  }

  // ── Event Listeners ──────────────────────────────────────────────

  private setupEventListeners(): void {
    this.canvas.addEventListener("mousedown", this.onMouseDown);
    this.canvas.addEventListener("mousemove", this.onMouseMove);
    this.canvas.addEventListener("mouseup", this.onMouseUp);
    this.canvas.addEventListener("mouseleave", this.onMouseLeave);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
  }

  private onMouseDown = (e: MouseEvent): void => {
    const pos = this.canvasToLayout(e.clientX, e.clientY);
    const hit = this.hitTest(pos.x, pos.y);

    if (!hit) return;

    if (hit.type === "handle") {
      e.preventDefault();
      this.resizeState = {
        card: hit.card,
        edge: hit.edge,
        axis: hit.axis,
        mousePos: hit.axis === "x" ? e.clientX : e.clientY
      };
      // Move listeners to document for resize
      document.addEventListener("mousemove", this.onResizeMove);
      document.addEventListener("mouseup", this.onResizeUp);
      return;
    }

    if (hit.type === "card") {
      const card = hit.card;
      // Check if draggable
      const hasX = !!this.config.xAxis;
      const hasY = !!this.config.yAxis;
      const fullyReadonly = (hasX && hasY)
        ? (!!this.config.xReadonly && !!this.config.yReadonly)
        : hasX ? !!this.config.xReadonly : !!this.config.yReadonly;

      if (!fullyReadonly && !card.isRange) {
        this.dragState = {
          card,
          startX: pos.x,
          startY: pos.y,
          currentX: pos.x,
          currentY: pos.y,
          dragging: false,
          targetCell: null
        };
      }
    }
  };

  private onMouseMove = (e: MouseEvent): void => {
    const pos = this.canvasToLayout(e.clientX, e.clientY);

    // Handle drag
    if (this.dragState) {
      this.dragState.currentX = pos.x;
      this.dragState.currentY = pos.y;

      if (!this.dragState.dragging) {
        const dx = pos.x - this.dragState.startX;
        const dy = pos.y - this.dragState.startY;
        if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
          this.dragState.dragging = true;
        }
      }

      if (this.dragState.dragging) {
        // Find target cell under cursor
        const targetCell = this.findCellAt(pos.x, pos.y);

        // Check if cell is reachable (respect readonly)
        if (targetCell) {
          const doc = this.dragState.card.doc;
          const docX = this.config.xAxis ? getPropertyValue(doc.properties, this.config.xAxis) : undefined;
          const docY = this.config.yAxis ? getPropertyValue(doc.properties, this.config.yAxis) : undefined;
          const docXStr = docX !== undefined ? String(applyTransform(docX, this.xTransformFn)) : undefined;
          const docYStr = docY !== undefined ? String(applyTransform(docY, this.yTransformFn)) : undefined;

          const xAllowed = !this.config.xReadonly || (targetCell.xVal !== undefined && String(targetCell.xVal) === docXStr);
          const yAllowed = !this.config.yReadonly || (targetCell.yVal !== undefined && String(targetCell.yVal) === docYStr);

          this.dragState.targetCell = (xAllowed && yAllowed) ? targetCell : null;
        } else {
          this.dragState.targetCell = null;
        }

        this.draw();
      }
      return;
    }

    // Hover
    const hit = this.hitTest(pos.x, pos.y);
    let newHovered: CardInfo | null = null;

    if (hit?.type === "card") {
      newHovered = hit.card;
      this.canvas.style.cursor = hit.card.isRange ? "pointer" : "grab";
    } else if (hit?.type === "handle") {
      newHovered = hit.card;
      this.canvas.style.cursor = hit.axis === "x" ? "col-resize" : "row-resize";
    } else {
      this.canvas.style.cursor = "default";
    }

    if (newHovered !== this.hoveredCard) {
      this.hoveredCard = newHovered;
      this.draw();

      // Preview
      if (newHovered) {
        this.schedulePreview(newHovered.doc, e);
      } else {
        this.hidePreview();
      }
    } else if (this.previewEl && newHovered) {
      this.positionPreview(e);
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (this.dragState) {
      if (this.dragState.dragging && this.dragState.targetCell) {
        this.executeDrop(this.dragState.card.doc, this.dragState.targetCell);
      } else if (!this.dragState.dragging) {
        // It was a click, not a drag
        this.app.workspace.openLinkText(this.dragState.card.doc.path, "");
      }
      this.dragState = null;
      this.draw();
      return;
    }

    // Handle click on card (no drag state = range card or readonly)
    const pos = this.canvasToLayout(e.clientX, e.clientY);
    const hit = this.hitTest(pos.x, pos.y);
    if (hit?.type === "card") {
      this.app.workspace.openLinkText(hit.card.doc.path, "");
    }
  };

  private onMouseLeave = (): void => {
    if (this.dragState) {
      this.dragState = null;
      this.draw();
    }
    this.hoveredCard = null;
    this.hidePreview();
    this.draw();
  };

  private onWheel = (e: WheelEvent): void => {
    if (e.ctrlKey) {
      e.preventDefault();
      if (e.deltaY < 0 && this.zoomLevel < ZOOM_MAX) {
        this.zoomLevel += ZOOM_STEP;
      } else if (e.deltaY > 0 && this.zoomLevel > ZOOM_MIN) {
        this.zoomLevel -= ZOOM_STEP;
      }
      this.applyCanvasSize();
      this.draw();
      this.updateZoomDisplay();
    }
  };

  // ── Resize Handlers ──────────────────────────────────────────────

  private onResizeMove = (e: MouseEvent): void => {
    if (!this.resizeState) return;
    this.resizeState.mousePos = this.resizeState.axis === "x" ? e.clientX : e.clientY;

    // Visual feedback: update card rect temporarily
    const pos = this.canvasToLayout(e.clientX, e.clientY);
    const closestIdx = this.findClosestCellByPos(pos.x, pos.y, this.resizeState.axis);
    if (closestIdx >= 0) {
      const card = this.resizeState.card;
      const axis = this.resizeState.axis;
      const edge = this.resizeState.edge;
      const targetCell = this.cells.find(c => (axis === "x" ? c.xIdx : c.yIdx) === closestIdx);
      if (targetCell) {
        if (axis === "x") {
          if (edge === "start") {
            const right = card.rect.x + card.rect.w;
            card.rect.x = targetCell.rect.x;
            card.rect.w = right - card.rect.x;
          } else {
            card.rect.w = targetCell.rect.x + targetCell.rect.w - card.rect.x;
          }
        } else {
          if (edge === "start") {
            const bottom = card.rect.y + card.rect.h;
            card.rect.y = targetCell.rect.y;
            card.rect.h = bottom - card.rect.y;
          } else {
            card.rect.h = targetCell.rect.y + targetCell.rect.h - card.rect.y;
          }
        }
        this.draw();
      }
    }
  };

  private onResizeUp = async (e: MouseEvent): Promise<void> => {
    document.removeEventListener("mousemove", this.onResizeMove);
    document.removeEventListener("mouseup", this.onResizeUp);

    if (!this.resizeState) return;

    const pos = this.canvasToLayout(e.clientX, e.clientY);
    const axis = this.resizeState.axis;
    const edge = this.resizeState.edge;
    const closestIdx = this.findClosestCellByPos(pos.x, pos.y, axis);

    if (closestIdx >= 0) {
      const allValues = axis === "x" ? this.xValues : this.yValues;
      if (closestIdx < allValues.length) {
        const newValue = allValues[closestIdx];
        const property = edge === "start"
          ? (axis === "x" ? this.config.xAxis! : this.config.yAxis!)
          : (axis === "x" ? this.config.xAxisEnd! : this.config.yAxisEnd!);

        try {
          const writeValue = await this.resolveDropValue(
            newValue,
            axis === "x" ? this.xTransformFn : this.yTransformFn,
            axis === "x" ? this.xReverseMap : this.yReverseMap,
            property
          );
          if (writeValue !== null) {
            await this.updater.updateProperties(this.resizeState.card.doc.file, { [property]: writeValue });
            this.refreshOnCacheUpdate(this.resizeState.card.doc.file);
          }
        } catch (error) {
          console.error("Hermione: Failed to update range:", error);
        }
      }
    }

    this.resizeState = null;
  };

  private findClosestCellByPos(lx: number, ly: number, axis: "x" | "y"): number {
    let bestIdx = -1;
    let bestDist = Infinity;
    const uniqueIndices = new Set<number>();
    for (const cell of this.cells) {
      const idx = axis === "x" ? cell.xIdx : cell.yIdx;
      if (idx < 0 || uniqueIndices.has(idx)) continue;
      uniqueIndices.add(idx);
      const mid = axis === "x"
        ? cell.rect.x + cell.rect.w / 2
        : cell.rect.y + cell.rect.h / 2;
      const mousePos = axis === "x" ? lx : ly;
      const dist = Math.abs(mousePos - mid);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = idx;
      }
    }
    return bestIdx;
  }

  // ── Drop Logic ───────────────────────────────────────────────────

  private async executeDrop(doc: DocumentData, cell: CellInfo): Promise<void> {
    try {
      const updates: Record<string, any> = {};

      if (this.config.xAxis && cell.xVal !== undefined && !this.config.xReadonly) {
        if (this.config.xExact) {
          const exactVal = await this.promptExactValue(this.config.xAxis, cell.xVal, this.xValues);
          if (exactVal === null) return;
          updates[this.config.xAxis] = exactVal;
        } else {
          const xWriteValue = await this.resolveDropValue(
            cell.xVal, this.xTransformFn, this.xReverseMap, this.config.xAxis
          );
          if (xWriteValue === null) return;
          updates[this.config.xAxis] = xWriteValue;
        }
      }

      if (this.config.yAxis && cell.yVal !== undefined && !this.config.yReadonly) {
        if (this.config.yExact) {
          const exactVal = await this.promptExactValue(this.config.yAxis!, cell.yVal, this.yValues);
          if (exactVal === null) return;
          updates[this.config.yAxis!] = exactVal;
        } else {
          const yWriteValue = await this.resolveDropValue(
            cell.yVal, this.yTransformFn, this.yReverseMap, this.config.yAxis!
          );
          if (yWriteValue === null) return;
          updates[this.config.yAxis!] = yWriteValue;
        }
      }

      if (Object.keys(updates).length === 0) return;

      await this.updater.updateProperties(doc.file, updates);
      this.refreshOnCacheUpdate(doc.file);
    } catch (error) {
      console.error("Failed to update document position:", error);
    }
  }

  private resolveDropValue(
    cellDisplayValue: any,
    transformFn: ((v: any) => any) | null,
    reverseMap: Map<string, any[]> | null,
    axisName: string
  ): Promise<any> {
    return new Promise((resolve) => {
      if (!transformFn) {
        resolve(cellDisplayValue);
        return;
      }
      const candidates = reverseMap?.get(String(cellDisplayValue)) || [];
      const modal = new ValuePickerModal(
        this.app, axisName, String(cellDisplayValue), candidates, transformFn,
        (chosenValue) => resolve(chosenValue)
      );
      modal.open();
    });
  }

  private promptExactValue(axisName: string, cellValue: any, allCellValues: any[]): Promise<number | null> {
    return new Promise((resolve) => {
      const [rangeMin, rangeMax] = getCellRange(cellValue, allCellValues);
      const modal = new ExactValueModal(
        this.app, axisName, parseFloat(String(cellValue)), rangeMin, rangeMax,
        (value) => resolve(value)
      );
      modal.open();
    });
  }

  private refreshOnCacheUpdate(file: TFile): void {
    const maxWait = 2000;
    const handler = (changedFile: TFile) => {
      if (changedFile.path === file.path) {
        cleanup();
        this.onRefresh();
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      this.onRefresh();
    }, maxWait);
    const cleanup = () => {
      this.app.metadataCache.off("changed", handler);
      clearTimeout(timeout);
    };
    this.app.metadataCache.on("changed", handler);
  }

  // ── Preview ──────────────────────────────────────────────────────

  private schedulePreview(doc: DocumentData, event: MouseEvent): void {
    this.hidePreview();
    this.previewTimeout = setTimeout(async () => {
      await this.showPreview(doc, event);
    }, 300);
  }

  private async showPreview(doc: DocumentData, event: MouseEvent): Promise<void> {
    this.hidePreview();
    this.previewEl = document.body.createDiv({ cls: "hermione-preview" });

    const header = this.previewEl.createDiv({ cls: "hermione-preview-header" });
    header.createSpan({ text: doc.name, cls: "hermione-preview-title" });

    const content = this.previewEl.createDiv({ cls: "hermione-preview-content" });
    const mode = this.config.preview || "document";

    switch (mode) {
      case "axes":
        this.showPreviewAxes(content, doc);
        break;
      case "properties":
        this.showPreviewProperties(content, doc);
        break;
      default:
        await this.showPreviewDocument(content, doc);
        break;
    }

    this.positionPreview(event);
  }

  private async showPreviewDocument(content: HTMLElement, doc: DocumentData): Promise<void> {
    try {
      const fileContent = await this.app.vault.read(doc.file);
      const contentWithoutFrontmatter = fileContent.replace(/^---[\s\S]*?---\n?/, "");
      const previewContent = contentWithoutFrontmatter.slice(0, 1000);
      const truncated = contentWithoutFrontmatter.length > 1000;
      await MarkdownRenderer.render(
        this.app, previewContent + (truncated ? "\n\n*...*" : ""), content, doc.path, new Component()
      );
    } catch {
      content.createSpan({ text: t().renderer.previewUnavailable, cls: "hermione-preview-error" });
    }
  }

  private showPreviewAxes(content: HTMLElement, doc: DocumentData): void {
    const list = content.createDiv({ cls: "hermione-preview-props" });
    if (this.config.xAxis) {
      const label = this.config.xLabel || this.config.xAxis;
      const value = getPropertyValue(doc.properties, this.config.xAxis);
      this.renderPreviewProp(list, label, value);
    }
    if (this.config.yAxis) {
      const label = this.config.yLabel || this.config.yAxis;
      const value = getPropertyValue(doc.properties, this.config.yAxis);
      this.renderPreviewProp(list, label, value);
    }
  }

  private showPreviewProperties(content: HTMLElement, doc: DocumentData): void {
    const list = content.createDiv({ cls: "hermione-preview-props" });
    const skipKeys = new Set(["position", "file.name", "file.path", "file.ctime", "file.mtime", "file.size", "file.tags"]);
    for (const [key, value] of Object.entries(doc.properties)) {
      if (skipKeys.has(key) || key.startsWith("file.")) continue;
      if (typeof value === "object" && value !== null && !Array.isArray(value) && "start" in value && "end" in value) continue;
      this.renderPreviewProp(list, key, value);
    }
  }

  private renderPreviewProp(container: HTMLElement, key: string, value: any): void {
    const row = container.createDiv({ cls: "hermione-preview-prop" });
    row.createSpan({ cls: "hermione-preview-prop-key", text: key });
    row.createSpan({ cls: "hermione-preview-prop-value", text: formatDisplayValue(value) });
  }

  private positionPreview(event: MouseEvent): void {
    if (!this.previewEl) return;
    const padding = 15;
    const maxWidth = 400;
    const maxHeight = 300;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = event.clientX + padding;
    let top = event.clientY + padding;
    if (left + maxWidth > vw) left = event.clientX - maxWidth - padding;
    if (top + maxHeight > vh) top = event.clientY - maxHeight - padding;
    left = Math.max(padding, left);
    top = Math.max(padding, top);

    this.previewEl.style.left = `${left}px`;
    this.previewEl.style.top = `${top}px`;
  }

  private hidePreview(): void {
    if (this.previewTimeout) {
      clearTimeout(this.previewTimeout);
      this.previewTimeout = null;
    }
    if (this.previewEl) {
      this.previewEl.remove();
      this.previewEl = null;
    }
  }

  // ── Unassigned Documents ─────────────────────────────────────────

  private renderUnassigned(): void {
    if (this.config.hideUnassigned) return;

    const hasX = this.config.xAxis && this.xValues.length > 0;
    const hasY = this.config.yAxis && this.yValues.length > 0;

    const unassigned = this.result.documents.filter(doc => {
      if (hasX) {
        const rawX = getPropertyValue(doc.properties, this.config.xAxis!);
        if (rawX === undefined || rawX === null || rawX === "") return true;
        const xMatches = this.xValues.some(xVal =>
          Array.isArray(rawX)
            ? rawX.some(v => matchesCellValue(v, xVal, this.xTransformFn, !!this.config.xExact, this.xValues))
            : matchesCellValue(rawX, xVal, this.xTransformFn, !!this.config.xExact, this.xValues)
        );
        if (!xMatches) return true;
      }
      if (hasY) {
        const rawY = getPropertyValue(doc.properties, this.config.yAxis!);
        if (rawY === undefined || rawY === null || rawY === "") return true;
        const yMatches = this.yValues.some(yVal =>
          Array.isArray(rawY)
            ? rawY.some(v => matchesCellValue(v, yVal, this.yTransformFn, !!this.config.yExact, this.yValues))
            : matchesCellValue(rawY, yVal, this.yTransformFn, !!this.config.yExact, this.yValues)
        );
        if (!yMatches) return true;
      }
      return false;
    });

    if (unassigned.length === 0) return;

    const section = this.containerEl.createDiv({ cls: "hermione-unassigned" });
    section.createEl("strong", { text: t().renderer.unassigned });
    const items = section.createDiv({ cls: "hermione-unassigned-items" });

    for (const doc of unassigned) {
      const card = items.createDiv({ cls: "hermione-card" });
      const style = evaluateCardStyle(doc, this.cardStyleFn);
      const colorBar = card.createDiv({ cls: "hermione-card-color" });
      colorBar.style.backgroundColor = style.color || getDocumentColor(doc.name);
      if (style.background) card.style.backgroundColor = style.background;
      const content = card.createDiv({ cls: "hermione-card-content" });
      const titleSpan = content.createSpan({ cls: "hermione-card-title", text: doc.name });
      if (style.textColor) titleSpan.style.color = style.textColor;
      card.addEventListener("click", () => this.app.workspace.openLinkText(doc.path, ""));
      card.style.cursor = "pointer";
    }
  }

  // ── Toolbar ──────────────────────────────────────────────────────

  private renderToolbar(): void {
    const toolbar = this.containerEl.createDiv({ cls: "hermione-toolbar" });

    // Zoom controls
    const zoomControls = toolbar.createDiv({ cls: "hermione-zoom-controls" });

    const zoomOutBtn = zoomControls.createEl("button", { cls: "hermione-zoom-btn" });
    setIcon(zoomOutBtn, "minus");
    zoomOutBtn.title = t().renderer.zoomOut;
    zoomOutBtn.addEventListener("click", () => {
      if (this.zoomLevel > ZOOM_MIN) {
        this.zoomLevel -= ZOOM_STEP;
        this.applyCanvasSize();
        this.draw();
        this.updateZoomDisplay();
      }
    });

    this.zoomDisplay = zoomControls.createEl("button", {
      cls: "hermione-zoom-display",
      text: `${this.zoomLevel}%`
    });
    this.zoomDisplay.title = t().renderer.zoomReset;
    this.zoomDisplay.addEventListener("click", () => {
      this.zoomLevel = 100;
      this.applyCanvasSize();
      this.draw();
      this.updateZoomDisplay();
    });

    const zoomInBtn = zoomControls.createEl("button", { cls: "hermione-zoom-btn" });
    setIcon(zoomInBtn, "plus");
    zoomInBtn.title = t().renderer.zoomIn;
    zoomInBtn.addEventListener("click", () => {
      if (this.zoomLevel < ZOOM_MAX) {
        this.zoomLevel += ZOOM_STEP;
        this.applyCanvasSize();
        this.draw();
        this.updateZoomDisplay();
      }
    });

    const slider = zoomControls.createEl("input", { cls: "hermione-zoom-slider", type: "range" });
    slider.min = String(ZOOM_MIN);
    slider.max = String(ZOOM_MAX);
    slider.step = String(ZOOM_STEP);
    slider.value = String(this.zoomLevel);
    slider.title = t().renderer.zoomSlider;
    slider.addEventListener("input", (e) => {
      this.zoomLevel = parseInt((e.target as HTMLInputElement).value);
      this.applyCanvasSize();
      this.draw();
      this.updateZoomDisplay();
    });

    // Refresh button
    const refreshBtn = toolbar.createEl("button", { cls: "hermione-refresh-btn", text: t().renderer.refreshBtn });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", () => this.onRefresh());
  }

  private updateZoomDisplay(): void {
    if (this.zoomDisplay) this.zoomDisplay.textContent = `${this.zoomLevel}%`;
    const slider = this.containerEl.querySelector(".hermione-zoom-slider") as HTMLInputElement;
    if (slider) slider.value = String(this.zoomLevel);
  }
}
