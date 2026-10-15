/**
 * Hermione Plugin – Internationalization
 * Supports German (de) and English (en).
 * Language is auto-detected from Obsidian's Moment.js locale.
 */

export interface Strings {
  ribbon: {
    createNew: string;
  };
  contextMenu: {
    newView: string;
  };
  file: {
    newViewBaseName: string;
    templateContent: string;
  };
  settings: {
    heading: string;
    autoRefreshName: string;
    autoRefreshDesc: string;
    defaultSortName: string;
    defaultSortDesc: string;
    sortAsc: string;
    sortDesc: string;
    usageHeading: string;
  };
  view: {
    edit: string;
    preview: string;
    refresh: string;
    renameTitle: string;
    empty: string;
    errorPrefix: string;
    renameError: (msg: string) => string;
  };
  renderer: {
    noDocuments: string;
    unassigned: string;
    previewUnavailable: string;
    editTitle: string;
    saveTitle: string;
    cancelTitle: string;
    refreshBtn: string;
    zoomIn: string;
    zoomOut: string;
    zoomReset: string;
    zoomSlider: string;
    error: (msg: string) => string;
  };
  parser: {
    sourceRequired: string;
    xAxisRequired: string;
  };
  query: {
    filterError: (msg: string) => string;
    queryError: (msg: string) => string;
  };
  valuePicker: {
    heading: (axisName: string) => string;
    targetGroup: (groupLabel: string) => string;
    placeholder: string;
    existingValues: string;
    confirm: string;
    cancel: string;
    valid: (raw: string, transformed: string) => string;
    invalid: (raw: string, transformed: string, groupLabel: string) => string;
  };
  exactValue: {
    heading: (axisName: string) => string;
    range: (min: number, max: number) => string;
    enterNumber: string;
    outOfRange: (min: number, max: number) => string;
    valueLabel: (num: number) => string;
    confirm: string;
    cancel: string;
  };
  topic: {
    minRequired: string;
    maxRequired: string;
    minGreaterMax: string;
    notANumber: (key: string, raw: string) => string;
    invalidSteps: (raw: string) => string;
    unknownScale: (raw: string) => string;
    xAxisRequired: string;
    newDocBaseName: string;
    created: (name: string) => string;
    sourceNotFolder: (source: string) => string;
    docTooltip: (name: string, value: number) => string;
    notNumeric: (count: number, prop: string) => string;
    outOfRange: (count: number) => string;
  };
}

const de: Strings = {
  ribbon: {
    createNew: "Neue Hermione-Ansicht erstellen",
  },
  contextMenu: {
    newView: "Neue Hermione-Ansicht 2",
  },
  file: {
    newViewBaseName: "Neue Hermione-Ansicht",
    templateContent: "source:\nx-achse:\ny-achse:\n",
  },
  settings: {
    heading: "Hermione Einstellungen",
    autoRefreshName: "Automatisch aktualisieren",
    autoRefreshDesc: "Aktualisiert die Ansicht automatisch, wenn Dokumente geändert werden",
    defaultSortName: "Standard-Sortierung",
    defaultSortDesc: "Standard-Sortierrichtung für Abfragen",
    sortAsc: "Aufsteigend",
    sortDesc: "Absteigend",
    usageHeading: "Verwendung",
  },
  view: {
    edit: "Bearbeiten",
    preview: "Vorschau",
    refresh: "Aktualisieren",
    renameTitle: "Klicken zum Umbenennen",
    empty: "Keine Konfiguration vorhanden. Klicke auf den Bleistift-Button, um die Hermione-Konfiguration zu bearbeiten.",
    errorPrefix: "Hermione Fehler: ",
    renameError: (msg) => `Umbenennen fehlgeschlagen: ${msg}`,
  },
  renderer: {
    noDocuments: "Keine Dokumente gefunden.",
    unassigned: "Nicht zugeordnet:",
    previewUnavailable: "Vorschau nicht verfügbar",
    editTitle: "Bearbeiten",
    saveTitle: "Speichern",
    cancelTitle: "Abbrechen",
    refreshBtn: "Aktualisieren",
    zoomIn: "Vergrößern",
    zoomOut: "Verkleinern",
    zoomReset: "Zoom zurücksetzen",
    zoomSlider: "Zoom",
    error: (msg) => `Hermione Fehler: ${msg}`,
  },
  parser: {
    sourceRequired: "Quelle (source) ist erforderlich",
    xAxisRequired: "X-Achsen-Eigenschaft (x-achse) ist erforderlich",
  },
  query: {
    filterError: (msg) => `Filterfehler: ${msg}`,
    queryError: (msg) => `Abfragefehler: ${msg}`,
  },
  valuePicker: {
    heading: (axisName) => `Wert für "${axisName}" wählen`,
    targetGroup: (groupLabel) => `Zielgruppe: ${groupLabel}`,
    placeholder: "Wert eingeben...",
    existingValues: "Vorhandene Werte:",
    confirm: "Übernehmen",
    cancel: "Abbrechen",
    valid: (raw, transformed) => `✓ Wert ${raw} → Gruppe "${transformed}"`,
    invalid: (raw, transformed, groupLabel) =>
      `✗ Wert ${raw} gehört zu Gruppe "${transformed}", nicht "${groupLabel}"`,
  },
  exactValue: {
    heading: (axisName) => `Exakter Wert für "${axisName}"`,
    range: (min, max) => `Bereich: ${min} – ${max}`,
    enterNumber: "Bitte eine Zahl eingeben",
    outOfRange: (min, max) => `Wert muss zwischen ${min} und ${max} liegen`,
    valueLabel: (num) => `Wert: ${num}`,
    confirm: "Übernehmen",
    cancel: "Abbrechen",
  },  topic: {
    minRequired: "Minimalwert (min) ist erforderlich",
    maxRequired: "Maximalwert (max) ist erforderlich",
    minGreaterMax: "Minimalwert muss kleiner als der Maximalwert sein",
    notANumber: (key, raw) => `"${key}" erwartet eine Zahl, erhalten: "${raw}"`,
    invalidSteps: (raw) => `Schritte müssen eine ganze Zahl ≥ 1 sein, erhalten: "${raw}"`,
    unknownScale: (raw) => `Unbekannte Skala: "${raw}" (erlaubt: direkt)`,
    xAxisRequired: "Mit source muss auch x-achse (Eigenschaft der Dokumente) angegeben werden",
    newDocBaseName: "Dokument",
    created: (name) => `"${name}" erstellt`,
    sourceNotFolder: (source) => `Neue Dokumente benötigen ein Verzeichnis als Quelle, nicht "${source}"`,
    docTooltip: (name, value) => `${name}: ${value}`,
    notNumeric: (count, prop) =>
      `${count} ${count === 1 ? "Dokument hat" : "Dokumente haben"} keinen Zahlenwert in "${prop}"`,
    outOfRange: (count) =>
      `${count} ${count === 1 ? "Dokument liegt" : "Dokumente liegen"} außerhalb der Skala`,
  },
};

const en: Strings = {
  ribbon: {
    createNew: "Create new Hermione view",
  },
  contextMenu: {
    newView: "New Hermione view",
  },
  file: {
    newViewBaseName: "New Hermione View",
    templateContent: "source:\nx-axis:\ny-axis:\n",
  },
  settings: {
    heading: "Hermione Settings",
    autoRefreshName: "Auto-refresh",
    autoRefreshDesc: "Automatically refreshes the view when documents change",
    defaultSortName: "Default sort",
    defaultSortDesc: "Default sort direction for queries",
    sortAsc: "Ascending",
    sortDesc: "Descending",
    usageHeading: "Usage",
  },
  view: {
    edit: "Edit",
    preview: "Preview",
    refresh: "Refresh",
    renameTitle: "Click to rename",
    empty: "No configuration found. Click the pencil button to edit the Hermione configuration.",
    errorPrefix: "Hermione Error: ",
    renameError: (msg) => `Rename failed: ${msg}`,
  },
  renderer: {
    noDocuments: "No documents found.",
    unassigned: "Unassigned:",
    previewUnavailable: "Preview not available",
    editTitle: "Edit",
    saveTitle: "Save",
    cancelTitle: "Cancel",
    refreshBtn: "Refresh",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    zoomReset: "Reset zoom",
    zoomSlider: "Zoom",
    error: (msg) => `Hermione Error: ${msg}`,
  },
  parser: {
    sourceRequired: "Source is required",
    xAxisRequired: "X-Axis property is required",
  },
  query: {
    filterError: (msg) => `Filter error: ${msg}`,
    queryError: (msg) => `Query error: ${msg}`,
  },
  valuePicker: {
    heading: (axisName) => `Choose value for "${axisName}"`,
    targetGroup: (groupLabel) => `Target group: ${groupLabel}`,
    placeholder: "Enter value...",
    existingValues: "Existing values:",
    confirm: "Apply",
    cancel: "Cancel",
    valid: (raw, transformed) => `✓ Value ${raw} → group "${transformed}"`,
    invalid: (raw, transformed, groupLabel) =>
      `✗ Value ${raw} belongs to group "${transformed}", not "${groupLabel}"`,
  },
  exactValue: {
    heading: (axisName) => `Exact value for "${axisName}"`,
    range: (min, max) => `Range: ${min} – ${max}`,
    enterNumber: "Please enter a number",
    outOfRange: (min, max) => `Value must be between ${min} and ${max}`,
    valueLabel: (num) => `Value: ${num}`,
    confirm: "Apply",
    cancel: "Cancel",
  },  topic: {
    minRequired: "Minimum value (min) is required",
    maxRequired: "Maximum value (max) is required",
    minGreaterMax: "Minimum must be less than maximum",
    notANumber: (key, raw) => `"${key}" expects a number, got: "${raw}"`,
    invalidSteps: (raw) => `Steps must be an integer ≥ 1, got: "${raw}"`,
    unknownScale: (raw) => `Unknown scale: "${raw}" (allowed: direct)`,
    xAxisRequired: "When source is set, x-axis (document property) is required",
    newDocBaseName: "Document",
    created: (name) => `"${name}" created`,
    sourceNotFolder: (source) => `New documents require a folder as source, not "${source}"`,
    docTooltip: (name, value) => `${name}: ${value}`,
    notNumeric: (count, prop) =>
      `${count} ${count === 1 ? "document has" : "documents have"} no numeric value in "${prop}"`,
    outOfRange: (count) =>
      `${count} ${count === 1 ? "document lies" : "documents lie"} outside the scale`,
  },
};

const translations: Record<string, Strings> = { de, en };

function detectLanguage(): string {
  const locale = (window as any).moment?.locale?.() ?? navigator.language.split("-")[0];
  return locale in translations ? locale : "en";
}

export function t(): Strings {
  return translations[detectLanguage()];
}
