import { App, TFile, MarkdownRenderChild, setIcon, MarkdownRenderer, Component } from "obsidian";
import { HermineConfig, DocumentData, QueryResult } from "./types";
import { FrontmatterUpdater } from "./frontmatter-updater";
import { compileTransform, applyTransform, buildReverseMap } from "./value-transform";
import { ValuePickerModal } from "./value-picker-modal";

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
    private config: HermineConfig,
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
    this.containerEl.addClass("hermine-container");

    // Render title if configured
    if (this.config.title) {
      this.containerEl.createEl("h3", {
        cls: "hermine-title",
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

    // Render based on whether Y-axis is specified
    if (this.config.yAxis) {
      this.renderMatrix();
    } else {
      this.renderTable();
    }
  }

  /**
   * Render error messages
   */
  private renderErrors(): void {
    const errorContainer = this.containerEl.createDiv({ cls: "hermine-errors" });
    for (const error of this.result.errors) {
      errorContainer.createDiv({ cls: "hermine-error", text: error });
    }
  }

  /**
   * Render empty state message
   */
  private renderEmptyState(): void {
    this.containerEl.createDiv({
      cls: "hermine-empty",
      text: "Keine Dokumente gefunden."
    });
  }

  /**
   * Render a simple table (X-axis only)
   */
  private renderTable(): void {
    const table = this.containerEl.createEl("table", { cls: "hermine-table" });

    // Header row
    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");

    // Document name column
    headerRow.createEl("th", { text: "Dokument" });

    // X-axis column
    headerRow.createEl("th", { text: this.config.xAxis });

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
      const nameCell = row.createEl("td", { cls: "hermine-cell-name" });
      const link = nameCell.createEl("a", {
        cls: "internal-link",
        text: doc.name
      });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        this.app.workspace.openLinkText(doc.path, "");
      });

      // X-axis value (editable)
      const xValue = this.getPropertyValue(doc.properties, this.config.xAxis);
      const xCell = row.createEl("td", { cls: "hermine-cell-editable" });
      this.renderEditableCell(xCell, doc, this.config.xAxis, xValue);

      // Additional display columns (editable)
      if (this.config.display) {
        for (const prop of this.config.display) {
          const value = this.getPropertyValue(doc.properties, prop);
          const cell = row.createEl("td", { cls: "hermine-cell-editable" });
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
    const boardLayout = this.containerEl.createDiv({ cls: "hermine-board-layout" });

    // Y-axis label (rotated, left side)
    if (this.config.yLabel) {
      const yLabelEl = boardLayout.createDiv({ cls: "hermine-axis-label-y" });
      yLabelEl.createSpan({ text: this.config.yLabel });
    }

    // Create zoom wrapper for scrollable/zoomable content
    const zoomWrapper = boardLayout.createDiv({ cls: "hermine-zoom-wrapper" });

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
    const board = zoomWrapper.createDiv({ cls: "hermine-board" });
    this.boardEl = board;

    // Set grid template columns based on number of X values (+ 1 for Y labels)
    board.style.gridTemplateColumns = `auto repeat(${xValues.length}, 1fr)`;

    // Apply initial zoom
    this.applyZoom();

    // Create corner cell (empty)
    const corner = board.createDiv({ cls: "hermine-board-corner" });

    // Create X-axis header labels
    for (const xVal of xValues) {
      const xHeader = board.createDiv({ cls: "hermine-board-header-x" });
      xHeader.createSpan({ text: String(xVal) });
    }

    // Create rows with Y-axis labels and cells
    for (const yVal of yValues) {
      // Y-axis label
      const yHeader = board.createDiv({ cls: "hermine-board-header-y" });
      yHeader.createSpan({ text: String(yVal) });

      // Create cells for each X value
      for (const xVal of xValues) {
        const cell = board.createDiv({ cls: "hermine-board-cell" });

        // Set data attributes for drop target identification
        cell.dataset.xValue = String(xVal);
        cell.dataset.yValue = String(yVal);

        // Setup drop zone
        this.setupDropZone(cell, xVal, yVal);

        // Find documents matching this X/Y combination (transform-aware)
        const matchingDocs = this.result.documents.filter(doc => {
          const rawX = this.getPropertyValue(doc.properties, this.config.xAxis);
          const rawY = this.getPropertyValue(doc.properties, this.config.yAxis!);

          // Apply transforms for comparison
          const xMatch = Array.isArray(rawX)
            ? rawX.some(v => String(applyTransform(v, this.xTransformFn)) === String(xVal))
            : String(applyTransform(rawX, this.xTransformFn)) === String(xVal);
          const yMatch = Array.isArray(rawY)
            ? rawY.some(v => String(applyTransform(v, this.yTransformFn)) === String(yVal))
            : String(applyTransform(rawY, this.yTransformFn)) === String(yVal);

          return xMatch && yMatch;
        });

        if (matchingDocs.length > 0) {
          const dotsContainer = cell.createDiv({ cls: "hermine-board-items" });

          for (const doc of matchingDocs) {
            this.renderDocumentCard(dotsContainer, doc);
          }
        }
      }
    }

    // X-axis label (centered below data columns, inside the grid)
    if (this.config.xLabel) {
      board.createDiv(); // empty placeholder for y-header column
      const xLabelEl = board.createDiv({ cls: "hermine-axis-label-x" });
      xLabelEl.style.gridColumn = `span ${xValues.length}`;
      xLabelEl.createSpan({ text: this.config.xLabel });
    }

    // Show unassigned documents (missing or non-matching property values)
    this.renderUnassigned(xValues, yValues);

    // Refresh button
    this.renderRefreshButton();
  }

  /**
   * Render a document as a draggable card for the board view
   */
  private renderDocumentCard(container: HTMLElement, doc: DocumentData): void {
    const card = container.createDiv({ cls: "hermine-card" });

    // Evaluate custom card style
    const cardStyle = this.evaluateCardStyle(doc);

    // Color indicator bar
    const colorBar = card.createDiv({ cls: "hermine-card-color" });
    colorBar.style.backgroundColor = cardStyle.color || this.getDocumentColor(doc.name);

    // Apply additional card styles
    if (cardStyle.background) {
      card.style.backgroundColor = cardStyle.background;
    }
    if (cardStyle.border) {
      card.style.borderLeft = `3px solid ${cardStyle.border}`;
    }

    // Card content
    const content = card.createDiv({ cls: "hermine-card-content" });
    const titleSpan = content.createSpan({ cls: "hermine-card-title", text: doc.name });
    if (cardStyle.textColor) {
      titleSpan.style.color = cardStyle.textColor;
    }

    // Store document reference
    card.dataset.docPath = doc.path;

    // Make draggable (unless both axes are readonly)
    const fullyReadonly = this.config.xReadonly && this.config.yReadonly;
    card.draggable = !fullyReadonly;
    if (fullyReadonly) {
      card.style.cursor = "pointer";
    }

    // Drag start
    card.addEventListener("dragstart", (e) => {
      if (fullyReadonly) { e.preventDefault(); return; }
      this.currentDragDoc = doc;
      card.addClass("hermine-card-dragging");
      e.dataTransfer?.setData("text/plain", doc.path);

      // Determine the current cell position of this document
      const docX = this.getPropertyValue(doc.properties, this.config.xAxis);
      const docY = this.config.yAxis
        ? this.getPropertyValue(doc.properties, this.config.yAxis)
        : undefined;
      const docXStr = String(applyTransform(docX, this.xTransformFn));
      const docYStr = docY !== undefined
        ? String(applyTransform(docY, this.yTransformFn))
        : undefined;

      // Highlight only reachable drop zones
      this.containerEl.querySelectorAll(".hermine-board-cell").forEach((cell: Element) => {
        const el = cell as HTMLElement;
        const cellX = el.dataset.xValue;
        const cellY = el.dataset.yValue;

        const xAllowed = !this.config.xReadonly || cellX === docXStr;
        const yAllowed = !this.config.yReadonly || cellY === docYStr;

        if (xAllowed && yAllowed) {
          el.addClass("hermine-drop-zone-active");
        }
      });
    });

    // Drag end
    card.addEventListener("dragend", () => {
      this.currentDragDoc = null;
      card.removeClass("hermine-card-dragging");

      // Remove highlight from drop zones
      this.containerEl.querySelectorAll(".hermine-board-cell").forEach(cell => {
        cell.removeClass("hermine-drop-zone-active");
        cell.removeClass("hermine-drop-zone-hover");
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
    const wrapper = container.createDiv({ cls: "hermine-dot-wrapper" });

    // Create the colored dot
    const dot = wrapper.createDiv({ cls: "hermine-dot" });
    const color = this.getDocumentColor(doc.name);
    dot.style.backgroundColor = color;

    // Create the title label
    const title = wrapper.createSpan({ cls: "hermine-dot-title", text: doc.name });

    // Store document reference
    wrapper.dataset.docPath = doc.path;

    // Make draggable
    wrapper.draggable = true;

    // Drag start
    wrapper.addEventListener("dragstart", (e) => {
      this.currentDragDoc = doc;
      wrapper.addClass("hermine-dot-dragging");
      e.dataTransfer?.setData("text/plain", doc.path);

      // Highlight all drop zones
      this.containerEl.querySelectorAll(".hermine-matrix-cell").forEach(cell => {
        cell.addClass("hermine-drop-zone-active");
      });
    });

    // Drag end
    wrapper.addEventListener("dragend", () => {
      this.currentDragDoc = null;
      wrapper.removeClass("hermine-dot-dragging");

      // Remove highlight from drop zones
      this.containerEl.querySelectorAll(".hermine-matrix-cell").forEach(cell => {
        cell.removeClass("hermine-drop-zone-active");
        cell.removeClass("hermine-drop-zone-hover");
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
  private setupDropZone(cell: HTMLElement, xVal: any, yVal: any): void {
    cell.addEventListener("dragover", (e) => {
      // Only allow drop on reachable cells
      if (!cell.hasClass("hermine-drop-zone-active")) return;
      e.preventDefault();
      cell.addClass("hermine-drop-zone-hover");
    });

    cell.addEventListener("dragleave", () => {
      cell.removeClass("hermine-drop-zone-hover");
    });

    cell.addEventListener("drop", async (e) => {
      if (!cell.hasClass("hermine-drop-zone-active")) return;
      e.preventDefault();
      cell.removeClass("hermine-drop-zone-hover");

      if (!this.currentDragDoc) return;
      const doc = this.currentDragDoc;

      try {
        const updates: Record<string, any> = {};

        // Only update X-axis if not readonly
        if (!this.config.xReadonly) {
          const xWriteValue = await this.resolveDropValue(
            xVal, this.xTransformFn, this.xReverseMap, this.config.xAxis
          );
          if (xWriteValue === null) return; // User cancelled
          updates[this.config.xAxis] = xWriteValue;
        }

        // Only update Y-axis if not readonly
        if (!this.config.yReadonly) {
          const yWriteValue = await this.resolveDropValue(
            yVal, this.yTransformFn, this.yReverseMap, this.config.yAxis!
          );
          if (yWriteValue === null) return; // User cancelled
          updates[this.config.yAxis!] = yWriteValue;
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
    this.previewEl = document.body.createDiv({ cls: "hermine-preview" });

    // Header with document name
    const header = this.previewEl.createDiv({ cls: "hermine-preview-header" });
    header.createSpan({ text: doc.name, cls: "hermine-preview-title" });

    // Content container
    const content = this.previewEl.createDiv({ cls: "hermine-preview-content" });

    try {
      // Read the file content
      const fileContent = await this.app.vault.read(doc.file);

      // Remove frontmatter for display
      const contentWithoutFrontmatter = fileContent.replace(/^---[\s\S]*?---\n?/, "");

      // Limit content length for preview
      const previewContent = contentWithoutFrontmatter.slice(0, 1000);
      const truncated = contentWithoutFrontmatter.length > 1000;

      // Render markdown
      await MarkdownRenderer.render(
        this.app,
        previewContent + (truncated ? "\n\n*...*" : ""),
        content,
        doc.path,
        new Component()
      );
    } catch (error) {
      content.createSpan({ text: "Vorschau nicht verfügbar", cls: "hermine-preview-error" });
    }

    // Position the preview
    this.positionPreview(event);
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
      console.error("Hermine: card-style evaluation error for", doc.name, e);
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
    // Find documents that don't match any cell in the matrix
    const unassigned = this.result.documents.filter(doc => {
      const rawX = this.getPropertyValue(doc.properties, this.config.xAxis);
      const rawY = this.getPropertyValue(doc.properties, this.config.yAxis!);

      if (rawX === undefined || rawX === null || rawX === "" ||
          rawY === undefined || rawY === null || rawY === "") {
        return true;
      }

      const xMatches = xValues.some(xVal =>
        Array.isArray(rawX)
          ? rawX.some(v => String(applyTransform(v, this.xTransformFn)) === String(xVal))
          : String(applyTransform(rawX, this.xTransformFn)) === String(xVal)
      );
      const yMatches = yValues.some(yVal =>
        Array.isArray(rawY)
          ? rawY.some(v => String(applyTransform(v, this.yTransformFn)) === String(yVal))
          : String(applyTransform(rawY, this.yTransformFn)) === String(yVal)
      );

      return !xMatches || !yMatches;
    });

    if (unassigned.length === 0) return;

    const section = this.containerEl.createDiv({ cls: "hermine-unassigned" });
    section.createEl("strong", { text: "Nicht zugeordnet:" });

    const items = section.createDiv({ cls: "hermine-unassigned-items" });

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

    const wrapper = container.createDiv({ cls: "hermine-editable-wrapper" });

    // Display span
    const display = wrapper.createSpan({
      cls: "hermine-value-display",
      text: displayValue
    });

    // Edit input (hidden by default)
    const input = wrapper.createEl("input", {
      cls: "hermine-value-input",
      type: "text",
      value: displayValue
    });
    input.style.display = "none";

    if (compact) {
      const label = wrapper.createSpan({
        cls: "hermine-prop-label",
        text: `${propertyName}: `
      });
      wrapper.insertBefore(label, display);
    }

    // Edit button
    const editBtn = wrapper.createEl("button", { cls: "hermine-edit-btn" });
    setIcon(editBtn, "pencil");
    editBtn.title = "Bearbeiten";

    // Save button (hidden by default)
    const saveBtn = wrapper.createEl("button", { cls: "hermine-save-btn" });
    setIcon(saveBtn, "check");
    saveBtn.title = "Speichern";
    saveBtn.style.display = "none";

    // Cancel button (hidden by default)
    const cancelBtn = wrapper.createEl("button", { cls: "hermine-cancel-btn" });
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
          container.addClass("hermine-error-flash");
          setTimeout(() => container.removeClass("hermine-error-flash"), 500);
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
    const toolbar = this.containerEl.createDiv({ cls: "hermine-toolbar" });

    // Only show zoom controls for matrix/board view
    if (this.config.yAxis) {
      // Zoom controls container
      const zoomControls = toolbar.createDiv({ cls: "hermine-zoom-controls" });

      // Zoom out button
      const zoomOutBtn = zoomControls.createEl("button", { cls: "hermine-zoom-btn" });
      setIcon(zoomOutBtn, "minus");
      zoomOutBtn.title = "Verkleinern";
      zoomOutBtn.addEventListener("click", () => this.zoomOut());

      // Zoom display/reset
      this.zoomDisplay = zoomControls.createEl("button", {
        cls: "hermine-zoom-display",
        text: `${this.zoomLevel}%`
      });
      this.zoomDisplay.title = "Zoom zurücksetzen";
      this.zoomDisplay.addEventListener("click", () => this.resetZoom());

      // Zoom in button
      const zoomInBtn = zoomControls.createEl("button", { cls: "hermine-zoom-btn" });
      setIcon(zoomInBtn, "plus");
      zoomInBtn.title = "Vergrößern";
      zoomInBtn.addEventListener("click", () => this.zoomIn());

      // Zoom slider
      const slider = zoomControls.createEl("input", {
        cls: "hermine-zoom-slider",
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
      cls: "hermine-refresh-btn",
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
    const slider = this.containerEl.querySelector(".hermine-zoom-slider") as HTMLInputElement;
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
