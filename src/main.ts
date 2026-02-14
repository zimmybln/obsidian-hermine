import { App, Plugin, MarkdownPostProcessorContext, PluginSettingTab, Setting } from "obsidian";
import { parseHermineBlock } from "./parser";
import { QueryEngine } from "./query-engine";
import { MatrixRenderer } from "./matrix-renderer";
import { HermineConfig } from "./types";

interface HermineSettings {
  refreshOnChange: boolean;
  defaultSort: "asc" | "desc";
}

const DEFAULT_SETTINGS: HermineSettings = {
  refreshOnChange: true,
  defaultSort: "asc"
};

export default class HerminePlugin extends Plugin {
  settings: HermineSettings;
  private queryEngine: QueryEngine;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.queryEngine = new QueryEngine(this.app);

    // Register the code block processor for "hermine" blocks
    this.registerMarkdownCodeBlockProcessor("hermine", this.processHermineBlock.bind(this));

    // Add settings tab
    this.addSettingTab(new HermineSettingTab(this.app, this));

    console.log("Hermine plugin loaded");
  }

  onunload(): void {
    console.log("Hermine plugin unloaded");
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * Process a hermine code block
   */
  private async processHermineBlock(
    source: string,
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext
  ): Promise<void> {
    try {
      // Parse the configuration from the code block
      const config = parseHermineBlock(source);

      // Apply default sort if not specified
      if (!config.sort && (config.xAxis || config.yAxis)) {
        config.sort = {
          by: (config.xAxis || config.yAxis)!,
          order: this.settings.defaultSort
        };
      }

      // Execute the query
      const result = await this.queryEngine.execute(config);

      // Create refresh callback
      const refresh = async () => {
        const newResult = await this.queryEngine.execute(config);
        el.empty();
        const renderer = new MatrixRenderer(el, this.app, config, newResult, refresh);
        ctx.addChild(renderer);
      };

      // Render the matrix view
      const renderer = new MatrixRenderer(el, this.app, config, result, refresh);
      ctx.addChild(renderer);

    } catch (error) {
      // Show error message
      el.createDiv({
        cls: "hermine-error",
        text: `Hermine Error: ${error.message}`
      });
    }
  }
}

/**
 * Settings tab for the Hermine plugin
 */
class HermineSettingTab extends PluginSettingTab {
  plugin: HerminePlugin;

  constructor(app: App, plugin: HerminePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Hermine Einstellungen" });

    new Setting(containerEl)
      .setName("Automatisch aktualisieren")
      .setDesc("Aktualisiert die Ansicht automatisch, wenn Dokumente geändert werden")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.refreshOnChange)
        .onChange(async (value) => {
          this.plugin.settings.refreshOnChange = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Standard-Sortierung")
      .setDesc("Standard-Sortierrichtung für Abfragen")
      .addDropdown(dropdown => dropdown
        .addOption("asc", "Aufsteigend")
        .addOption("desc", "Absteigend")
        .setValue(this.plugin.settings.defaultSort)
        .onChange(async (value: "asc" | "desc") => {
          this.plugin.settings.defaultSort = value;
          await this.plugin.saveSettings();
        }));

    // Usage instructions
    containerEl.createEl("h3", { text: "Verwendung" });

    const usageEl = containerEl.createDiv({ cls: "hermine-settings-usage" });
    usageEl.innerHTML = `
      <p>Erstellen Sie einen Code-Block mit dem Typ <code>hermine</code>:</p>
      <pre><code>\`\`\`hermine
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
