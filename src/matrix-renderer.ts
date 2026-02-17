import { App, TFile, MarkdownRenderChild, setIcon, MarkdownRenderer, Component } from "obsidian";
import { HermioneConfig, DocumentData, QueryResult } from "./types";
import { FrontmatterUpdater } from "./frontmatter-updater";
import { compileTransform, applyTransform, buildReverseMap } from "./value-transform";
import { ValuePickerModal } from "./value-picker-modal";
import { ExactValueModal } from "./exact-value-modal";

/**
 * Renders the query results as an editable matrix/table with draggable dots
 */
export class MatrixRenderer extends MarkdownRenderChild {
  private updater: FrontmatterUpdater;
  private previewEl: HTMLElement | null = null;
  private previewTimeout: NodeJS.Timeout | null = null;
  private currentDragDoc: DocumentData | null = null;
  private zoomLevel: number = 100;
  private boardEl: HTMLElement | null = null;
  private zoomDisplay: HTMLElement | null = null;
  private resizeState: {
    doc: DocumentData;
    edge: "start" | "end";
    axis: "x" | "y";
    cardEl: HTMLElement;
    allValues: any[];
    cellPositions: { value: any; start: number; end: number }[];
    boardRect: DOMRect;
    scale: number;
  } | null = null;

  // Transform support
  private xTransformFn: ((v: any) => any) | null = null;
  private yTransformFn: ((v: any) => any) | null = null;
  private xReverseMap: Map<string, any[]> | null = null;
  private yReverseMap: Map<string, any[]> | null = null;

  // Card style function
  private cardStyleFn: ((props: Record<string, any>) => any) | null = null;

  // Zoom settings
  private static readonly ZOOM_MIN = 50;
  private static readonly ZOOM_MAX = 150;
  private static readonly ZOOM_STEP = 10;

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
    // Compile transforms if configured
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

    // Compile card style function
    if (this.config.cardStyle) {
      this.cardStyleFn = compileTransform(this.config.cardStyle);
    }

    this.render();
  }

  onunload(): void {
    this.hidePreview();
  }

  /**
   * Main render method
   */
  render(): void {
    this.containerEl.empty();
    this.containerEl.addClass("hermione-container");

    // Apply theme class if configured
    if (this.config.theme) {
      this.containerEl.addClass(`hermione-theme-${this.config.theme}`);
    }

    // Apply row height mode
    if (this.config.rowHeight === "flexible") {
      this.containerEl.addClass("hermione-rows-flexible");
    }

    // Render title if configured
    if (this.config.title) {
      this.containerEl.createEl("h3", {
        cls: "hermione-title",
        text: this.config.title
      });
    }

    // Show errors if any
    if (this.result.errors.length > 0) {
      this.renderErrors();
      return;
    }

    // Show empty state
    if (this.result.documents.length === 0) {
      this.renderEmptyState();
      return;
    }

    // Render based on axes specified
    if (this.config.xAxis && this.config.yAxis) {
      this.renderMatrix();
    } else {
      this.renderSingleAxisBoard();
    }
  }

  /**
   * Render error messages
   */
  private renderErrors(): void {
    const errorContainer = this.containerEl.createDiv({ cls: "hermione-errors" });
    for (const error of this.result.errors) {
      errorContainer.createDiv({ cls: "hermione-error", text: error });
    }
  }

  /**
   * Render empty state message
   */
  private renderEmptyState(): void {
    this.containerEl.createDiv({
      cls: "hermione-empty",
      text: "Keine Dokumente gefunden."
    });
  }

  /**
   * Render a simple table (X-axis only)
   */
  private renderTable(): void {
    const table = this.containerEl.createEl("table", { cls: "hermione-table" });

    // Header row
    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");

    // Document name column
    headerRow.createEl("th", { text: "Dokument" });

    // X-axis column
    headerRow.createEl("th", { text: this.config.xAxis! });

    // Additional display columns
    if (this.config.display) {
      for (const prop of this.config.display) {
        headerRow.createEl("th", { text: prop });
      }
    }

    // Body
    const tbody = table.createEl("tbody");

    for (const doc of this.result.documents) {
      const row = tbody.createEl("tr");

      // Document name (clickable link)
      const nameCell = row.createEl("td", { cls: "hermione-cell-name" });
      const link = nameCell.createEl("a", {
        cls: "internal-link",
        text: doc.name
      });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        this.app.workspace.openLinkText(doc.path, "");
      });

      // X-axis value (editable)
      const xValue = this.getPropertyValue(doc.properties, this.config.xAxis!);
      const xCell = row.createEl("td", { cls: "hermione-cell-editable" });
      this.renderEditableCell(xCell, doc, this.config.xAxis!, xValue);

      // Additional display columns (editable)
      if (this.config.display) {
        for (const prop of this.config.display) {
          const value = this.getPropertyValue(doc.properties, prop);
          const cell = row.createEl("td", { cls: "hermione-cell-editable" });
          this.renderEditableCell(cell, doc, prop, value);
        }
      }
    }

    // Refresh button
    this.renderRefreshButton();
  }

  /**
   * Render a matrix view (X and Y axes) as a visual board with draggable cards
   */
  private renderMatrix(): void {
    // Use predefined values if specified, otherwise use values from documents
    const xValues = this.config.xValues
      ? this.config.xValues
      : Array.from(this.result.xAxisValues).sort();

    const yValues = this.config.yValues
      ? this.config.yValues
      : Array.from(this.result.yAxisValues).sort();

    // Create layout wrapper for optional Y-axis label
    const boardLayout = this.containerEl.createDiv({ cls: "hermione-board-layout" });

    // Y-axis label (rotated, left side)
    if (this.config.yLabel) {
      const yLabelEl = boardLayout.createDiv({ cls: "hermione-axis-label-y" });
      yLabelEl.createSpan({ text: this.config.yLabel });
    }

    // Create zoom wrapper for scrollable/zoomable content
    const zoomWrapper = boardLayout.createDiv({ cls: "hermione-zoom-wrapper" });

    // Mouse wheel zoom on the board area
    zoomWrapper.addEventListener("wheel", (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        if (e.deltaY < 0) {
          this.zoomIn();
        } else {
          this.zoomOut();
        }
      }
    }, { passive: false });

    // Create board container
    const board = zoomWrapper.createDiv({ cls: "hermione-board" });
    this.boardEl = board;

    // Set grid template columns based on number of X values (+ 1 for Y labels)
    board.style.gridTemplateColumns = `auto repeat(${xValues.length}, 1fr)`;

    // Apply initial zoom
    this.applyZoom();

    // Create corner cell (empty)
    const corner = board.createDiv({ cls: "hermione-board-corner" });

    // Create X-axis header labels
    for (const xVal of xValues) {
      const xHeader = board.createDiv({ cls: "hermione-board-header-x" });
      xHeader.createSpan({ text: String(xVal) });
    }

    // Separate range docs from point docs
    const hasRangeConfig = !!this.config.xAxisEnd || !!this.config.yAxisEnd;
    const rangeDocs = hasRangeConfig
      ? this.result.documents.filter(doc => this.isRangeDoc(doc))
      : [];
    const rangeDocPaths = new Set(rangeDocs.map(d => d.path));

    // Create rows with Y-axis labels and cells
    const cellGrid: HTMLElement[][] = [];
    for (let yi = 0; yi < yValues.length; yi++) {
      const yVal = yValues[yi];
      cellGrid[yi] = [];

      // Y-axis label
      const yHeader = board.createDiv({ cls: "hermione-board-header-y" });
      yHeader.createSpan({ text: String(yVal) });

      // Create cells for each X value
      for (let xi = 0; xi < xValues.length; xi++) {
        const xVal = xValues[xi];
        const cell = board.createDiv({ cls: "hermione-board-cell" });
        cellGrid[yi][xi] = cell;

        // Set data attributes for drop target identification
        cell.dataset.xValue = String(xVal);
        cell.dataset.yValue = String(yVal);

        // Setup drop zone
        this.setupDropZone(cell, xVal, yVal, xValues, yValues);

        // Find point documents matching this X/Y combination (skip range docs)
        const matchingDocs = this.result.documents.filter(doc => {
          if (rangeDocPaths.has(doc.path)) return false;

          const rawX = this.getPropertyValue(doc.properties, this.config.xAxis!);
          const rawY = this.getPropertyValue(doc.properties, this.config.yAxis!);

          const xMatch = Array.isArray(rawX)
            ? rawX.some(v => this.matchesCellValue(v, xVal, this.xTransformFn, !!this.config.xExact, xValues))
            : this.matchesCellValue(rawX, xVal, this.xTransformFn, !!this.config.xExact, xValues);
          const yMatch = Array.isArray(rawY)
            ? rawY.some(v => this.matchesCellValue(v, yVal, this.yTransformFn, !!this.config.yExact, yValues))
            : this.matchesCellValue(rawY, yVal, this.yTransformFn, !!this.config.yExact, yValues);

          return xMatch && yMatch;
        });

        if (matchingDocs.length > 0) {
          const dotsContainer = cell.createDiv({ cls: "hermione-board-items" });

          for (const doc of matchingDocs) {
            this.renderDocumentCard(dotsContainer, doc);
          }
        }
      }
    }

    // Render range cards with absolute positioning and lane stacking
    if (rangeDocs.length > 0) {
      this.renderRangeCards(board, rangeDocs, xValues, yValues, cellGrid);
    }

    // X-axis label (centered below data columns, inside the grid)
    if (this.config.xLabel) {
      board.createDiv(); // empty placeholder for y-header column
      const xLabelEl = board.createDiv({ cls: "hermione-axis-label-x" });
      xLabelEl.style.gridColumn = `span ${xValues.length}`;
      xLabelEl.createSpan({ text: this.config.xLabel });
    }

    // Show unassigned documents (missing or non-matching property values)
    this.renderUnassigned(xValues, yValues);

    // Refresh button
    this.renderRefreshButton();
  }

  /**
   * Render a single-axis board view (X-only or Y-only).
   * Cards are stacked along the single axis.
   */
  private renderSingleAxisBoard(): void {
    // Determine which axis is available
    const isYOnly = !this.config.xAxis && !!this.config.yAxis;
    const axisProperty = isYOnly ? this.config.yAxis! : this.config.xAxis!;
    const axisValues = isYOnly
      ? (this.config.yValues ? this.config.yValues : Array.from(this.result.yAxisValues).sort())
      : (this.config.xValues ? this.config.xValues : Array.from(this.result.xAxisValues).sort());
    const transformFn = isYOnly ? this.yTransformFn : this.xTransformFn;
    const isExact = isYOnly ? !!this.config.yExact : !!this.config.xExact;
    const axisLabel = isYOnly
      ? (this.config.yLabel || this.config.xLabel)
      : (this.config.xLabel || this.config.yLabel);

    // Create layout wrapper
    const boardLayout = this.containerEl.createDiv({ cls: "hermione-board-layout" });

    // Create zoom wrapper
    const zoomWrapper = boardLayout.createDiv({ cls: "hermione-zoom-wrapper" });

    zoomWrapper.addEventListener("wheel", (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        if (e.deltaY < 0) this.zoomIn();
        else this.zoomOut();
      }
    }, { passive: false });

    // Create board container
    const board = zoomWrapper.createDiv({ cls: "hermione-board hermione-board-single-axis" });
    this.boardEl = board;

    // Separate range docs from point docs for single-axis
    const rangeEndProp = isYOnly ? this.config.yAxisEnd : this.config.xAxisEnd;
    const hasRangeConfig = !!rangeEndProp;
    const rangeDocs = hasRangeConfig
      ? this.result.documents.filter(doc => this.isRangeDoc(doc))
      : [];
    const rangeDocPaths = new Set(rangeDocs.map(d => d.path));

    const cellArray: HTMLElement[] = [];

    if (isYOnly) {
      // Y-only: vertical layout — header left, cell right per row
      board.style.gridTemplateColumns = `auto 1fr`;

      this.applyZoom();

      for (let i = 0; i < axisValues.length; i++) {
        const val = axisValues[i];
        // Y-header on the left
        const header = board.createDiv({ cls: "hermione-board-header-y" });
        header.createSpan({ text: String(val) });

        // Cell on the right
        const cell = board.createDiv({ cls: "hermione-board-cell hermione-board-cell-horizontal" });
        cell.dataset.yValue = String(val);
        cellArray[i] = cell;

        this.setupDropZone(cell, undefined, val, [], axisValues);

        const matchingDocs = this.result.documents.filter(doc => {
          if (rangeDocPaths.has(doc.path)) return false;
          const raw = this.getPropertyValue(doc.properties, axisProperty);
          return Array.isArray(raw)
            ? raw.some(v => this.matchesCellValue(v, val, transformFn, isExact, axisValues))
            : this.matchesCellValue(raw, val, transformFn, isExact, axisValues);
        });

        if (matchingDocs.length > 0) {
          const items = cell.createDiv({ cls: "hermione-board-items hermione-board-items-horizontal" });
          for (const doc of matchingDocs) {
            this.renderDocumentCard(items, doc);
          }
        }
      }

      // Render range cards for Y-only
      if (rangeDocs.length > 0) {
        this.renderSingleAxisRangeCards(board, rangeDocs, axisValues, "y", cellArray);
      }

      // Axis label below
      if (axisLabel) {
        const labelEl = board.createDiv({ cls: "hermione-axis-label-y-bottom" });
        labelEl.style.gridColumn = "span 2";
        labelEl.createSpan({ text: axisLabel });
      }
    } else {
      // X-only: horizontal layout — columns
      board.style.gridTemplateColumns = `repeat(${axisValues.length}, 1fr)`;

      this.applyZoom();

      // Header row
      for (const val of axisValues) {
        const header = board.createDiv({ cls: "hermione-board-header-x" });
        header.createSpan({ text: String(val) });
      }

      // Single row of cells
      for (let i = 0; i < axisValues.length; i++) {
        const val = axisValues[i];
        const cell = board.createDiv({ cls: "hermione-board-cell" });
        cell.dataset.xValue = String(val);
        cellArray[i] = cell;

        this.setupDropZone(cell, val, undefined, axisValues, []);

        const matchingDocs = this.result.documents.filter(doc => {
          if (rangeDocPaths.has(doc.path)) return false;
          const raw = this.getPropertyValue(doc.properties, axisProperty);
          return Array.isArray(raw)
            ? raw.some(v => this.matchesCellValue(v, val, transformFn, isExact, axisValues))
            : this.matchesCellValue(raw, val, transformFn, isExact, axisValues);
        });

        if (matchingDocs.length > 0) {
          const items = cell.createDiv({ cls: "hermione-board-items" });
          for (const doc of matchingDocs) {
            this.renderDocumentCard(items, doc);
          }
        }
      }

      // Render range cards for X-only
      if (rangeDocs.length > 0) {
        this.renderSingleAxisRangeCards(board, rangeDocs, axisValues, "x", cellArray);
      }

      // Axis label below
      if (axisLabel) {
        const labelEl = board.createDiv({ cls: "hermione-axis-label-x" });
        labelEl.style.gridColumn = `span ${axisValues.length}`;
        labelEl.createSpan({ text: axisLabel });
      }
    }

    // Unassigned documents
    if (isYOnly) {
      this.renderUnassigned([], axisValues);
    } else {
      this.renderUnassigned(axisValues, []);
    }

    // Toolbar
    this.renderRefreshButton();
  }

  /**
   * Render a document as a draggable card for the board view
   */
  private renderDocumentCard(container: HTMLElement, doc: DocumentData): void {
    const card = container.createDiv({ cls: "hermione-card" });

    // Evaluate custom card style
    const cardStyle = this.evaluateCardStyle(doc);

    // Color indicator bar
    const colorBar = card.createDiv({ cls: "hermione-card-color" });
    colorBar.style.backgroundColor = cardStyle.color || this.getDocumentColor(doc.name);

    // Apply additional card styles
    if (cardStyle.background) {
      card.style.backgroundColor = cardStyle.background;
    }
    if (cardStyle.border) {
      card.style.borderLeft = `3px solid ${cardStyle.border}`;
    }

    // Card content
    const content = card.createDiv({ cls: "hermione-card-content" });
    const titleSpan = content.createSpan({ cls: "hermione-card-title", text: doc.name });
    if (cardStyle.textColor) {
      titleSpan.style.color = cardStyle.textColor;
    }

    // Store document reference
    card.dataset.docPath = doc.path;

    // Make draggable (unless all configured axes are readonly)
    const hasX = !!this.config.xAxis;
    const hasY = !!this.config.yAxis;
    const fullyReadonly = (hasX && hasY)
      ? (!!this.config.xReadonly && !!this.config.yReadonly)
      : hasX ? !!this.config.xReadonly : !!this.config.yReadonly;
    card.draggable = !fullyReadonly;
    if (fullyReadonly) {
      card.style.cursor = "pointer";
    }

    // Drag start
    card.addEventListener("dragstart", (e) => {
      if (fullyReadonly) { e.preventDefault(); return; }
      this.currentDragDoc = doc;
      card.addClass("hermione-card-dragging");
      e.dataTransfer?.setData("text/plain", doc.path);

      // Determine the current cell position of this document
      const docX = this.config.xAxis
        ? this.getPropertyValue(doc.properties, this.config.xAxis)
        : undefined;
      const docY = this.config.yAxis
        ? this.getPropertyValue(doc.properties, this.config.yAxis)
        : undefined;
      const docXStr = docX !== undefined
        ? String(applyTransform(docX, this.xTransformFn))
        : undefined;
      const docYStr = docY !== undefined
        ? String(applyTransform(docY, this.yTransformFn))
        : undefined;

      // Highlight only reachable drop zones
      this.containerEl.querySelectorAll(".hermione-board-cell").forEach((cell: Element) => {
        const el = cell as HTMLElement;
        const cellX = el.dataset.xValue;
        const cellY = el.dataset.yValue;

        const xAllowed = !this.config.xReadonly || cellX === docXStr;
        const yAllowed = !this.config.yReadonly || cellY === docYStr;

        if (xAllowed && yAllowed) {
          el.addClass("hermione-drop-zone-active");
        }
      });
    });

    // Drag end
    card.addEventListener("dragend", () => {
      this.currentDragDoc = null;
      card.removeClass("hermione-card-dragging");

      // Remove highlight from drop zones
      this.containerEl.querySelectorAll(".hermione-board-cell").forEach(cell => {
        cell.removeClass("hermione-drop-zone-active");
        cell.removeClass("hermione-drop-zone-hover");
      });
    });

    // Click to open document
    card.addEventListener("click", (e) => {
      e.preventDefault();
      this.app.workspace.openLinkText(doc.path, "");
    });

    // Hover to show preview
    card.addEventListener("mouseenter", (e) => {
      this.schedulePreview(doc, e);
    });

    card.addEventListener("mouseleave", () => {
      this.hidePreview();
    });

    card.addEventListener("mousemove", (e) => {
      if (this.previewEl) {
        this.positionPreview(e);
      }
    });

  }

  /**
   * Render a document as a draggable dot with title (for table view)
   */
  private renderDocumentDot(container: HTMLElement, doc: DocumentData): void {
    // Create wrapper for dot and title
    const wrapper = container.createDiv({ cls: "hermione-dot-wrapper" });

    // Create the colored dot
    const dot = wrapper.createDiv({ cls: "hermione-dot" });
    const color = this.getDocumentColor(doc.name);
    dot.style.backgroundColor = color;

    // Create the title label
    const title = wrapper.createSpan({ cls: "hermione-dot-title", text: doc.name });

    // Store document reference
    wrapper.dataset.docPath = doc.path;

    // Make draggable
    wrapper.draggable = true;

    // Drag start
    wrapper.addEventListener("dragstart", (e) => {
      this.currentDragDoc = doc;
      wrapper.addClass("hermione-dot-dragging");
      e.dataTransfer?.setData("text/plain", doc.path);

      // Highlight all drop zones
      this.containerEl.querySelectorAll(".hermione-matrix-cell").forEach(cell => {
        cell.addClass("hermione-drop-zone-active");
      });
    });

    // Drag end
    wrapper.addEventListener("dragend", () => {
      this.currentDragDoc = null;
      wrapper.removeClass("hermione-dot-dragging");

      // Remove highlight from drop zones
      this.containerEl.querySelectorAll(".hermione-matrix-cell").forEach(cell => {
        cell.removeClass("hermione-drop-zone-active");
        cell.removeClass("hermione-drop-zone-hover");
      });
    });

    // Click to open document
    wrapper.addEventListener("click", (e) => {
      e.preventDefault();
      this.app.workspace.openLinkText(doc.path, "");
    });

    // Hover to show preview
    wrapper.addEventListener("mouseenter", (e) => {
      this.schedulePreview(doc, e);
    });

    wrapper.addEventListener("mouseleave", () => {
      this.hidePreview();
    });

    wrapper.addEventListener("mousemove", (e) => {
      if (this.previewEl) {
        this.positionPreview(e);
      }
    });

  }

  /**
   * Setup a cell as a drop zone
   */
  private setupDropZone(
    cell: HTMLElement, xVal: any, yVal: any,
    allXValues: any[], allYValues: any[]
  ): void {
    cell.addEventListener("dragover", (e) => {
      // Only allow drop on reachable cells
      if (!cell.hasClass("hermione-drop-zone-active")) return;
      e.preventDefault();
      cell.addClass("hermione-drop-zone-hover");
    });

    cell.addEventListener("dragleave", () => {
      cell.removeClass("hermione-drop-zone-hover");
    });

    cell.addEventListener("drop", async (e) => {
      if (!cell.hasClass("hermione-drop-zone-active")) return;
      e.preventDefault();
      cell.removeClass("hermione-drop-zone-hover");

      if (!this.currentDragDoc) return;
      const doc = this.currentDragDoc;

      try {
        const updates: Record<string, any> = {};

        // Only update X-axis if it exists, has a value, and is not readonly
        if (this.config.xAxis && xVal !== undefined && !this.config.xReadonly) {
          if (this.config.xExact) {
            const exactVal = await this.promptExactValue(this.config.xAxis, xVal, allXValues);
            if (exactVal === null) return;
            updates[this.config.xAxis] = exactVal;
          } else {
            const xWriteValue = await this.resolveDropValue(
              xVal, this.xTransformFn, this.xReverseMap, this.config.xAxis
            );
            if (xWriteValue === null) return;
            updates[this.config.xAxis] = xWriteValue;
          }
        }

        // Only update Y-axis if it exists and is not readonly
        if (this.config.yAxis && yVal !== undefined && !this.config.yReadonly) {
          if (this.config.yExact) {
            const exactVal = await this.promptExactValue(this.config.yAxis!, yVal, allYValues);
            if (exactVal === null) return;
            updates[this.config.yAxis!] = exactVal;
          } else {
            const yWriteValue = await this.resolveDropValue(
              yVal, this.yTransformFn, this.yReverseMap, this.config.yAxis!
            );
            if (yWriteValue === null) return;
            updates[this.config.yAxis!] = yWriteValue;
          }
        }

        if (Object.keys(updates).length === 0) return;

        await this.updater.updateProperties(doc.file, updates);

        // Wait for metadata cache to update, then refresh
        this.refreshOnCacheUpdate(doc.file);
      } catch (error) {
        console.error("Failed to update document position:", error);
      }
    });
  }

  /**
   * Wait for Obsidian's metadata cache to update for a specific file,
   * then trigger a full refresh so card-style and positions are correct.
   */
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

  /**
   * Resolve the raw value to write when dropping into a cell.
   * If a transform is active, opens a value picker modal.
   * Returns null if the user cancels.
   */
  private resolveDropValue(
    cellDisplayValue: any,
    transformFn: ((v: any) => any) | null,
    reverseMap: Map<string, any[]> | null,
    axisName: string
  ): Promise<any> {
    return new Promise((resolve) => {
      if (!transformFn) {
        // No transform -- write the cell value directly
        resolve(cellDisplayValue);
        return;
      }

      const candidates = reverseMap?.get(String(cellDisplayValue)) || [];

      const modal = new ValuePickerModal(
        this.app,
        axisName,
        String(cellDisplayValue),
        candidates,
        transformFn,
        (chosenValue) => {
          resolve(chosenValue);
        }
      );
      modal.open();
    });
  }

  /**
   * Schedule showing the preview after a short delay
   */
  private schedulePreview(doc: DocumentData, event: MouseEvent): void {
    this.hidePreview();

    this.previewTimeout = setTimeout(async () => {
      await this.showPreview(doc, event);
    }, 300);
  }

  /**
   * Show the document preview popup
   */
  private async showPreview(doc: DocumentData, event: MouseEvent): Promise<void> {
    this.hidePreview();

    // Create preview container
    this.previewEl = document.body.createDiv({ cls: "hermione-preview" });

    // Header with document name
    const header = this.previewEl.createDiv({ cls: "hermione-preview-header" });
    header.createSpan({ text: doc.name, cls: "hermione-preview-title" });

    // Content container
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

    // Position the preview
    this.positionPreview(event);
  }

  /**
   * Show document content as rendered markdown preview
   */
  private async showPreviewDocument(content: HTMLElement, doc: DocumentData): Promise<void> {
    try {
      const fileContent = await this.app.vault.read(doc.file);
      const contentWithoutFrontmatter = fileContent.replace(/^---[\s\S]*?---\n?/, "");
      const previewContent = contentWithoutFrontmatter.slice(0, 1000);
      const truncated = contentWithoutFrontmatter.length > 1000;

      await MarkdownRenderer.render(
        this.app,
        previewContent + (truncated ? "\n\n*...*" : ""),
        content,
        doc.path,
        new Component()
      );
    } catch (error) {
      content.createSpan({ text: "Vorschau nicht verfügbar", cls: "hermione-preview-error" });
    }
  }

  /**
   * Show axis property values in the preview
   */
  private showPreviewAxes(content: HTMLElement, doc: DocumentData): void {
    const list = content.createDiv({ cls: "hermione-preview-props" });

    if (this.config.xAxis) {
      const label = this.config.xLabel || this.config.xAxis;
      const value = this.getPropertyValue(doc.properties, this.config.xAxis);
      this.renderPreviewProp(list, label, value);
    }

    if (this.config.yAxis) {
      const label = this.config.yLabel || this.config.yAxis;
      const value = this.getPropertyValue(doc.properties, this.config.yAxis);
      this.renderPreviewProp(list, label, value);
    }
  }

  /**
   * Show all user-defined frontmatter properties in the preview
   */
  private showPreviewProperties(content: HTMLElement, doc: DocumentData): void {
    const list = content.createDiv({ cls: "hermione-preview-props" });
    const skipKeys = new Set(["position", "file.name", "file.path", "file.ctime", "file.mtime", "file.size", "file.tags"]);

    for (const [key, value] of Object.entries(doc.properties)) {
      if (skipKeys.has(key) || key.startsWith("file.")) continue;
      if (typeof value === "object" && value !== null && !Array.isArray(value) && "start" in value && "end" in value) continue;
      this.renderPreviewProp(list, key, value);
    }
  }

  /**
   * Render a single key-value pair in the preview
   */
  private renderPreviewProp(container: HTMLElement, key: string, value: any): void {
    const row = container.createDiv({ cls: "hermione-preview-prop" });
    row.createSpan({ cls: "hermione-preview-prop-key", text: key });
    row.createSpan({ cls: "hermione-preview-prop-value", text: this.formatDisplayValue(value) });
  }

  /**
   * Position the preview near the cursor
   */
  private positionPreview(event: MouseEvent): void {
    if (!this.previewEl) return;

    const padding = 15;
    const maxWidth = 400;
    const maxHeight = 300;

    // Get viewport dimensions
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Calculate position
    let left = event.clientX + padding;
    let top = event.clientY + padding;

    // Ensure preview doesn't go off screen
    if (left + maxWidth > viewportWidth) {
      left = event.clientX - maxWidth - padding;
    }
    if (top + maxHeight > viewportHeight) {
      top = event.clientY - maxHeight - padding;
    }

    // Ensure minimum positions
    left = Math.max(padding, left);
    top = Math.max(padding, top);

    this.previewEl.style.left = `${left}px`;
    this.previewEl.style.top = `${top}px`;
  }

  /**
   * Hide the preview popup
   */
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

  /**
   * Find the index of the axis value that a raw value maps to.
   * Returns -1 if no match found.
   */
  private findValueIndex(
    rawValue: any,
    axisValues: any[],
    transformFn: ((v: any) => any) | null,
    isExact: boolean
  ): number {
    for (let i = 0; i < axisValues.length; i++) {
      if (this.matchesCellValue(rawValue, axisValues[i], transformFn, isExact, axisValues)) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Check if a document is a range document (has range end values).
   */
  private isRangeDoc(doc: DocumentData): boolean {
    if (this.config.xAxisEnd) {
      const endVal = this.getPropertyValue(doc.properties, this.config.xAxisEnd);
      if (endVal !== undefined && endVal !== null && endVal !== "") return true;
    }
    if (this.config.yAxisEnd) {
      const endVal = this.getPropertyValue(doc.properties, this.config.yAxisEnd);
      if (endVal !== undefined && endVal !== null && endVal !== "") return true;
    }
    return false;
  }

  /**
   * Compute range card layouts with positions and assign stacking lanes.
   */
  private computeRangeLayouts(
    rangeDocs: DocumentData[],
    xValues: any[],
    yValues: any[]
  ): { doc: DocumentData; xStartIdx: number; xEndIdx: number; yStartIdx: number; yEndIdx: number; hasXRange: boolean; hasYRange: boolean; lane: number; totalLanes: number }[] {
    const layouts: { doc: DocumentData; xStartIdx: number; xEndIdx: number; yStartIdx: number; yEndIdx: number; hasXRange: boolean; hasYRange: boolean; lane: number; totalLanes: number }[] = [];

    for (const doc of rangeDocs) {
      let xStartIdx = 0, xEndIdx = 0, hasXRange = false;
      let yStartIdx = 0, yEndIdx = 0, hasYRange = false;

      if (this.config.xAxis) {
        const rawXStart = this.getPropertyValue(doc.properties, this.config.xAxis);
        xStartIdx = this.findValueIndex(rawXStart, xValues, this.xTransformFn, !!this.config.xExact);
        if (this.config.xAxisEnd) {
          const rawXEnd = this.getPropertyValue(doc.properties, this.config.xAxisEnd);
          if (rawXEnd !== undefined && rawXEnd !== null && rawXEnd !== "") {
            xEndIdx = this.findValueIndex(rawXEnd, xValues, this.xTransformFn, !!this.config.xExact);
            hasXRange = xStartIdx >= 0 && xEndIdx >= 0;
          }
        }
        if (!hasXRange) {
          if (xStartIdx < 0) continue;
          xEndIdx = xStartIdx;
        }
        if (xStartIdx > xEndIdx) [xStartIdx, xEndIdx] = [xEndIdx, xStartIdx];
      }

      if (this.config.yAxis) {
        const rawYStart = this.getPropertyValue(doc.properties, this.config.yAxis);
        yStartIdx = this.findValueIndex(rawYStart, yValues, this.yTransformFn, !!this.config.yExact);
        if (this.config.yAxisEnd) {
          const rawYEnd = this.getPropertyValue(doc.properties, this.config.yAxisEnd);
          if (rawYEnd !== undefined && rawYEnd !== null && rawYEnd !== "") {
            yEndIdx = this.findValueIndex(rawYEnd, yValues, this.yTransformFn, !!this.config.yExact);
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

    this.assignRangeLanes(layouts);
    return layouts;
  }

  /**
   * Assign stacking lanes to overlapping range cards using greedy interval graph coloring.
   */
  private assignRangeLanes(layouts: { xStartIdx: number; xEndIdx: number; yStartIdx: number; yEndIdx: number; lane: number; totalLanes: number }[]): void {
    const overlaps = (a: typeof layouts[0], b: typeof layouts[0]): boolean => {
      return a.xStartIdx <= b.xEndIdx && b.xStartIdx <= a.xEndIdx
          && a.yStartIdx <= b.yEndIdx && b.yStartIdx <= a.yEndIdx;
    };

    layouts.sort((a, b) => a.yStartIdx !== b.yStartIdx ? a.yStartIdx - b.yStartIdx : a.xStartIdx - b.xStartIdx);

    for (const layout of layouts) {
      const usedLanes = new Set<number>();
      for (const other of layouts) {
        if (other === layout) continue;
        if (other.lane >= 0 && overlaps(layout, other)) {
          usedLanes.add(other.lane);
        }
      }
      let lane = 0;
      while (usedLanes.has(lane)) lane++;
      layout.lane = lane;
    }

    for (const layout of layouts) {
      let maxLane = layout.lane;
      for (const other of layouts) {
        if (other === layout) continue;
        if (overlaps(layout, other)) {
          maxLane = Math.max(maxLane, other.lane);
        }
      }
      layout.totalLanes = maxLane + 1;
    }
  }

  /**
   * Render range cards with absolute positioning and lane-based stacking.
   */
  private renderRangeCards(
    board: HTMLElement,
    rangeDocs: DocumentData[],
    xValues: any[],
    yValues: any[],
    cellGrid: HTMLElement[][]
  ): void {
    const layouts = this.computeRangeLayouts(rangeDocs, xValues, yValues);
    if (layouts.length === 0) return;

    const gap = 2;

    for (const layout of layouts) {
      const startCell = cellGrid[layout.yStartIdx]?.[layout.xStartIdx];
      const endCell = cellGrid[layout.yEndIdx]?.[layout.xEndIdx];
      if (!startCell || !endCell) continue;

      const left = startCell.offsetLeft;
      const top = startCell.offsetTop;
      const right = endCell.offsetLeft + endCell.offsetWidth;
      const bottom = endCell.offsetTop + endCell.offsetHeight;
      const totalWidth = right - left;
      const totalHeight = bottom - top;

      const stackVertically = layout.hasXRange || !layout.hasYRange;
      const isVertical = layout.hasYRange && !layout.hasXRange;

      const card = board.createDiv({ cls: "hermione-card hermione-range-card" });

      if (stackVertically) {
        const laneH = (totalHeight - (layout.totalLanes - 1) * gap) / layout.totalLanes;
        card.style.left = `${left}px`;
        card.style.top = `${top + layout.lane * (laneH + gap)}px`;
        card.style.width = `${totalWidth}px`;
        card.style.height = `${laneH}px`;
      } else {
        const laneW = (totalWidth - (layout.totalLanes - 1) * gap) / layout.totalLanes;
        card.style.left = `${left + layout.lane * (laneW + gap)}px`;
        card.style.top = `${top}px`;
        card.style.width = `${laneW}px`;
        card.style.height = `${totalHeight}px`;
      }

      if (isVertical) {
        card.addClass("hermione-range-card-vertical");
      }

      this.renderRangeCardContent(card, layout.doc, board, layout, xValues, yValues);
    }
  }

  /**
   * Render range cards for single-axis boards with lane stacking.
   */
  private renderSingleAxisRangeCards(
    board: HTMLElement,
    rangeDocs: DocumentData[],
    axisValues: any[],
    axis: "x" | "y",
    cellArray: HTMLElement[]
  ): void {
    const axisProperty = axis === "x" ? this.config.xAxis! : this.config.yAxis!;
    const axisEndProperty = axis === "x" ? this.config.xAxisEnd! : this.config.yAxisEnd!;
    const transformFn = axis === "x" ? this.xTransformFn : this.yTransformFn;
    const isExact = axis === "x" ? !!this.config.xExact : !!this.config.yExact;
    const isReadonly = axis === "x" ? !!this.config.xReadonly : !!this.config.yReadonly;

    // Compute layouts with lane assignment
    const layouts: { doc: DocumentData; startIdx: number; endIdx: number; lane: number; totalLanes: number }[] = [];
    for (const doc of rangeDocs) {
      const rawStart = this.getPropertyValue(doc.properties, axisProperty);
      const rawEnd = this.getPropertyValue(doc.properties, axisEndProperty);
      let startIdx = this.findValueIndex(rawStart, axisValues, transformFn, isExact);
      let endIdx = this.findValueIndex(rawEnd, axisValues, transformFn, isExact);
      if (startIdx < 0 || endIdx < 0) continue;
      if (startIdx > endIdx) [startIdx, endIdx] = [endIdx, startIdx];
      layouts.push({ doc, startIdx, endIdx, lane: -1, totalLanes: 1 });
    }

    // Assign lanes using 1D overlap check
    const overlaps = (a: typeof layouts[0], b: typeof layouts[0]): boolean => {
      return a.startIdx <= b.endIdx && b.startIdx <= a.endIdx;
    };
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

    const gap = 2;
    for (const layout of layouts) {
      const startCell = cellArray[layout.startIdx];
      const endCell = cellArray[layout.endIdx];
      if (!startCell || !endCell) continue;

      const card = board.createDiv({ cls: "hermione-card hermione-range-card" });

      if (axis === "x") {
        // Horizontal: stack vertically within the row
        const left = startCell.offsetLeft;
        const right = endCell.offsetLeft + endCell.offsetWidth;
        const top = startCell.offsetTop;
        const cellHeight = startCell.offsetHeight;
        const laneH = (cellHeight - (layout.totalLanes - 1) * gap) / layout.totalLanes;
        card.style.left = `${left}px`;
        card.style.top = `${top + layout.lane * (laneH + gap)}px`;
        card.style.width = `${right - left}px`;
        card.style.height = `${laneH}px`;
      } else {
        // Vertical: stack horizontally within the column
        const top = startCell.offsetTop;
        const bottom = endCell.offsetTop + endCell.offsetHeight;
        const left = startCell.offsetLeft;
        const cellWidth = startCell.offsetWidth;
        const laneW = (cellWidth - (layout.totalLanes - 1) * gap) / layout.totalLanes;
        card.style.left = `${left + layout.lane * (laneW + gap)}px`;
        card.style.top = `${top}px`;
        card.style.width = `${laneW}px`;
        card.style.height = `${bottom - top}px`;
        card.addClass("hermione-range-card-vertical");
      }

      // Card content
      const cardStyle = this.evaluateCardStyle(layout.doc);
      const colorBar = card.createDiv({ cls: "hermione-card-color" });
      colorBar.style.backgroundColor = cardStyle.color || this.getDocumentColor(layout.doc.name);
      if (cardStyle.background) card.style.backgroundColor = cardStyle.background;
      if (cardStyle.border) card.style.borderLeft = `3px solid ${cardStyle.border}`;
      const content = card.createDiv({ cls: "hermione-card-content" });
      const titleSpan = content.createSpan({ cls: "hermione-card-title", text: layout.doc.name });
      if (cardStyle.textColor) titleSpan.style.color = cardStyle.textColor;
      card.dataset.docPath = layout.doc.path;

      card.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).classList.contains("hermione-range-handle")) return;
        e.preventDefault();
        this.app.workspace.openLinkText(layout.doc.path, "");
      });
      card.addEventListener("mouseenter", (e) => this.schedulePreview(layout.doc, e));
      card.addEventListener("mouseleave", () => this.hidePreview());
      card.addEventListener("mousemove", (e) => { if (this.previewEl) this.positionPreview(e); });

      if (!isReadonly) {
        if (axis === "x") {
          const leftHandle = card.createDiv({ cls: "hermione-range-handle hermione-range-handle-left" });
          const rightHandle = card.createDiv({ cls: "hermione-range-handle hermione-range-handle-right" });
          this.setupResizeHandle(leftHandle, layout.doc, "start", "x", axisValues, board);
          this.setupResizeHandle(rightHandle, layout.doc, "end", "x", axisValues, board);
        } else {
          const topHandle = card.createDiv({ cls: "hermione-range-handle hermione-range-handle-top" });
          const bottomHandle = card.createDiv({ cls: "hermione-range-handle hermione-range-handle-bottom" });
          this.setupResizeHandle(topHandle, layout.doc, "start", "y", axisValues, board);
          this.setupResizeHandle(bottomHandle, layout.doc, "end", "y", axisValues, board);
        }
      }
    }
  }

  /**
   * Render the content and event handlers for a range card in the matrix view.
   */
  private renderRangeCardContent(
    card: HTMLElement,
    doc: DocumentData,
    board: HTMLElement,
    layout: { hasXRange: boolean; hasYRange: boolean },
    xValues: any[],
    yValues: any[]
  ): void {
    const cardStyle = this.evaluateCardStyle(doc);
    const colorBar = card.createDiv({ cls: "hermione-card-color" });
    colorBar.style.backgroundColor = cardStyle.color || this.getDocumentColor(doc.name);
    if (cardStyle.background) card.style.backgroundColor = cardStyle.background;
    if (cardStyle.border) card.style.borderLeft = `3px solid ${cardStyle.border}`;

    const content = card.createDiv({ cls: "hermione-card-content" });
    const titleSpan = content.createSpan({ cls: "hermione-card-title", text: doc.name });
    if (cardStyle.textColor) titleSpan.style.color = cardStyle.textColor;

    card.dataset.docPath = doc.path;
    card.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("hermione-range-handle")) return;
      e.preventDefault();
      this.app.workspace.openLinkText(doc.path, "");
    });
    card.addEventListener("mouseenter", (e) => this.schedulePreview(doc, e));
    card.addEventListener("mouseleave", () => this.hidePreview());
    card.addEventListener("mousemove", (e) => { if (this.previewEl) this.positionPreview(e); });

    if (layout.hasXRange && !this.config.xReadonly) {
      const leftHandle = card.createDiv({ cls: "hermione-range-handle hermione-range-handle-left" });
      const rightHandle = card.createDiv({ cls: "hermione-range-handle hermione-range-handle-right" });
      this.setupResizeHandle(leftHandle, doc, "start", "x", xValues, board);
      this.setupResizeHandle(rightHandle, doc, "end", "x", xValues, board);
    }
    if (layout.hasYRange && !this.config.yReadonly) {
      const topHandle = card.createDiv({ cls: "hermione-range-handle hermione-range-handle-top" });
      const bottomHandle = card.createDiv({ cls: "hermione-range-handle hermione-range-handle-bottom" });
      this.setupResizeHandle(topHandle, doc, "start", "y", yValues, board);
      this.setupResizeHandle(bottomHandle, doc, "end", "y", yValues, board);
    }
  }

  /**
   * Setup a resize handle for range cards.
   */
  private setupResizeHandle(
    handle: HTMLElement,
    doc: DocumentData,
    edge: "start" | "end",
    axis: "x" | "y",
    allValues: any[],
    board: HTMLElement
  ): void {
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const card = handle.closest(".hermione-range-card") as HTMLElement;
      if (!card) return;

      const cellPositions = this.calculateCellPositions(board, axis, allValues);
      const boardRect = board.getBoundingClientRect();
      const scale = this.zoomLevel / 100;

      this.resizeState = {
        doc,
        edge,
        axis,
        cardEl: card,
        allValues,
        cellPositions,
        boardRect,
        scale
      };

      card.addClass("hermione-range-resizing");

      const onMouseMove = (ev: MouseEvent) => {
        if (!this.resizeState) return;
        const mousePos = axis === "x" ? ev.clientX : ev.clientY;
        const targetIdx = this.findClosestCellIndex(mousePos, this.resizeState.cellPositions);
        if (targetIdx >= 0) {
          const cellPos = this.resizeState.cellPositions[targetIdx];
          const br = this.resizeState.boardRect;
          const sc = this.resizeState.scale;

          if (axis === "x") {
            const currentLeft = parseFloat(card.style.left);
            const currentWidth = parseFloat(card.style.width);
            if (edge === "start") {
              const newLeft = (cellPos.start - br.left) / sc;
              card.style.left = `${newLeft}px`;
              card.style.width = `${currentLeft + currentWidth - newLeft}px`;
            } else {
              const newRight = (cellPos.end - br.left) / sc;
              card.style.width = `${newRight - currentLeft}px`;
            }
          } else {
            const currentTop = parseFloat(card.style.top);
            const currentHeight = parseFloat(card.style.height);
            if (edge === "start") {
              const newTop = (cellPos.start - br.top) / sc;
              card.style.top = `${newTop}px`;
              card.style.height = `${currentTop + currentHeight - newTop}px`;
            } else {
              const newBottom = (cellPos.end - br.top) / sc;
              card.style.height = `${newBottom - currentTop}px`;
            }
          }
        }
      };

      const onMouseUp = async (ev: MouseEvent) => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);

        if (!this.resizeState) return;

        card.removeClass("hermione-range-resizing");

        const mousePos = axis === "x" ? ev.clientX : ev.clientY;
        const targetIdx = this.findClosestCellIndex(mousePos, this.resizeState.cellPositions);

        if (targetIdx >= 0 && targetIdx < allValues.length) {
          const newValue = allValues[targetIdx];
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
              await this.updater.updateProperties(doc.file, { [property]: writeValue });
              this.refreshOnCacheUpdate(doc.file);
            }
          } catch (error) {
            console.error("Hermione: Failed to update range:", error);
          }
        }

        this.resizeState = null;
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  }

  /**
   * Calculate the screen positions of cells along an axis (viewport coords).
   */
  private calculateCellPositions(
    board: HTMLElement,
    axis: "x" | "y",
    allValues: any[]
  ): { value: any; start: number; end: number }[] {
    const positions: { value: any; start: number; end: number }[] = [];
    const cells = board.querySelectorAll(".hermione-board-cell");

    for (let i = 0; i < allValues.length; i++) {
      const val = String(allValues[i]);
      for (const cell of Array.from(cells)) {
        const el = cell as HTMLElement;
        const cellVal = axis === "x" ? el.dataset.xValue : el.dataset.yValue;
        if (cellVal === val) {
          const rect = el.getBoundingClientRect();
          positions.push({
            value: allValues[i],
            start: axis === "x" ? rect.left : rect.top,
            end: axis === "x" ? rect.right : rect.bottom
          });
          break;
        }
      }
    }

    return positions;
  }

  /**
   * Find the closest cell index to a mouse position.
   */
  private findClosestCellIndex(
    mousePos: number,
    cellPositions: { value: any; start: number; end: number }[]
  ): number {
    let bestIdx = -1;
    let bestDist = Infinity;

    for (let i = 0; i < cellPositions.length; i++) {
      const mid = (cellPositions[i].start + cellPositions[i].end) / 2;
      const dist = Math.abs(mousePos - mid);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    return bestIdx;
  }

  /**
   * Check if a raw document value matches a cell value.
   * In exact mode, numeric values are binned to the nearest step.
   */
  private matchesCellValue(
    rawValue: any,
    cellValue: any,
    transformFn: ((v: any) => any) | null,
    isExact: boolean,
    allCellValues: any[]
  ): boolean {
    const transformed = applyTransform(rawValue, transformFn);

    if (!isExact) {
      return String(transformed) === String(cellValue);
    }

    // Exact mode: bin the numeric value to the correct step cell
    const numVal = parseFloat(String(transformed));
    const numCell = parseFloat(String(cellValue));
    if (isNaN(numVal) || isNaN(numCell)) {
      return String(transformed) === String(cellValue);
    }

    const bin = this.findBinCell(numVal, allCellValues);
    return bin !== null && String(bin) === String(cellValue);
  }

  /**
   * Find which cell a numeric value belongs to (floor to nearest step).
   * Works for both ascending and descending value lists.
   */
  private findBinCell(value: number, cellValues: any[]): number | null {
    const nums = cellValues
      .map(v => parseFloat(String(v)))
      .filter(n => !isNaN(n))
      .sort((a, b) => a - b);

    if (nums.length === 0) return null;

    // Find the largest step value that is <= the given value
    let bin: number | null = null;
    for (const cv of nums) {
      if (cv <= value) bin = cv;
      else break;
    }

    // If value is below all steps, assign to the first (smallest) step
    if (bin === null) bin = nums[0];

    return bin;
  }

  /**
   * Get the range boundaries for a cell in exact mode.
   * Returns [min, max] for the valid input range.
   */
  private getCellRange(cellValue: any, allCellValues: any[]): [number, number] {
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

  /**
   * Prompt the user for an exact value via modal.
   * Returns null if cancelled.
   */
  private promptExactValue(
    axisName: string,
    cellValue: any,
    allCellValues: any[]
  ): Promise<number | null> {
    return new Promise((resolve) => {
      const [rangeMin, rangeMax] = this.getCellRange(cellValue, allCellValues);
      const modal = new ExactValueModal(
        this.app,
        axisName,
        parseFloat(String(cellValue)),
        rangeMin,
        rangeMax,
        (value) => resolve(value)
      );
      modal.open();
    });
  }

  /**
   * Evaluate the cardStyle function for a document.
   * Returns a normalized style object.
   *
   * The user function receives all document properties and may return:
   *   - a string  → used as the color bar color
   *   - an object  → { color?, background?, border?, textColor? }
   *   - null/undefined → default styling
   */
  private evaluateCardStyle(doc: DocumentData): {
    color?: string;
    background?: string;
    border?: string;
    textColor?: string;
  } {
    if (!this.cardStyleFn) return {};

    try {
      const result = this.cardStyleFn(doc.properties);

      if (!result) return {};

      if (typeof result === "string") {
        return { color: result };
      }

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
  private getDocumentColor(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }

    // Generate HSL color with good saturation and lightness
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 60%)`;
  }

  /**
   * Render unassigned documents that couldn't be placed in the matrix
   */
  private renderUnassigned(xValues: any[], yValues: any[]): void {
    if (this.config.hideUnassigned) return;

    const hasX = this.config.xAxis && xValues.length > 0;
    const hasY = this.config.yAxis && yValues.length > 0;

    // Find documents that don't match any cell in the matrix
    const unassigned = this.result.documents.filter(doc => {
      if (hasX) {
        const rawX = this.getPropertyValue(doc.properties, this.config.xAxis!);
        if (rawX === undefined || rawX === null || rawX === "") {
          return true;
        }
        const xMatches = xValues.some(xVal =>
          Array.isArray(rawX)
            ? rawX.some(v => this.matchesCellValue(v, xVal, this.xTransformFn, !!this.config.xExact, xValues))
            : this.matchesCellValue(rawX, xVal, this.xTransformFn, !!this.config.xExact, xValues)
        );
        if (!xMatches) return true;
      }

      if (hasY) {
        const rawY = this.getPropertyValue(doc.properties, this.config.yAxis!);
        if (rawY === undefined || rawY === null || rawY === "") {
          return true;
        }
        const yMatches = yValues.some(yVal =>
          Array.isArray(rawY)
            ? rawY.some(v => this.matchesCellValue(v, yVal, this.yTransformFn, !!this.config.yExact, yValues))
            : this.matchesCellValue(rawY, yVal, this.yTransformFn, !!this.config.yExact, yValues)
        );
        if (!yMatches) return true;
      }

      return false;
    });

    if (unassigned.length === 0) return;

    const section = this.containerEl.createDiv({ cls: "hermione-unassigned" });
    section.createEl("strong", { text: "Nicht zugeordnet:" });

    const items = section.createDiv({ cls: "hermione-unassigned-items" });

    for (const doc of unassigned) {
      this.renderDocumentCard(items, doc);
    }
  }

  /**
   * Render an editable cell
   */
  private renderEditableCell(
    container: HTMLElement,
    doc: DocumentData,
    propertyName: string,
    value: any,
    compact: boolean = false
  ): void {
    const displayValue = this.formatDisplayValue(value);

    const wrapper = container.createDiv({ cls: "hermione-editable-wrapper" });

    // Display span
    const display = wrapper.createSpan({
      cls: "hermione-value-display",
      text: displayValue
    });

    // Edit input (hidden by default)
    const input = wrapper.createEl("input", {
      cls: "hermione-value-input",
      type: "text",
      value: displayValue
    });
    input.style.display = "none";

    if (compact) {
      const label = wrapper.createSpan({
        cls: "hermione-prop-label",
        text: `${propertyName}: `
      });
      wrapper.insertBefore(label, display);
    }

    // Edit button
    const editBtn = wrapper.createEl("button", { cls: "hermione-edit-btn" });
    setIcon(editBtn, "pencil");
    editBtn.title = "Bearbeiten";

    // Save button (hidden by default)
    const saveBtn = wrapper.createEl("button", { cls: "hermione-save-btn" });
    setIcon(saveBtn, "check");
    saveBtn.title = "Speichern";
    saveBtn.style.display = "none";

    // Cancel button (hidden by default)
    const cancelBtn = wrapper.createEl("button", { cls: "hermione-cancel-btn" });
    setIcon(cancelBtn, "x");
    cancelBtn.title = "Abbrechen";
    cancelBtn.style.display = "none";

    // Edit mode handler
    const enterEditMode = () => {
      display.style.display = "none";
      editBtn.style.display = "none";
      input.style.display = "";
      saveBtn.style.display = "";
      cancelBtn.style.display = "";
      input.focus();
      input.select();
    };

    // Exit edit mode handler
    const exitEditMode = () => {
      display.style.display = "";
      editBtn.style.display = "";
      input.style.display = "none";
      saveBtn.style.display = "none";
      cancelBtn.style.display = "none";
      input.value = displayValue;
    };

    // Save handler
    const saveValue = async () => {
      const newValue = this.updater.parseValue(input.value, value);

      if (newValue !== value) {
        try {
          await this.updater.updateProperty(doc.file, propertyName, newValue);
          display.textContent = this.formatDisplayValue(newValue);
          // Wait for metadata cache to update, then refresh
          this.refreshOnCacheUpdate(doc.file);
        } catch (error) {
          console.error("Failed to update property:", error);
          // Show error feedback
          container.addClass("hermione-error-flash");
          setTimeout(() => container.removeClass("hermione-error-flash"), 500);
        }
      }

      exitEditMode();
    };

    // Event listeners
    editBtn.addEventListener("click", enterEditMode);
    display.addEventListener("dblclick", enterEditMode);

    saveBtn.addEventListener("click", saveValue);
    cancelBtn.addEventListener("click", exitEditMode);

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        saveValue();
      } else if (e.key === "Escape") {
        exitEditMode();
      }
    });

    input.addEventListener("blur", (e) => {
      // Don't exit if clicking save or cancel
      const relatedTarget = e.relatedTarget as HTMLElement;
      if (relatedTarget !== saveBtn && relatedTarget !== cancelBtn) {
        setTimeout(() => {
          if (input.style.display !== "none") {
            exitEditMode();
          }
        }, 100);
      }
    });
  }

  /**
   * Render toolbar with zoom controls and refresh button
   */
  private renderRefreshButton(): void {
    const toolbar = this.containerEl.createDiv({ cls: "hermione-toolbar" });

    // Show zoom controls for board views (both matrix and single-axis)
    if (this.boardEl) {
      // Zoom controls container
      const zoomControls = toolbar.createDiv({ cls: "hermione-zoom-controls" });

      // Zoom out button
      const zoomOutBtn = zoomControls.createEl("button", { cls: "hermione-zoom-btn" });
      setIcon(zoomOutBtn, "minus");
      zoomOutBtn.title = "Verkleinern";
      zoomOutBtn.addEventListener("click", () => this.zoomOut());

      // Zoom display/reset
      this.zoomDisplay = zoomControls.createEl("button", {
        cls: "hermione-zoom-display",
        text: `${this.zoomLevel}%`
      });
      this.zoomDisplay.title = "Zoom zurücksetzen";
      this.zoomDisplay.addEventListener("click", () => this.resetZoom());

      // Zoom in button
      const zoomInBtn = zoomControls.createEl("button", { cls: "hermione-zoom-btn" });
      setIcon(zoomInBtn, "plus");
      zoomInBtn.title = "Vergrößern";
      zoomInBtn.addEventListener("click", () => this.zoomIn());

      // Zoom slider
      const slider = zoomControls.createEl("input", {
        cls: "hermione-zoom-slider",
        type: "range",
      });
      slider.min = String(MatrixRenderer.ZOOM_MIN);
      slider.max = String(MatrixRenderer.ZOOM_MAX);
      slider.step = String(MatrixRenderer.ZOOM_STEP);
      slider.value = String(this.zoomLevel);
      slider.title = "Zoom";
      slider.addEventListener("input", (e) => {
        this.zoomLevel = parseInt((e.target as HTMLInputElement).value);
        this.applyZoom();
      });
    }

    // Refresh button
    const refreshBtn = toolbar.createEl("button", {
      cls: "hermione-refresh-btn",
      text: "Aktualisieren"
    });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", () => this.onRefresh());
  }

  /**
   * Zoom in by one step
   */
  private zoomIn(): void {
    if (this.zoomLevel < MatrixRenderer.ZOOM_MAX) {
      this.zoomLevel += MatrixRenderer.ZOOM_STEP;
      this.applyZoom();
    }
  }

  /**
   * Zoom out by one step
   */
  private zoomOut(): void {
    if (this.zoomLevel > MatrixRenderer.ZOOM_MIN) {
      this.zoomLevel -= MatrixRenderer.ZOOM_STEP;
      this.applyZoom();
    }
  }

  /**
   * Reset zoom to 100%
   */
  private resetZoom(): void {
    this.zoomLevel = 100;
    this.applyZoom();
  }

  /**
   * Apply current zoom level to the board
   */
  private applyZoom(): void {
    if (this.boardEl) {
      const scale = this.zoomLevel / 100;
      this.boardEl.style.transform = `scale(${scale})`;
      this.boardEl.style.transformOrigin = "top left";
    }

    // Update zoom display
    if (this.zoomDisplay) {
      this.zoomDisplay.textContent = `${this.zoomLevel}%`;
    }

    // Update slider if it exists
    const slider = this.containerEl.querySelector(".hermione-zoom-slider") as HTMLInputElement;
    if (slider) {
      slider.value = String(this.zoomLevel);
    }
  }

  /**
   * Get property value from object, supporting nested paths
   */
  private getPropertyValue(obj: Record<string, any>, path: string): any {
    const parts = path.split(".");
    let value = obj;

    for (const part of parts) {
      if (value === null || value === undefined) {
        return undefined;
      }
      value = value[part];
    }

    return value;
  }

  /**
   * Format a value for display
   */
  private formatDisplayValue(value: any): string {
    if (value === null || value === undefined) {
      return "";
    }

    if (Array.isArray(value)) {
      return value.join(", ");
    }

    if (typeof value === "object") {
      return JSON.stringify(value);
    }

    return String(value);
  }
}
