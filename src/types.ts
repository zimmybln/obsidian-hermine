import { TFile } from "obsidian";

/**
 * Configuration for a Hermine query block
 */
export interface HermineConfig {
  /** Title displayed at the top of the view */
  title?: string;
  /** Source query - folder path, tag, or special query like "all" */
  source: string;
  /** Property name for X-axis values */
  xAxis: string;
  /** Property name for Y-axis values (optional) */
  yAxis?: string;
  /** Predefined values for X-axis (optional, defines order and available values) */
  xValues?: string[];
  /** Predefined values for Y-axis (optional, defines order and available values) */
  yValues?: string[];
  /** Additional properties to display */
  display?: string[];
  /** Sort configuration */
  sort?: {
    by: string;
    order: "asc" | "desc";
  };
  /** Filter expression */
  where?: string;
  /** Label for the X-axis */
  xLabel?: string;
  /** Label for the Y-axis */
  yLabel?: string;
  /** Prevent dragging along the X-axis */
  xReadonly?: boolean;
  /** Prevent dragging along the Y-axis */
  yReadonly?: boolean;
  /** JavaScript arrow function to customize card appearance based on properties */
  cardStyle?: string;
  /** JavaScript arrow function to transform X-axis values for grouping */
  xTransform?: string;
  /** JavaScript arrow function to transform Y-axis values for grouping */
  yTransform?: string;
}

/**
 * Represents a single document with its properties
 */
export interface DocumentData {
  file: TFile;
  path: string;
  name: string;
  properties: Record<string, any>;
}

/**
 * Result of a query execution
 */
export interface QueryResult {
  documents: DocumentData[];
  xAxisValues: Set<any>;
  yAxisValues: Set<any>;
  errors: string[];
  /** Raw values before transform (populated when transforms are active) */
  xAxisRawValues?: any[];
  yAxisRawValues?: any[];
}

/**
 * Cell data in the matrix view
 */
export interface MatrixCell {
  document: DocumentData;
  xValue: any;
  yValue: any;
  displayValues: Record<string, any>;
}

/**
 * Parsed frontmatter with position info for updates
 */
export interface FrontmatterInfo {
  data: Record<string, any>;
  position: {
    start: number;
    end: number;
  };
}
