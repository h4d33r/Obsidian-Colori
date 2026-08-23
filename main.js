const {
  Plugin,
  PluginSettingTab,
  Setting,
  Modal,
  FuzzySuggestModal,
  Notice,
  TFile,
  TFolder,
  normalizePath
} = require("obsidian");

const HUB_START_MARKER = "<!-- colori-folder-hub:start -->";
const HUB_END_MARKER = "<!-- colori-folder-hub:end -->";

const DEFAULT_SETTINGS = Object.freeze({
  folderColor: "#f0a45d",
  folderSize: 14,
  folderIcon: "",
  noteColor: "#83c5ff",
  noteSize: 14,
  noteIcon: "",
  activeNoteColor: "#ff7aa2",
  activeNoteSize: 14,
  inlineTitleColor: "#b392f0",
  inlineTitleSize: 28,
  h1Color: "#ff6b6b",
  h1Size: 28,
  h2Color: "#f2b84b",
  h2Size: 24,
  h3Color: "#63d297",
  h3Size: 21,
  h4Color: "#62b6ff",
  h4Size: 19,
  h5Color: "#b392f0",
  h5Size: 17,
  h6Color: "#ef8fde",
  h6Size: 16,
  overrides: []
});

const CSS_VARIABLES = Object.freeze({
  folderColor: "--ct-folder-color",
  folderSize: "--ct-folder-size",
  noteColor: "--ct-note-color",
  noteSize: "--ct-note-size",
  activeNoteColor: "--ct-active-note-color",
  activeNoteSize: "--ct-active-note-size",
  inlineTitleColor: "--ct-inline-title-color",
  inlineTitleSize: "--ct-inline-title-size",
  h1Color: "--ct-h1-color",
  h1Size: "--ct-h1-size",
  h2Color: "--ct-h2-color",
  h2Size: "--ct-h2-size",
  h3Color: "--ct-h3-color",
  h3Size: "--ct-h3-size",
  h4Color: "--ct-h4-color",
  h4Size: "--ct-h4-size",
  h5Color: "--ct-h5-color",
  h5Size: "--ct-h5-size",
  h6Color: "--ct-h6-color",
  h6Size: "--ct-h6-size"
});

const SIZE_LIMITS = Object.freeze({
  folderSize: [10, 30],
  noteSize: [10, 30],
  activeNoteSize: [10, 30],
  inlineTitleSize: [12, 60],
  h1Size: [10, 60],
  h2Size: [10, 60],
  h3Size: [10, 60],
  h4Size: [10, 60],
  h5Size: [10, 60],
  h6Size: [10, 60]
});

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_ICON_CODE_POINTS = 12;
const MAX_PATH_LENGTH = 4096;

function sanitizeColor(value, fallback) {
  return typeof value === "string" && HEX_COLOR_RE.test(value)
    ? value.toLowerCase()
    : fallback;
}

function sanitizeSize(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(Math.min(max, Math.max(min, number)));
}

function sanitizeIcon(value) {
  if (typeof value !== "string") return "";
  const withoutControls = value.replace(/[\u0000-\u001f\u007f]/g, "");
  return Array.from(withoutControls).slice(0, MAX_ICON_CODE_POINTS).join("");
}

function sanitizePath(value) {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/\u0000/g, "")
    .replace(/\\/g, "/")
    .trim();
  if (!cleaned || cleaned.length > MAX_PATH_LENGTH) return null;
  return cleaned;
}

function escapeCssString(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\d ")
    .replace(/\n/g, "\\a ")
    .replace(/\f/g, "\\c ");
}

function normalizeOverride(raw, settings) {
  if (!raw || (raw.type !== "folder" && raw.type !== "file")) return null;

  const path = sanitizePath(raw.path);
  if (!path) return null;

  const fallbackColor =
    raw.type === "folder" ? settings.folderColor : settings.noteColor;
  const fallbackSize =
    raw.type === "folder" ? settings.folderSize : settings.noteSize;

  return {
    type: raw.type,
    path,
    color: sanitizeColor(raw.color, fallbackColor),
    size: sanitizeSize(raw.size, 10, 40, fallbackSize),
    icon: sanitizeIcon(raw.icon)
  };
}

function normalizeSettings(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const result = { ...DEFAULT_SETTINGS, overrides: [] };

  for (const key of Object.keys(CSS_VARIABLES)) {
    if (key.endsWith("Color")) {
      result[key] = sanitizeColor(source[key], DEFAULT_SETTINGS[key]);
    } else if (key.endsWith("Size")) {
      const [min, max] = SIZE_LIMITS[key];
      result[key] = sanitizeSize(
        source[key],
        min,
        max,
        DEFAULT_SETTINGS[key]
      );
    }
  }

  result.folderIcon = sanitizeIcon(source.folderIcon);
  result.noteIcon = sanitizeIcon(source.noteIcon);

  if (Array.isArray(source.overrides)) {
    const seen = new Set();
    for (const rawOverride of source.overrides) {
      const override = normalizeOverride(rawOverride, result);
      if (!override) continue;

      const key = `${override.type}:${override.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.overrides.push(override);
    }
  }

  return result;
}

module.exports = class ColoriPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.overrideStyleEl = document.createElement("style");
    this.overrideStyleEl.id = "colori-overrides";
    document.head.appendChild(this.overrideStyleEl);
    this.register(() => this.overrideStyleEl?.remove());

    this.applySettings();
    this.addSettingTab(new ColoriSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) && !(file instanceof TFolder)) return;

        menu.addItem((item) => {
          item
            .setTitle("Customize title")
            .setIcon("palette")
            .onClick(() => this.openOverrideEditor(file));
        });

        if (file instanceof TFolder && file.path !== "/") {
          menu.addItem((item) => {
            item
              .setTitle("Create/update graph hub")
              .setIcon("git-fork")
              .onClick(() => this.createOrUpdateFolderHub(file));
          });
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", async (file, oldPath) => {
        await this.handleRename(file, oldPath);
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", async (file) => {
        await this.handleDelete(file);
      })
    );
  }

  onunload() {
    this.clearSettings();
  }

  async loadSettings() {
    this.settings = normalizeSettings(await this.loadData());
  }

  async saveSettings() {
    this.settings = normalizeSettings(this.settings);
    await this.saveData(this.settings);
    this.applySettings();
  }

  applySettings() {
    const root = document.body;
    if (!root) return;

    for (const [key, cssVariable] of Object.entries(CSS_VARIABLES)) {
      const value = this.settings[key];
      root.style.setProperty(
        cssVariable,
        key.endsWith("Size") ? `${value}px` : value
      );
    }

    root.style.setProperty(
      "--ct-folder-icon",
      `"${escapeCssString(this.settings.folderIcon)}"`
    );
    root.style.setProperty(
      "--ct-note-icon",
      `"${escapeCssString(this.settings.noteIcon)}"`
    );

    // Use Obsidian's documented Graph CSS variables instead of touching the
    // private Graph renderer. This keeps graph nodes aligned with Colori's
    // global note and active-note colors.
    root.style.setProperty("--graph-node", this.settings.noteColor);
    root.style.setProperty(
      "--graph-node-focused",
      this.settings.activeNoteColor
    );

    this.renderOverrideCss();
  }

  clearSettings() {
    const root = document.body;
    if (!root) return;

    for (const cssVariable of Object.values(CSS_VARIABLES)) {
      root.style.removeProperty(cssVariable);
    }
    root.style.removeProperty("--ct-folder-icon");
    root.style.removeProperty("--ct-note-icon");
    root.style.removeProperty("--graph-node");
    root.style.removeProperty("--graph-node-focused");
  }

  renderOverrideCss() {
    if (!this.overrideStyleEl) return;

    const rules = [];

    for (const override of this.settings.overrides) {
      const path = escapeCssString(override.path);
      const color = sanitizeColor(
        override.color,
        override.type === "folder"
          ? this.settings.folderColor
          : this.settings.noteColor
      );
      const size = sanitizeSize(
        override.size,
        10,
        40,
        override.type === "folder"
          ? this.settings.folderSize
          : this.settings.noteSize
      );
      const icon = escapeCssString(sanitizeIcon(override.icon));

      const selector =
        override.type === "folder"
          ? `.nav-folder-title[data-path="${path}"] .nav-folder-title-content`
          : `.nav-file-title[data-path="${path}"] .nav-file-title-content`;

      rules.push(`${selector} {
        color: ${color} !important;
        font-size: ${size}px !important;
      }`);

      if (icon) {
        rules.push(`${selector}::before {
          content: "${icon}";
          margin-right: 0.4em;
        }`);
      } else {
        rules.push(`${selector}::before {
          content: "";
          margin-right: 0;
        }`);
      }
    }

    this.overrideStyleEl.textContent = rules.join("\n");
  }

  getOverride(type, path) {
    return this.settings.overrides.find(
      (item) => item.type === type && item.path === path
    );
  }

  async upsertOverride(type, path, values) {
    const safePath = sanitizePath(path);
    if ((type !== "folder" && type !== "file") || !safePath) return;

    const fallbackColor =
      type === "folder" ? this.settings.folderColor : this.settings.noteColor;
    const fallbackSize =
      type === "folder" ? this.settings.folderSize : this.settings.noteSize;

    const safeValues = {
      color: sanitizeColor(values.color, fallbackColor),
      size: sanitizeSize(values.size, 10, 40, fallbackSize),
      icon: sanitizeIcon(values.icon)
    };

    let override = this.getOverride(type, safePath);

    if (!override) {
      override = { type, path: safePath, ...safeValues };
      this.settings.overrides.push(override);
    } else {
      Object.assign(override, safeValues);
    }

    await this.saveSettings();
  }

  async removeOverride(type, path) {
    this.settings.overrides = this.settings.overrides.filter(
      (item) => !(item.type === type && item.path === path)
    );
    await this.saveSettings();
  }

  openOverrideEditor(file) {
    const type = file instanceof TFolder ? "folder" : "file";
    new OverrideEditorModal(this.app, this, type, file.path).open();
  }

  buildFolderHubSection(folder, hubPath) {
    const notes = this.app.vault
      .getMarkdownFiles()
      .filter(
        (file) => file.parent?.path === folder.path && file.path !== hubPath
      )
      .sort((a, b) => a.basename.localeCompare(b.basename));

    const links = notes.map(
      (file) => `- ${this.app.fileManager.generateMarkdownLink(file, hubPath)}`
    );

    return {
      count: notes.length,
      content: [
        HUB_START_MARKER,
        "## Notes",
        links.length > 0 ? links.join("\n") : "_No notes in this folder yet._",
        HUB_END_MARKER
      ].join("\n")
    };
  }

  async createOrUpdateFolderHub(folder) {
    if (!(folder instanceof TFolder) || folder.path === "/") return;

    const hubPath = normalizePath(`${folder.path}/${folder.name}.md`);
    const existing = this.app.vault.getAbstractFileByPath(hubPath);

    if (existing && !(existing instanceof TFile)) {
      new Notice(`Cannot create graph hub at ${hubPath}.`);
      return;
    }

    const section = this.buildFolderHubSection(folder, hubPath);

    try {
      if (!existing) {
        await this.app.vault.create(
          hubPath,
          `# ${folder.name}\n\n${section.content}\n`
        );
      } else {
        const current = await this.app.vault.read(existing);
        const start = current.indexOf(HUB_START_MARKER);
        const end =
          start >= 0 ? current.indexOf(HUB_END_MARKER, start) : -1;

        let updated;
        if (start >= 0 && end >= start) {
          updated =
            current.slice(0, start) +
            section.content +
            current.slice(end + HUB_END_MARKER.length);
        } else {
          updated = `${current.trimEnd()}\n\n${section.content}\n`;
        }

        if (updated !== current) {
          await this.app.vault.modify(existing, updated);
        }
      }

      new Notice(
        `${folder.name} graph hub updated with ${section.count} ${
          section.count === 1 ? "note" : "notes"
        }.`
      );
    } catch (error) {
      console.error("Colori: unable to update folder graph hub", error);
      new Notice(`Unable to update the ${folder.name} graph hub.`);
    }
  }

  async handleRename(file, oldPath) {
    const newPath = sanitizePath(file.path);
    const safeOldPath = sanitizePath(oldPath);
    if (!newPath || !safeOldPath || newPath === safeOldPath) return;

    let changed = false;

    for (const override of this.settings.overrides) {
      if (override.path === safeOldPath) {
        override.path = newPath;
        changed = true;
        continue;
      }

      if (
        file instanceof TFolder &&
        override.path.startsWith(`${safeOldPath}/`)
      ) {
        override.path = `${newPath}${override.path.slice(safeOldPath.length)}`;
        changed = true;
      }
    }

    if (changed) await this.saveSettings();
  }

  async handleDelete(file) {
    const deletedPath = sanitizePath(file.path);
    if (!deletedPath) return;

    const before = this.settings.overrides.length;
    this.settings.overrides = this.settings.overrides.filter((override) => {
      if (override.path === deletedPath) return false;
      if (
        file instanceof TFolder &&
        override.path.startsWith(`${deletedPath}/`)
      ) {
        return false;
      }
      return true;
    });

    if (this.settings.overrides.length !== before) {
      await this.saveSettings();
    }
  }

  async resetSettings() {
    this.settings = { ...DEFAULT_SETTINGS, overrides: [] };
    await this.saveSettings();
  }
};

class OverrideEditorModal extends Modal {
  constructor(app, plugin, type, path) {
    super(app);
    this.plugin = plugin;
    this.type = type;
    this.path = path;

    const existing = plugin.getOverride(type, path);
    this.values = existing
      ? { ...existing }
      : {
          color:
            type === "folder"
              ? plugin.settings.folderColor
              : plugin.settings.noteColor,
          size:
            type === "folder"
              ? plugin.settings.folderSize
              : plugin.settings.noteSize,
          icon: ""
        };
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", {
      text: `Customize ${this.type === "folder" ? "folder" : "note"} title`
    });

    contentEl.createEl("p", {
      text: this.path,
      cls: "ct-path-preview"
    });

    new Setting(contentEl)
      .setName("Color")
      .setDesc("Override the global title color.")
      .addColorPicker((picker) =>
        picker.setValue(this.values.color).onChange((value) => {
          this.values.color = sanitizeColor(
            value,
            this.type === "folder"
              ? this.plugin.settings.folderColor
              : this.plugin.settings.noteColor
          );
        })
      );

    const sizeSetting = new Setting(contentEl)
      .setName("Font size")
      .setDesc(`${this.values.size} px`);

    sizeSetting.addSlider((slider) =>
      slider
        .setLimits(10, 40, 1)
        .setValue(this.values.size)
        .setDynamicTooltip()
        .onChange((value) => {
          this.values.size = sanitizeSize(value, 10, 40, 14);
          sizeSetting.setDesc(`${this.values.size} px`);
        })
    );

    new Setting(contentEl)
      .setName("Icon")
      .setDesc("Optional emoji or symbol. Limited to 12 characters.")
      .addText((text) =>
        text
          .setPlaceholder("e.g. 🛡️")
          .setValue(this.values.icon || "")
          .onChange((value) => {
            const safeIcon = sanitizeIcon(value);
            this.values.icon = safeIcon;
            if (value !== safeIcon) text.setValue(safeIcon);
          })
      );

    const actions = new Setting(contentEl);

    actions.addButton((button) =>
      button
        .setButtonText("Reset to default")
        .onClick(async () => {
          await this.plugin.removeOverride(this.type, this.path);
          this.close();
        })
    );

    actions.addButton((button) =>
      button
        .setButtonText("Save")
        .setCta()
        .onClick(async () => {
          await this.plugin.upsertOverride(this.type, this.path, this.values);
          this.close();
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

class VaultItemSuggestModal extends FuzzySuggestModal {
  constructor(app, type, onChoose) {
    super(app);
    this.type = type;
    this.onChoose = onChoose;
    this.setPlaceholder(type === "folder" ? "Choose a folder…" : "Choose a note…");
  }

  getItems() {
    if (this.type === "folder") {
      return this.app.vault
        .getAllLoadedFiles()
        .filter((item) => item instanceof TFolder && item.path !== "/");
    }

    return this.app.vault.getMarkdownFiles();
  }

  getItemText(item) {
    return item.path;
  }

  onChooseItem(item) {
    this.onChoose(item);
  }
}

class ColoriSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("ct-settings-tab");

    containerEl.createEl("h2", { text: "Colori" });
    containerEl.createEl("p", {
      text: "Global styles apply everywhere. Individual overrides take priority."
    });

    this.addSection("File explorer");

    this.addColorAndSize(
      "Folders",
      "Folder names in the file explorer.",
      "folderColor",
      "folderSize",
      10,
      30
    );

    this.addIcon(
      "Default folder icon",
      "Optional icon shown before every folder title.",
      "folderIcon"
    );

    this.addColorAndSize(
      "Notes",
      "Note names in the file explorer.",
      "noteColor",
      "noteSize",
      10,
      30
    );

    this.addIcon(
      "Default note icon",
      "Optional icon shown before every note title.",
      "noteIcon"
    );

    this.addColorAndSize(
      "Active note",
      "Currently selected note in the file explorer.",
      "activeNoteColor",
      "activeNoteSize",
      10,
      30
    );

    this.addSection("Individual overrides");

    new Setting(containerEl)
      .setName("Add folder override")
      .setDesc("Choose a folder and give it its own color, size, and icon.")
      .addButton((button) =>
        button.setButtonText("Choose folder").onClick(() => {
          new VaultItemSuggestModal(this.app, "folder", (folder) => {
            new OverrideEditorModal(
              this.app,
              this.plugin,
              "folder",
              folder.path
            ).open();
          }).open();
        })
      );

    new Setting(containerEl)
      .setName("Add note override")
      .setDesc("Choose a note and give it its own color, size, and icon.")
      .addButton((button) =>
        button.setButtonText("Choose note").onClick(() => {
          new VaultItemSuggestModal(this.app, "file", (file) => {
            new OverrideEditorModal(
              this.app,
              this.plugin,
              "file",
              file.path
            ).open();
          }).open();
        })
      );

    if (this.plugin.settings.overrides.length === 0) {
      containerEl.createEl("p", {
        text: "No individual overrides yet. You can also right-click any note or folder in the File Explorer and choose “Customize title”.",
        cls: "ct-muted"
      });
    } else {
      const sorted = [...this.plugin.settings.overrides].sort((a, b) =>
        a.path.localeCompare(b.path)
      );

      for (const override of sorted) {
        const label = `${override.icon ? override.icon + " " : ""}${override.path}`;

        new Setting(containerEl)
          .setName(label)
          .setDesc(
            `${override.type === "folder" ? "Folder" : "Note"} · ${override.size}px · ${override.color}`
          )
          .addButton((button) =>
            button
              .setButtonText("Edit")
              .onClick(() =>
                new OverrideEditorModal(
                  this.app,
                  this.plugin,
                  override.type,
                  override.path
                ).open()
              )
          )
          .addExtraButton((button) =>
            button
              .setIcon("trash")
              .setTooltip("Remove override")
              .onClick(async () => {
                await this.plugin.removeOverride(override.type, override.path);
                this.display();
              })
          );
      }
    }

    this.addSection("Note title");

    this.addColorAndSize(
      "Inline title",
      "The note title displayed above the note content.",
      "inlineTitleColor",
      "inlineTitleSize",
      12,
      60
    );

    this.addSection("Markdown headings");

    for (let level = 1; level <= 6; level++) {
      this.addColorAndSize(
        `Heading ${level}`,
        `H${level} in Reading view and Live Preview.`,
        `h${level}Color`,
        `h${level}Size`,
        10,
        60
      );
    }

    this.addSection("Reset");

    new Setting(containerEl)
      .setName("Restore defaults")
      .setDesc("Restore global defaults and remove every individual override.")
      .addButton((button) =>
        button
          .setButtonText("Reset")
          .setWarning()
          .onClick(async () => {
            await this.plugin.resetSettings();
            this.display();
          })
      );
  }

  addSection(title) {
    const heading = this.containerEl.createEl("h3", { text: title });
    heading.addClass("ct-settings-section");
  }

  addColorAndSize(name, description, colorKey, sizeKey, min, max) {
    const colorSetting = new Setting(this.containerEl)
      .setName(`${name} color`)
      .addColorPicker((picker) => {
        picker
          .setValue(this.plugin.settings[colorKey])
          .onChange(async (value) => {
            this.plugin.settings[colorKey] = sanitizeColor(
              value,
              DEFAULT_SETTINGS[colorKey]
            );
            await this.plugin.saveSettings();
          });
      });
    colorSetting.settingEl.addClass("ct-compact-setting");
    colorSetting.nameEl.setAttr("title", description);

    const sizeSetting = new Setting(this.containerEl)
      .setName(`${name} font size`);
    sizeSetting.settingEl.addClass("ct-compact-setting");
    sizeSetting.nameEl.setAttr("title", description);

    const sizeValue = sizeSetting.controlEl.createSpan({
      text: `${this.plugin.settings[sizeKey]} px`,
      cls: "ct-size-value"
    });

    sizeSetting.addSlider((slider) => {
      slider
        .setLimits(min, max, 1)
        .setValue(this.plugin.settings[sizeKey])
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings[sizeKey] = sanitizeSize(
            value,
            min,
            max,
            DEFAULT_SETTINGS[sizeKey]
          );
          sizeValue.setText(`${this.plugin.settings[sizeKey]} px`);
          await this.plugin.saveSettings();
        });
    });
  }

  addIcon(name, description, key) {
    const iconSetting = new Setting(this.containerEl)
      .setName(name)
      .addText((text) =>
        text
          .setPlaceholder("e.g. 📁")
          .setValue(this.plugin.settings[key] || "")
          .onChange(async (value) => {
            const safeIcon = sanitizeIcon(value);
            this.plugin.settings[key] = safeIcon;
            if (value !== safeIcon) text.setValue(safeIcon);
            await this.plugin.saveSettings();
          })
      );
    iconSetting.settingEl.addClass("ct-compact-setting");
    iconSetting.nameEl.setAttr("title", description);
  }
}
