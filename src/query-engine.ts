import { App, TFile, TFolder, CachedMetadata, getAllTags } from "obsidian";
import { HermineConfig, DocumentData, QueryResult } from "./types";
import { compileTransform, applyTransform } from "./value-transform";

/**
 * Query engine for retrieving documents from the vault
 * Inspired by Dataview's query capabilities
 */
export class QueryEngine {
  constructor(private app: App) {}

  /**
   * Execute a query and return matching documents
   */
  async execute(config: HermineConfig): Promise<QueryResult> {
    const result: QueryResult = {
      documents: [],
      xAxisValues: new Set(),
      yAxisValues: new Set(),
      errors: []
    };

    try {
      // Get all matching files based on source
      const files = this.getSourceFiles(config.source);

      // Compile transforms if configured
      const xTransformFn = config.xTransform ? compileTransform(config.xTransform) : null;
      const yTransformFn = config.yTransform ? compileTransform(config.yTransform) : null;

      // Track raw values for reverse mapping
      const xRawValues: any[] = [];
      const yRawValues: any[] = [];

      // Process each file
      for (const file of files) {
        const docData = await this.getDocumentData(file);

        if (docData) {
          // Apply filter if specified
          if (config.where && !this.evaluateFilter(docData, config.where)) {
            continue;
          }

          result.documents.push(docData);

          // Collect X-axis values (apply transform for grouping)
          if (config.xAxis) {
            const xValue = this.getPropertyValue(docData.properties, config.xAxis);
            if (xValue !== undefined && xValue !== null) {
              if (Array.isArray(xValue)) {
                xValue.forEach(v => {
                  xRawValues.push(v);
                  result.xAxisValues.add(applyTransform(v, xTransformFn));
                });
              } else {
                xRawValues.push(xValue);
                result.xAxisValues.add(applyTransform(xValue, xTransformFn));
              }
            }
          }

          // Collect Y-axis values if specified (apply transform for grouping)
          if (config.yAxis) {
            const yValue = this.getPropertyValue(docData.properties, config.yAxis);
            if (yValue !== undefined && yValue !== null) {
              if (Array.isArray(yValue)) {
                yValue.forEach(v => {
                  yRawValues.push(v);
                  result.yAxisValues.add(applyTransform(v, yTransformFn));
                });
              } else {
                yRawValues.push(yValue);
                result.yAxisValues.add(applyTransform(yValue, yTransformFn));
              }
            }
          }
        }
      }

      // Apply JS filter function if specified
      if (config.filter) {
        try {
          const filterFn = new Function("docs", `return (${config.filter})(docs)`);
          const filtered = filterFn(result.documents);
          if (Array.isArray(filtered)) {
            result.documents = filtered;
            // Recalculate axis values from filtered documents
            result.xAxisValues.clear();
            result.yAxisValues.clear();
            xRawValues.length = 0;
            yRawValues.length = 0;
            for (const doc of result.documents) {
              if (config.xAxis) {
                const xValue = this.getPropertyValue(doc.properties, config.xAxis);
                if (xValue !== undefined && xValue !== null) {
                  if (Array.isArray(xValue)) {
                    xValue.forEach(v => {
                      xRawValues.push(v);
                      result.xAxisValues.add(applyTransform(v, xTransformFn));
                    });
                  } else {
                    xRawValues.push(xValue);
                    result.xAxisValues.add(applyTransform(xValue, xTransformFn));
                  }
                }
              }
              if (config.yAxis) {
                const yValue = this.getPropertyValue(doc.properties, config.yAxis);
                if (yValue !== undefined && yValue !== null) {
                  if (Array.isArray(yValue)) {
                    yValue.forEach(v => {
                      yRawValues.push(v);
                      result.yAxisValues.add(applyTransform(v, yTransformFn));
                    });
                  } else {
                    yRawValues.push(yValue);
                    result.yAxisValues.add(applyTransform(yValue, yTransformFn));
                  }
                }
              }
            }
          }
        } catch (e) {
          result.errors.push(`Filter error: ${e.message}`);
        }
      }

      // Attach raw values for reverse mapping
      result.xAxisRawValues = xRawValues;
      result.yAxisRawValues = yRawValues;

      // Sort documents if specified
      if (config.sort) {
        result.documents = this.sortDocuments(result.documents, config.sort);
      }

    } catch (error) {
      result.errors.push(`Query error: ${error.message}`);
    }

    return result;
  }

  /**
   * Get files matching the source specification
   */
  private getSourceFiles(source: string): TFile[] {
    const files: TFile[] = [];
    const vault = this.app.vault;

    // Handle different source types
    if (source === "all" || source === "alle" || source === "*") {
      // All markdown files
      return vault.getMarkdownFiles();
    }

    if (source.startsWith("#")) {
      // Tag-based query
      const tag = source.toLowerCase();
      for (const file of vault.getMarkdownFiles()) {
        const cache = this.app.metadataCache.getFileCache(file);
        if (cache) {
          const tags = getAllTags(cache) || [];
          if (tags.some(t => t.toLowerCase() === tag || t.toLowerCase().startsWith(tag + "/"))) {
            files.push(file);
          }
        }
      }
      return files;
    }

    if (source.startsWith('"') && source.endsWith('"')) {
      // Folder path in quotes
      const folderPath = source.slice(1, -1);
      return this.getFilesFromFolder(folderPath);
    }

    // Assume it's a folder path
    return this.getFilesFromFolder(source);
  }

  /**
   * Get all markdown files from a folder (recursive)
   */
  private getFilesFromFolder(folderPath: string): TFile[] {
    const files: TFile[] = [];
    const folder = this.app.vault.getAbstractFileByPath(folderPath);

    if (folder instanceof TFolder) {
      this.collectFilesRecursive(folder, files);
    }

    return files;
  }

  /**
   * Recursively collect markdown files from a folder
   */
  private collectFilesRecursive(folder: TFolder, files: TFile[]): void {
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === "md") {
        files.push(child);
      } else if (child instanceof TFolder) {
        this.collectFilesRecursive(child, files);
      }
    }
  }

  /**
   * Get document data including frontmatter properties
   */
  async getDocumentData(file: TFile): Promise<DocumentData | null> {
    const cache = this.app.metadataCache.getFileCache(file);

    if (!cache) {
      return null;
    }

    const properties: Record<string, any> = {};

    // Get frontmatter properties
    if (cache.frontmatter) {
      Object.assign(properties, cache.frontmatter);
    }

    // Add file metadata as special properties
    properties["file.name"] = file.basename;
    properties["file.path"] = file.path;
    properties["file.ctime"] = file.stat.ctime;
    properties["file.mtime"] = file.stat.mtime;
    properties["file.size"] = file.stat.size;

    // Get tags
    const tags = getAllTags(cache) || [];
    properties["file.tags"] = tags;

    return {
      file,
      path: file.path,
      name: file.basename,
      properties
    };
  }

  /**
   * Get a property value, supporting nested paths like "author.name"
   */
  private getPropertyValue(properties: Record<string, any>, path: string): any {
    const parts = path.split(".");
    let value = properties;

    for (const part of parts) {
      if (value === null || value === undefined) {
        return undefined;
      }
      value = value[part];
    }

    return value;
  }

  /**
   * Evaluate a simple filter expression
   * Supports: property = value, property != value, property contains value
   */
  private evaluateFilter(doc: DocumentData, filter: string): boolean {
    // Simple filter parsing
    const containsMatch = filter.match(/(\S+)\s+contains\s+"([^"]+)"/i);
    if (containsMatch) {
      const [, prop, value] = containsMatch;
      const propValue = this.getPropertyValue(doc.properties, prop);
      if (Array.isArray(propValue)) {
        return propValue.some(v => String(v).includes(value));
      }
      return String(propValue || "").includes(value);
    }

    const equalsMatch = filter.match(/(\S+)\s*(!?=)\s*"([^"]+)"/);
    if (equalsMatch) {
      const [, prop, operator, value] = equalsMatch;
      const propValue = this.getPropertyValue(doc.properties, prop);
      const isEqual = String(propValue) === value;
      return operator === "!=" ? !isEqual : isEqual;
    }

    return true; // If filter can't be parsed, include the document
  }

  /**
   * Sort documents by a property
   */
  private sortDocuments(
    documents: DocumentData[],
    sort: { by: string; order: "asc" | "desc" }
  ): DocumentData[] {
    return [...documents].sort((a, b) => {
      const aVal = this.getPropertyValue(a.properties, sort.by);
      const bVal = this.getPropertyValue(b.properties, sort.by);

      let comparison = 0;
      if (aVal < bVal) comparison = -1;
      if (aVal > bVal) comparison = 1;

      return sort.order === "desc" ? -comparison : comparison;
    });
  }
}
