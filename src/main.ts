import { App, Plugin, MarkdownPostProcessorContext, PluginSettingTab, Setting, TFolder } from "obsidian";
import { parseHermioneBlock } from "./parser";
import { QueryEngine } from "./query-engine";
import { MatrixRenderer } from "./matrix-renderer";
import { CanvasRenderer } from "./canvas-renderer";
import type { HermioneConfig } from "./types";
import { HermioneView, HERMIONE_VIEW_TYPE } from "./hermione-view";
import { t } from "./i18n";
import { parseTopicBlock, TopicRenderer } from "./topic";

interface HermioneSettings {
  refreshOnChange: boolean;
  defaultSort: "asc" | "desc";
}

const DEFAULT_SETTINGS: HermioneSettings = {
  refreshOnChange: true,
  defaultSort: "asc"
};

export default class HermionePlugin extends Plugin {
  settings: HermioneSettings;
  private queryEngine: QueryEngine;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.queryEngine = new QueryEngine(this.app);

    // Register the code block processor for "hermione" blocks
    this.registerMarkdownCodeBlockProcessor("hermione", this.processHermioneBlock.bind(this));

    // Register the code block processor for "hermione-topic" blocks (interactive slider)
    this.registerMarkdownCodeBlockProcessor("hermione-topic", (source, el, ctx) => {
      try {
        ctx.addChild(new TopicRenderer(el, this.app, parseTopicBlock(source), ctx, source));
      } catch (error) {
        el.createDiv({ cls: "hermione-error", text: t().renderer.error(error.message) });
      }
    });

    // Register dedicated .hermione file view
    this.registerView(HERMIONE_VIEW_TYPE, (leaf) => new HermioneView(leaf, this));
    this.registerExtensions(["hermione"], HERMIONE_VIEW_TYPE);

    // Ribbon icon to create a new Hermione document
    this.addRibbonIcon("grid-3x3", t().ribbon.createNew, async () => {
      await this.createHermioneFile();
    });

    // File explorer context menu for folders
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFolder) {
          menu.addItem((item) => {
            item.setTitle(t().contextMenu.newView)
              .setIcon("grid-3x3")
              .onClick(async () => {
                await this.createHermioneFile(file.path);
              });
          });
        }
      })
    );

    // Add settings tab
    this.addSettingTab(new HermioneSettingTab(this.app, this));

    console.log("Hermione plugin loaded");
  }

  onunload(): void {
    console.log("Hermione plugin unloaded");
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async createHermioneFile(folderPath?: string): Promise<void> {
    const folder = folderPath ?? (this.app.fileManager as any).getNewFileParent("")?.path ?? "";
    const baseName = t().file.newViewBaseName;
    const templateContent = t().file.templateContent;

    let fileName = folder ? `${folder}/${baseName}.hermione` : `${baseName}.hermione`;
    let counter = 1;
    while (this.app.vault.getAbstractFileByPath(fileName)) {
      fileName = folder
        ? `${folder}/${baseName} ${counter}.hermione`
        : `${baseName} ${counter}.hermione`;
      counter++;
    }

    const file = await this.app.vault.create(fileName, templateContent);
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
  }

  /**
   * Process a hermione code block
   */
  private async processHermioneBlock(
    source: string,
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext
  ): Promise<void> {
    try {
      // Parse the configuration from the code block
      const config = parseHermioneBlock(source);

      // Apply default sort if not specified
      if (!config.sort && (config.xAxis || config.yAxis)) {
        config.sort = {
          by: (config.xAxis || config.yAxis)!,
          order: this.settings.defaultSort
        };
      }

      // Execute the query
      const result = await this.queryEngine.execute(config);

      // Choose renderer class based on config
      const RendererClass = config.renderer === "html" ? MatrixRenderer : CanvasRenderer;

      // Create refresh callback
      const refresh = async () => {
        const newResult = await this.queryEngine.execute(config);
        el.empty();
        const renderer = new RendererClass(el, this.app, config, newResult, refresh);
        ctx.addChild(renderer);
      };

      // Render the view
      const renderer = new RendererClass(el, this.app, config, result, refresh);
      ctx.addChild(renderer);

    } catch (error) {
      // Show error message
      el.createDiv({
        cls: "hermione-error",
        text: t().renderer.error(error.message)
      });
    }
  }
}

/**
 * Settings tab for the Hermione plugin
 */
class HermioneSettingTab extends PluginSettingTab {
  plugin: HermionePlugin;

  constructor(app: App, plugin: HermionePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: t().settings.heading });

    new Setting(containerEl)
      .setName(t().settings.autoRefreshName)
      .setDesc(t().settings.autoRefreshDesc)
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.refreshOnChange)
        .onChange(async (value) => {
          this.plugin.settings.refreshOnChange = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t().settings.defaultSortName)
      .setDesc(t().settings.defaultSortDesc)
      .addDropdown(dropdown => dropdown
        .addOption("asc", t().settings.sortAsc)
        .addOption("desc", t().settings.sortDesc)
        .setValue(this.plugin.settings.defaultSort)
        .onChange(async (value: "asc" | "desc") => {
          this.plugin.settings.defaultSort = value;
          await this.plugin.saveSettings();
        }));

    // Usage instructions
    containerEl.createEl("h3", { text: t().settings.usageHeading });

    const usageEl = containerEl.createDiv({ cls: "hermione-settings-usage" });
    usageEl.innerHTML = `
      <p>Erstellen Sie einen Code-Block mit dem Typ <code>hermione</code>:</p>
      <pre><code>\`\`\`hermione
source: "Projekte"
x-achse: Status
y-achse: Priorität
display: Deadline, Verantwortlich
sort: Status asc
where: Status != "Abgeschlossen"
\`\`\`</code></pre>

      <h4>Konfigurationsoptionen:</h4>
      <ul>
        <li><strong>source / from / quelle</strong>: Quelle der Dokumente
          <ul>
            <li><code>"Ordnername"</code> - Dokumente aus einem Ordner</li>
            <li><code>#tag</code> - Dokumente mit einem bestimmten Tag</li>
            <li><code>all</code> oder <code>*</code> - Alle Dokumente</li>
          </ul>
        </li>
        <li><strong>x-achse / x / xaxis</strong>: Eigenschaft für die X-Achse (Pflicht)</li>
        <li><strong>y-achse / y / yaxis</strong>: Eigenschaft für die Y-Achse (Optional, erstellt Matrix-Ansicht)</li>
        <li><strong>display / anzeigen / show</strong>: Zusätzliche Eigenschaften zum Anzeigen (kommagetrennt)</li>
        <li><strong>sort / sortieren</strong>: Sortierung (<code>Eigenschaft asc/desc</code>)</li>
        <li><strong>where / filter</strong>: Filterbedingung</li>
      </ul>

      <h4>Filter-Syntax:</h4>
      <ul>
        <li><code>Eigenschaft = "Wert"</code></li>
        <li><code>Eigenschaft != "Wert"</code></li>
        <li><code>Eigenschaft contains "Teilwert"</code></li>
      </ul>
    `;
  }
}
