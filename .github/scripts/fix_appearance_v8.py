from pathlib import Path

main_path = Path('main.js')
s = main_path.read_text(encoding='utf-8')
start_marker = '    const appearanceBody = this.makeDropdown(container, "appearance", "Appearance");\n'
end_marker = '\n    const graphBody = this.makeDropdown(container, "graph", "Connections");'
start = s.find(start_marker)
if start < 0:
    raise SystemExit('Appearance start marker not found')
end = s.find(end_marker, start)
if end < 0:
    raise SystemExit('Appearance end marker not found')

new_block = r'''    const appearanceBody = this.makeDropdown(container, "appearance", "Appearance");
    appearanceBody.addClass("ct-appearance-body");
    const existing = this.plugin.getOverride("file", file.path);
    const appearance = existing ? { ...existing } : { color: this.plugin.settings.noteColor, size: this.plugin.settings.noteSize, icon: "" };
    const appearanceGrid = appearanceBody.createDiv({ cls: "ct-appearance-grid" });

    const makeAppearanceRow = (label) => {
      const row = appearanceGrid.createDiv({ cls: "ct-appearance-row" });
      row.createDiv({ text: label, cls: "ct-appearance-label" });
      return row.createDiv({ cls: "ct-appearance-control" });
    };

    const colorControl = makeAppearanceRow("Title color");
    const colorInput = colorControl.createEl("input", { type: "color", cls: "ct-appearance-color" });
    colorInput.value = sanitizeColor(appearance.color, this.plugin.settings.noteColor);
    colorInput.addEventListener("change", async () => {
      appearance.color = sanitizeColor(colorInput.value, this.plugin.settings.noteColor);
      await this.plugin.upsertOverride("file", file.path, appearance);
    });

    const sizeControl = makeAppearanceRow("Title size");
    const sizeValue = sizeControl.createSpan({ text: String(appearance.size), cls: "ct-appearance-size-value" });
    const sizeInput = sizeControl.createEl("input", { type: "range", cls: "ct-appearance-range" });
    sizeInput.min = "10";
    sizeInput.max = "40";
    sizeInput.step = "1";
    sizeInput.value = String(appearance.size);
    sizeInput.addEventListener("input", () => {
      sizeValue.setText(sizeInput.value);
    });
    sizeInput.addEventListener("change", async () => {
      appearance.size = sanitizeSize(sizeInput.value, 10, 40, this.plugin.settings.noteSize);
      sizeValue.setText(String(appearance.size));
      await this.plugin.upsertOverride("file", file.path, appearance);
    });

    const iconControl = makeAppearanceRow("Icon");
    const iconInput = iconControl.createEl("input", { type: "text", cls: "ct-appearance-icon" });
    iconInput.placeholder = "Optional";
    iconInput.value = appearance.icon || "";
    iconInput.addEventListener("change", async () => {
      appearance.icon = sanitizeIcon(iconInput.value);
      iconInput.value = appearance.icon;
      await this.plugin.upsertOverride("file", file.path, appearance);
    });

    if (existing) {
      const reset = appearanceBody.createEl("button", { text: "Reset appearance", cls: "ct-sidebar-wide-button" });
      reset.addEventListener("click", async () => {
        await this.plugin.removeOverride("file", file.path);
        this.openSections.add("appearance");
        await this.render();
      });
    }
'''

s = s[:start] + new_block + s[end:]
main_path.write_text(s, encoding='utf-8')

css_path = Path('styles.css')
c = css_path.read_text(encoding='utf-8')
css_marker = '/* Appearance v8: deterministic narrow-sidebar layout */'
if css_marker not in c:
    c += r'''

/* Appearance v8: deterministic narrow-sidebar layout */
.ct-appearance-body .ct-appearance-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 3px 0 2px;
}

.ct-appearance-body .ct-appearance-row {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  min-height: 34px;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
}

.ct-appearance-body .ct-appearance-label {
  min-width: 0;
  margin: 0;
  padding: 0;
  line-height: 1.2;
  color: var(--text-normal);
  white-space: nowrap;
}

.ct-appearance-body .ct-appearance-control {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  min-width: 0;
  width: 100%;
  margin: 0;
  padding: 0;
}

.ct-appearance-body .ct-appearance-color {
  width: 34px;
  height: 28px;
  flex: 0 0 34px;
  margin: 0;
  padding: 0;
  cursor: pointer;
}

.ct-appearance-body .ct-appearance-size-value {
  width: 26px;
  flex: 0 0 26px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
}

.ct-appearance-body .ct-appearance-range {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
  margin: 0;
}

.ct-appearance-body .ct-appearance-icon {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  margin: 0;
}
'''
css_path.write_text(c, encoding='utf-8')
