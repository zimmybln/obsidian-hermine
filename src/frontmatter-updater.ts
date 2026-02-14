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
    const content = await this.app.vault.read(file);
    const updatedContent = this.updateFrontmatterProperty(content, propertyName, newValue);
    await this.app.vault.modify(file, updatedContent);
  }

  /**
   * Update multiple properties in a file's frontmatter
   */
  async updateProperties(file: TFile, updates: Record<string, any>): Promise<void> {
    let content = await this.app.vault.read(file);

    for (const [propertyName, newValue] of Object.entries(updates)) {
      content = this.updateFrontmatterProperty(content, propertyName, newValue);
    }

    await this.app.vault.modify(file, content);
  }

  /**
   * Update a property in the frontmatter content
   */
  private updateFrontmatterProperty(content: string, propertyName: string, newValue: any): string {
    const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
    const match = content.match(frontmatterRegex);

    if (!match) {
      // No frontmatter exists, create it
      const formattedValue = this.formatYamlValue(newValue);
      return `---\n${propertyName}: ${formattedValue}\n---\n\n${content}`;
    }

    const frontmatterContent = match[1];
    const lines = frontmatterContent.split("\n");
    let propertyFound = false;
    let inMultilineValue = false;
    let currentIndent = 0;

    const updatedLines = lines.map((line, index) => {
      // Check if we're in a multiline value (list or nested object)
      const lineIndent = line.search(/\S/);
      if (lineIndent === -1) return line; // Empty line

      if (inMultilineValue) {
        if (lineIndent > currentIndent || line.trim().startsWith("-")) {
          return null; // Skip this line, it will be replaced
        } else {
          inMultilineValue = false;
        }
      }

      // Check if this line starts the property we want to update
      const propMatch = line.match(/^(\s*)([^:]+):\s*(.*)/);
      if (propMatch) {
        const [, indent, name, value] = propMatch;
        if (name.trim() === propertyName) {
          propertyFound = true;
          const formattedValue = this.formatYamlValue(newValue);

          // Check if this is a multiline value (array or object)
          if (Array.isArray(newValue)) {
            inMultilineValue = true;
            currentIndent = indent.length;
            if (newValue.length === 0) {
              return `${indent}${propertyName}: []`;
            }
            const listItems = newValue.map(v => `${indent}  - ${this.formatYamlValue(v)}`).join("\n");
            return `${indent}${propertyName}:\n${listItems}`;
          }

          return `${indent}${propertyName}: ${formattedValue}`;
        }
      }

      return line;
    }).filter(line => line !== null);

    // If property wasn't found, add it
    if (!propertyFound) {
      const formattedValue = this.formatYamlValue(newValue);
      if (Array.isArray(newValue) && newValue.length > 0) {
        const listItems = newValue.map(v => `  - ${this.formatYamlValue(v)}`).join("\n");
        updatedLines.push(`${propertyName}:\n${listItems}`);
      } else {
        updatedLines.push(`${propertyName}: ${formattedValue}`);
      }
    }

    const updatedFrontmatter = updatedLines.join("\n");
    return content.replace(frontmatterRegex, `---\n${updatedFrontmatter}\n---`);
  }

  /**
   * Format a value for YAML
   */
  private formatYamlValue(value: any): string {
    if (value === null || value === undefined) {
      return "";
    }

    if (typeof value === "boolean") {
      return value ? "true" : "false";
    }

    if (typeof value === "number") {
      return String(value);
    }

    if (typeof value === "string") {
      // Check if string needs quoting
      if (
        value === "" ||
        value.includes(":") ||
        value.includes("#") ||
        value.includes("'") ||
        value.includes('"') ||
        value.includes("\n") ||
        value.startsWith(" ") ||
        value.endsWith(" ") ||
        /^[0-9]/.test(value) ||
        ["true", "false", "null", "yes", "no"].includes(value.toLowerCase())
      ) {
        // Use double quotes and escape internal quotes
        return `"${value.replace(/"/g, '\\"')}"`;
      }
      return value;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        return "[]";
      }
      // Arrays are handled in updateFrontmatterProperty
      return `[${value.map(v => this.formatYamlValue(v)).join(", ")}]`;
    }

    if (typeof value === "object") {
      // Simple inline object
      const entries = Object.entries(value)
        .map(([k, v]) => `${k}: ${this.formatYamlValue(v)}`)
        .join(", ");
      return `{${entries}}`;
    }

    return String(value);
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
