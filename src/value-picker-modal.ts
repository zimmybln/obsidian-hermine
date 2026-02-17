import { App, Modal } from "obsidian";
import { applyTransform } from "./value-transform";

/**
 * Modal for choosing an exact raw value when dropping into a transformed group cell.
 * Shows a free text input with validation and existing values as suggestions.
 */
export class ValuePickerModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private axisName: string,
    private groupLabel: string,
    private existingValues: any[],
    private transformFn: (v: any) => any,
    private onChoose: (value: any | null) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("hermione-value-picker-modal");

    // Header
    contentEl.createEl("h3", {
      text: `Wert für "${this.axisName}" wählen`
    });

    // Group info
    contentEl.createEl("p", {
      cls: "hermione-picker-info",
      text: `Zielgruppe: ${this.groupLabel}`
    });

    // Input field
    const inputContainer = contentEl.createDiv({ cls: "hermione-picker-input-container" });
    const input = inputContainer.createEl("input", {
      cls: "hermione-picker-input",
      type: "text",
      placeholder: "Wert eingeben..."
    });
    input.focus();

    // Validation message
    const validation = contentEl.createDiv({ cls: "hermione-picker-validation" });

    // Suggestions from existing values
    if (this.existingValues.length > 0) {
      const suggestionsContainer = contentEl.createDiv({ cls: "hermione-picker-suggestions" });
      suggestionsContainer.createEl("span", {
        cls: "hermione-picker-suggestions-label",
        text: "Vorhandene Werte:"
      });

      const suggestionsWrapper = suggestionsContainer.createDiv({ cls: "hermione-picker-suggestions-list" });
      for (const val of this.existingValues.sort()) {
        const chip = suggestionsWrapper.createEl("button", {
          cls: "hermione-picker-chip",
          text: String(val)
        });
        chip.addEventListener("click", () => {
          input.value = String(val);
          input.dispatchEvent(new Event("input"));
        });
      }
    }

    // Buttons
    const buttonContainer = contentEl.createDiv({ cls: "hermione-picker-buttons" });

    const confirmBtn = buttonContainer.createEl("button", {
      cls: "hermione-picker-confirm mod-cta",
      text: "Übernehmen"
    });
    confirmBtn.disabled = true;

    const cancelBtn = buttonContainer.createEl("button", {
      cls: "hermione-picker-cancel",
      text: "Abbrechen"
    });

    // Input validation on every keystroke
    const validateInput = () => {
      const raw = input.value.trim();
      if (!raw) {
        validation.textContent = "";
        validation.className = "hermione-picker-validation";
        confirmBtn.disabled = true;
        return;
      }

      // Parse the input value (try number first, then string)
      const parsed = this.parseInputValue(raw);
      const transformed = String(applyTransform(parsed, this.transformFn));

      if (transformed === this.groupLabel) {
        validation.textContent = `✓ Wert ${raw} → Gruppe "${transformed}"`;
        validation.className = "hermione-picker-validation hermione-picker-valid";
        confirmBtn.disabled = false;
      } else {
        validation.textContent = `✗ Wert ${raw} gehört zu Gruppe "${transformed}", nicht "${this.groupLabel}"`;
        validation.className = "hermione-picker-validation hermione-picker-invalid";
        confirmBtn.disabled = true;
      }
    };

    input.addEventListener("input", validateInput);

    // Confirm
    const confirm = () => {
      if (confirmBtn.disabled) return;
      this.resolved = true;
      const parsed = this.parseInputValue(input.value.trim());
      this.onChoose(parsed);
      this.close();
    };

    confirmBtn.addEventListener("click", confirm);

    // Enter key to confirm
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        confirm();
      } else if (e.key === "Escape") {
        this.close();
      }
    });

    // Cancel
    cancelBtn.addEventListener("click", () => {
      this.close();
    });
  }

  onClose(): void {
    if (!this.resolved) {
      this.onChoose(null);
    }
    this.contentEl.empty();
  }

  /**
   * Parse user input into appropriate type (number if possible, otherwise string)
   */
  private parseInputValue(input: string): any {
    const num = parseFloat(input);
    if (!isNaN(num) && String(num) === input) {
      return num;
    }
    // Try integer
    const int = parseInt(input, 10);
    if (!isNaN(int) && String(int) === input) {
      return int;
    }
    return input;
  }
}
