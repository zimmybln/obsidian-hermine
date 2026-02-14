import { App, Modal } from "obsidian";

/**
 * Modal for entering an exact numeric value when dropping a card
 * into a range-based cell with "exakt" mode enabled.
 */
export class ExactValueModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private axisName: string,
    private cellValue: number,
    private rangeMin: number,
    private rangeMax: number,
    private onChoose: (value: number | null) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("hermine-exact-modal");

    contentEl.createEl("h3", {
      text: `Exakter Wert für "${this.axisName}"`
    });

    contentEl.createEl("p", {
      cls: "hermine-exact-info",
      text: `Bereich: ${this.rangeMin} – ${this.rangeMax}`
    });

    // Input with range slider
    const inputRow = contentEl.createDiv({ cls: "hermine-exact-input-row" });

    const input = inputRow.createEl("input", {
      cls: "hermine-exact-input",
      type: "number",
    });
    input.min = String(this.rangeMin);
    input.max = String(this.rangeMax);
    input.value = String(this.cellValue);
    input.step = "1";

    const slider = inputRow.createEl("input", {
      cls: "hermine-exact-slider",
      type: "range",
    });
    slider.min = String(this.rangeMin);
    slider.max = String(this.rangeMax);
    slider.value = String(this.cellValue);
    slider.step = "1";

    // Sync input and slider
    input.addEventListener("input", () => {
      slider.value = input.value;
      updateValidation();
    });
    slider.addEventListener("input", () => {
      input.value = slider.value;
      updateValidation();
    });

    // Validation
    const validation = contentEl.createDiv({ cls: "hermine-exact-validation" });

    const updateValidation = () => {
      const num = parseFloat(input.value);
      if (isNaN(num)) {
        validation.textContent = "Bitte eine Zahl eingeben";
        validation.className = "hermine-exact-validation hermine-picker-invalid";
        confirmBtn.disabled = true;
      } else if (num < this.rangeMin || num > this.rangeMax) {
        validation.textContent = `Wert muss zwischen ${this.rangeMin} und ${this.rangeMax} liegen`;
        validation.className = "hermine-exact-validation hermine-picker-invalid";
        confirmBtn.disabled = true;
      } else {
        validation.textContent = `Wert: ${num}`;
        validation.className = "hermine-exact-validation hermine-picker-valid";
        confirmBtn.disabled = false;
      }
    };

    // Buttons
    const buttonContainer = contentEl.createDiv({ cls: "hermine-picker-buttons" });

    const confirmBtn = buttonContainer.createEl("button", {
      cls: "hermine-picker-confirm mod-cta",
      text: "Übernehmen"
    });

    const cancelBtn = buttonContainer.createEl("button", {
      cls: "hermine-picker-cancel",
      text: "Abbrechen"
    });

    const confirm = () => {
      if (confirmBtn.disabled) return;
      this.resolved = true;
      this.onChoose(parseFloat(input.value));
      this.close();
    };

    confirmBtn.addEventListener("click", confirm);
    cancelBtn.addEventListener("click", () => this.close());

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") confirm();
      else if (e.key === "Escape") this.close();
    });

    input.focus();
    input.select();
    updateValidation();
  }

  onClose(): void {
    if (!this.resolved) {
      this.onChoose(null);
    }
    this.contentEl.empty();
  }
}
