from pathlib import Path
import json

main = Path('main.js')
s = main.read_text(encoding='utf-8')

# Allow a dedicated inherited-note override type without changing folder-title overrides.
s = s.replace(
    'if (!raw || (raw.type !== "folder" && raw.type !== "file")) return null;',
    'if (!raw || !["folder", "file", "folder-note"].includes(raw.type)) return null;',
    1,
)
s = s.replace(
    'if ((type !== "folder" && type !== "file") || !safePath) return;',
    'if (!["folder", "file", "folder-note"].includes(type) || !safePath) return;',
    1,
)

# Rebuild override CSS so folder-note inheritance applies to note titles, nested folders,
# and exact per-note overrides still win.
start = s.find('  renderOverrideCss() {')
end = s.find('\n  getOverride(type, path) {', start)
if start < 0 or end < 0:
    raise SystemExit('renderOverrideCss block not found')
new_css_method = r'''  renderOverrideCss() {
    if (!this.overrideStyleEl) return;
    const rules = [];

    const addRule = (selector, override, folderTitle = false) => {
      const color = sanitizeColor(override.color, folderTitle ? this.settings.folderColor : this.settings.noteColor);
      const size = sanitizeSize(override.size, 10, 40, folderTitle ? this.settings.folderSize : this.settings.noteSize);
      const icon = escapeCssString(sanitizeIcon(override.icon));
      rules.push(`${selector}{color:${color}!important;font-size:${size}px!important;}`);
      rules.push(`${selector}::before{content:"${icon}";margin-right:${icon ? "0.4em" : "0"};}`);
    };

    for (const override of this.settings.overrides.filter((item) => item.type === "folder")) {
      const path = escapeCssString(override.path);
      addRule(`.nav-folder-title[data-path="${path}"] .nav-folder-title-content`, override, true);
    }

    const folderNoteOverrides = this.settings.overrides
      .filter((item) => item.type === "folder-note")
      .sort((a, b) => a.path.split("/").length - b.path.split("/").length);
    for (const override of folderNoteOverrides) {
      const path = escapeCssString(override.path);
      const selector = override.path === "/"
        ? `.nav-file-title .nav-file-title-content`
        : `.nav-file-title[data-path^="${path}/"] .nav-file-title-content`;
      addRule(selector, override, false);
    }

    for (const override of this.settings.overrides.filter((item) => item.type === "file")) {
      const path = escapeCssString(override.path);
      addRule(`.nav-file-title[data-path="${path}"] .nav-file-title-content`, override, false);
    }

    this.overrideStyleEl.textContent = rules.join("\n");
  }

  getFolderNoteOverride(folderPath, includeSelf = true) {
    const safeFolder = sanitizePath(folderPath) || "/";
    const matches = this.settings.overrides.filter((item) => {
      if (item.type !== "folder-note") return false;
      if (!includeSelf && item.path === safeFolder) return false;
      if (item.path === "/") return true;
      return safeFolder === item.path || safeFolder.startsWith(`${item.path}/`);
    });
    matches.sort((a, b) => b.path.length - a.path.length);
    return matches[0] || null;
  }

  getEffectiveNoteOverride(path) {
    const safePath = sanitizePath(path);
    if (!safePath) return null;
    return this.getOverride("file", safePath) || this.getFolderNoteOverride(parentPath(safePath), true);
  }

  getEffectiveNoteAppearance(path) {
    const override = this.getEffectiveNoteOverride(path);
    return override
      ? { color: override.color, size: override.size, icon: override.icon || "", source: override }
      : { color: this.settings.noteColor, size: this.settings.noteSize, icon: this.settings.noteIcon || "", source: null };
  }
'''
s = s[:start] + new_css_method + s[end:]

# Graph color matching should respect inherited folder-note appearance too.
s = s.replace(
    'const override = path ? this.getOverride("file", path) : null;',
    'const override = path ? this.getEffectiveNoteOverride(path) : null;',
    1,
)

# Track Appearance scope in sidebar state.
needle = '    this.scanPath = null;\n'
if needle not in s:
    raise SystemExit('NoteToolsView constructor marker not found')
s = s.replace(needle, needle + '    this.appearanceScope = "note";\n', 1)

# Replace Appearance UI with note/folder scope support.
start_marker = '    const appearanceBody = this.makeDropdown(container, "appearance", "Appearance");\n'
end_marker = '\n    const graphBody = this.makeDropdown(container, "graph", "Connections");'
start = s.find(start_marker)
end = s.find(end_marker, start)
if start < 0 or end < 0:
    raise SystemExit('Appearance block not found')
new_appearance = r'''    const appearanceBody = this.makeDropdown(container, "appearance", "Appearance");
    appearanceBody.addClass("ct-appearance-body");

    const folderPath = sanitizePath(file.parent?.path || "/") || "/";
    const scopeRow = appearanceBody.createDiv({ cls: "ct-appearance-scope-row" });
    scopeRow.createSpan({ text: "Apply to" });
    const scopeSelect = scopeRow.createEl("select");
    scopeSelect.createEl("option", { value: "note", text: "This note" });
    scopeSelect.createEl("option", { value: "folder", text: "Current folder" });
    scopeSelect.value = this.appearanceScope === "folder" ? "folder" : "note";
    scopeSelect.addEventListener("change", async () => {
      this.appearanceScope = scopeSelect.value === "folder" ? "folder" : "note";
      this.openSections.add("appearance");
      await this.render();
    });

    const scopeType = this.appearanceScope === "folder" ? "folder-note" : "file";
    const targetPath = this.appearanceScope === "folder" ? folderPath : file.path;
    const exact = this.plugin.getOverride(scopeType, targetPath);
    const inherited = this.appearanceScope === "folder"
      ? this.plugin.getFolderNoteOverride(folderPath, true)
      : this.plugin.getEffectiveNoteOverride(file.path);
    const appearance = inherited
      ? { color: inherited.color, size: inherited.size, icon: inherited.icon || "" }
      : { color: this.plugin.settings.noteColor, size: this.plugin.settings.noteSize, icon: this.plugin.settings.noteIcon || "" };

    let sourceText;
    if (this.appearanceScope === "note") {
      if (exact) sourceText = "This note has its own appearance.";
      else if (inherited?.type === "folder-note") sourceText = `Inherited from folder: ${inherited.path}`;
      else sourceText = "Using global note appearance.";
    } else {
      if (exact) sourceText = "Applied to this folder and its subfolders.";
      else {
        const parentInherited = this.plugin.getFolderNoteOverride(folderPath, false);
        sourceText = parentInherited ? `Inherited from parent folder: ${parentInherited.path}` : "Using global note appearance.";
      }
    }
    appearanceBody.createDiv({ text: sourceText, cls: "ct-muted ct-appearance-source" });

    const appearanceGrid = appearanceBody.createDiv({ cls: "ct-appearance-grid" });
    const makeAppearanceRow = (label) => {
      const row = appearanceGrid.createDiv({ cls: "ct-appearance-row" });
      row.createDiv({ text: label, cls: "ct-appearance-label" });
      return row.createDiv({ cls: "ct-appearance-control" });
    };

    const persistAppearance = async () => {
      await this.plugin.upsertOverride(scopeType, targetPath, appearance);
      this.openSections.add("appearance");
      await this.render();
    };

    const colorControl = makeAppearanceRow("Title color");
    const colorInput = colorControl.createEl("input", { type: "color", cls: "ct-appearance-color" });
    colorInput.value = sanitizeColor(appearance.color, this.plugin.settings.noteColor);
    colorInput.addEventListener("change", async () => {
      appearance.color = sanitizeColor(colorInput.value, this.plugin.settings.noteColor);
      await persistAppearance();
    });

    const sizeControl = makeAppearanceRow("Title size");
    const sizeValue = sizeControl.createSpan({ text: String(appearance.size), cls: "ct-appearance-size-value" });
    const sizeInput = sizeControl.createEl("input", { type: "range", cls: "ct-appearance-range" });
    sizeInput.min = "10";
    sizeInput.max = "40";
    sizeInput.step = "1";
    sizeInput.value = String(appearance.size);
    sizeInput.addEventListener("input", () => sizeValue.setText(sizeInput.value));
    sizeInput.addEventListener("change", async () => {
      appearance.size = sanitizeSize(sizeInput.value, 10, 40, this.plugin.settings.noteSize);
      await persistAppearance();
    });

    const iconControl = makeAppearanceRow("Icon");
    const iconInput = iconControl.createEl("input", { type: "text", cls: "ct-appearance-icon" });
    iconInput.placeholder = "Optional";
    iconInput.value = appearance.icon || "";
    iconInput.addEventListener("change", async () => {
      appearance.icon = sanitizeIcon(iconInput.value);
      await persistAppearance();
    });

    if (exact) {
      const reset = appearanceBody.createEl("button", {
        text: this.appearanceScope === "folder" ? "Reset folder appearance" : "Reset note appearance",
        cls: "ct-sidebar-wide-button"
      });
      reset.addEventListener("click", async () => {
        await this.plugin.removeOverride(scopeType, targetPath);
        this.openSections.add("appearance");
        await this.render();
      });
    }
'''
s = s[:start] + new_appearance + s[end:]

# Version bump.
manifest_path = Path('manifest.json')
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
manifest['version'] = '1.4.4'
manifest['description'] = 'Development build with Note Tools, Safe Links, IOC scanning, local image localization, folder appearance inheritance, and note connections.'
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')

versions_path = Path('versions.json')
versions = json.loads(versions_path.read_text(encoding='utf-8'))
versions['1.4.4'] = '1.13.7'
versions_path.write_text(json.dumps(versions, indent=2) + '\n', encoding='utf-8')

# Small scope UI styling.
styles_path = Path('styles.css')
c = styles_path.read_text(encoding='utf-8')
marker = '/* Appearance scope v1.4.4 */'
if marker not in c:
    c += r'''

/* Appearance scope v1.4.4 */
.ct-appearance-scope-row {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  margin: 4px 0 8px;
}
.ct-appearance-scope-row select {
  width: 100%;
  min-width: 0;
}
.ct-appearance-source {
  margin: 0 0 8px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
'''
styles_path.write_text(c, encoding='utf-8')

# Sanity checks.
for expected in [
    '"folder-note"',
    'getEffectiveNoteOverride(path)',
    'Current folder',
    'Reset folder appearance',
    'this.appearanceScope = "note";',
]:
    if expected not in s:
        raise SystemExit(f'missing expected output: {expected}')

main.write_text(s, encoding='utf-8')
