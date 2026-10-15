import { TextFileView, WorkspaceLeaf, setIcon, MarkdownRenderChild, Notice } from "obsidian";
import { t } from "./i18n";
import { parseHermioneBlock } from "./parser";
import { QueryEngine } from "./query-engine";
import { MatrixRenderer } from "./matrix-renderer";
import { CanvasRenderer } from "./canvas-renderer";
import type HermionePlugin from "./main";

export const HERMIONE_VIEW_TYPE = "hermione-view";

export class HermioneView extends TextFileView {
  private queryEngine: QueryEngine;
  private isEditMode = false;

  // DOM elements
  private toolbar: HTMLElement;
  private toggleBtn: HTMLButtonElement;
  private titleEl: HTMLElement;
  private editorContainer: HTMLElement;
  private textArea: HTMLTextAreaElement;
  private viewContainer: HTMLElement;

  // Renderer state
  private currentRenderer: MarkdownRenderChild | null = null;
  private currentData = "";

  constructor(leaf: WorkspaceLeaf, private plugin: HermionePlugin) {
    super(leaf);
    this.queryEngine = new QueryEngine(this.app);
  }

  getViewType(): string {
    return HERMIONE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file?.basename ?? "Hermione";
  }

  getIcon(): string {
    return "grid-3x3";
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("hermione-dedicated-view");

    // Toolbar
    this.toolbar = contentEl.createDiv({ cls: "hermione-view-toolbar" });

    this.toggleBtn = this.toolbar.createEl("button", { cls: "hermione-view-btn", attr: { "aria-label": t().view.edit } });
    setIcon(this.toggleBtn, "pencil");
    this.toggleBtn.addEventListener("click", () => this.toggleMode());

    const refreshBtn = this.toolbar.createEl("button", { cls: "hermione-view-btn", attr: { "aria-label": t().view.refresh } });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", () => this.renderVisualization());

    this.titleEl = this.toolbar.createDiv({ cls: "hermione-view-toolbar-title", text: this.file?.basename ?? "Hermione", attr: { title: t().view.renameTitle } });
    this.titleEl.addEventListener("click", () => this.startRename());

    // Editor (hidden by default)
    this.editorContainer = contentEl.createDiv({ cls: "hermione-view-editor" });
    this.editorContainer.hide();
    this.textArea = this.editorContainer.createEl("textarea", {
      attr: { spellcheck: "false" }
    });

    // View container
    this.viewContainer = contentEl.createDiv({ cls: "hermione-view-content" });
  }

  async onClose(): Promise<void> {
    this.cleanupRenderer();
  }

  getViewData(): string {
    return this.currentData;
  }

  setViewData(data: string, _clear: boolean): void {
    this.currentData = data;
    if (this.isEditMode) {
      this.textArea.value = data;
    } else {
      this.renderVisualization();
    }
    // Update title
    if (this.titleEl) this.titleEl.textContent = this.file?.basename ?? "Hermione";
  }

  clear(): void {
    this.currentData = "";
    this.cleanupRenderer();
    if (this.viewContainer) this.viewContainer.empty();
    if (this.textArea) this.textArea.value = "";
  }

  private toggleMode(): void {
    this.isEditMode = !this.isEditMode;

    if (this.isEditMode) {
      this.textArea.value = this.currentData;
      this.editorContainer.show();
      this.viewContainer.hide();
      this.textArea.focus();
      setIcon(this.toggleBtn, "eye");
      this.toggleBtn.setAttribute("aria-label", t().view.preview);
    } else {
      const newData = this.textArea.value;
      if (newData !== this.currentData) {
        this.currentData = newData;
        this.requestSave();
      }
      this.editorContainer.hide();
      this.viewContainer.show();
      setIcon(this.toggleBtn, "pencil");
      this.toggleBtn.setAttribute("aria-label", t().view.edit);
      this.renderVisualization();
    }
  }

  private startRename(): void {
    if (!this.file) return;
    const currentName = this.file.basename;

    const input = document.createElement("input");
    input.type = "text";
    input.value = currentName;
    input.className = "hermione-view-rename-input";

    this.titleEl.empty();
    this.titleEl.appendChild(input);
    input.focus();
    input.select();

    const commit = async () => {
      const newName = input.value.trim();
      if (!newName || newName === currentName) {
        this.titleEl.textContent = currentName;
        return;
      }
      const newPath = this.file!.path.replace(/[^/\\]+\.hermione$/, `${newName}.hermione`);
      try {
        await this.app.fileManager.renameFile(this.file!, newPath);
        // titleEl is updated via setViewData after the rename
      } catch (e: any) {
        new Notice(t().view.renameError(e.message));
        this.titleEl.textContent = currentName;
      }
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { this.titleEl.textContent = currentName; }
    });
    input.addEventListener("blur", commit);
  }

  private cleanupRenderer(): void {
    if (this.currentRenderer) {
      this.currentRenderer.unload();
      this.currentRenderer = null;
    }
  }

  private async renderVisualization(): Promise<void> {
    this.cleanupRenderer();
    this.viewContainer.empty();

    if (!this.currentData.trim()) {
      this.viewContainer.createDiv({
        cls: "hermione-empty",
        text: t().view.empty
      });
      return;
    }

    try {
      const config = parseHermioneBlock(this.currentData);

      if (!config.sort && (config.xAxis || config.yAxis)) {
        config.sort = {
          by: (config.xAxis || config.yAxis)!,
          order: this.plugin.settings.defaultSort
        };
      }

      const result = await this.queryEngine.execute(config);

      const RendererClass = config.renderer === "canvas" ? CanvasRenderer : MatrixRenderer;

      const refresh = async () => {
        const newResult = await this.queryEngine.execute(config);
        this.viewContainer.empty();
        this.currentRenderer = new RendererClass(this.viewContainer, this.app, config, newResult, refresh);
        this.currentRenderer.load();
      };

      this.currentRenderer = new RendererClass(this.viewContainer, this.app, config, result, refresh);
      this.currentRenderer.load();
    } catch (error: any) {
      this.viewContainer.createDiv({
        cls: "hermione-error",
        text: t().renderer.error(error.message)
      });
    }
  }
}
