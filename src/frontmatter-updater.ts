import { App, TFile } from "obsidian";

/**
 * Handles updating frontmatter properties in markdown files
 */
export class FrontmatterUpdater {
  constructor(private app: App) {}

  /**
   * Update a single property in a file's frontmatter
   */
  async updateProperty(file: TFile, propertyName: string, newValue: any): Promise<void> {
    await this.updateProperties(file, { [propertyName]: newValue });
  }

  /**
   * Update multiple properties in a file's frontmatter.
   * Uses Obsidian's processFrontMatter, which creates the frontmatter if
   * needed, handles CRLF line endings and writes valid YAML for all value types.
   */
  async updateProperties(file: TFile, updates: Record<string, any>): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      Object.assign(fm, updates);
    });
  }

  /**
   * Parse a value from string input to appropriate type
   */
  parseValue(input: string, originalValue: any): any {
    const trimmed = input.trim();

    // Try to match the original type
    if (typeof originalValue === "boolean") {
      return trimmed.toLowerCase() === "true" || trimmed === "1" || trimmed.toLowerCase() === "yes";
    }

    if (typeof originalValue === "number") {
      const num = parseFloat(trimmed);
      return isNaN(num) ? trimmed : num;
    }

    if (Array.isArray(originalValue)) {
      // Parse comma-separated values
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        try {
          return JSON.parse(trimmed);
        } catch {
          // Fall through to comma-separated parsing
        }
      }
      return trimmed.split(",").map(s => s.trim()).filter(s => s);
    }

    // Check for boolean-like strings
    if (trimmed.toLowerCase() === "true" || trimmed.toLowerCase() === "yes") {
      return true;
    }
    if (trimmed.toLowerCase() === "false" || trimmed.toLowerCase() === "no") {
      return false;
    }

    // Check for number
    const numValue = parseFloat(trimmed);
    if (!isNaN(numValue) && String(numValue) === trimmed) {
      return numValue;
    }

    return trimmed;
  }
}
