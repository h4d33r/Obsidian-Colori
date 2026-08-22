const {
  Plugin,
  PluginSettingTab,
  Setting,
  Modal,
  FuzzySuggestModal,
  TFile,
  TFolder
} = require("obsidian");

const DEFAULT_SETTINGS = {
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
};

const CSS_VARIABLES = {
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
};

function escapeCssAttribute(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function escapeCssContent(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ");
}

module.exports = class ObsidianColoriPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.overrideStyleEl = document.createElement("style");
    this.overrideStyleEl.id = "obsidian-colori-overrides";
    document.head.appendChild(this.overrideStyleEl);

    this.applySettings();
    this.addSettingTab(new ObsidianColoriSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) && !(file instanceof TFolder)) return;

        menu.addItem((item) => {
          item
            .setTitle("Customize title")
            .setIcon("palette")
            .onClick(() => this.openOverrideEditor(file));
        });
      })
    );
  }

  onunload() {
    this.clearSettings();
    if (this.overrideStyleEl) this.overrideStyleEl.remove();
  }

  async loadSettings() {
    const saved = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved || {});
    if (!Array.isArray(this.settings.overrides)) {
      this.settings.overrides = [];
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.applySettings();
  }

  applySettings() {
    const root = document.body;

    for (const [key, cssVariable] of Object.entries(CSS_VARIABLES)) {
      const value = this.settings[key];
      if (key.endsWith("Size")) {
        root.style.setProperty(cssVariable, `${value}px`);
      } else {
        root.style.setProperty(cssVariable, value);
      }
    }

    root.style.setProperty(
      "--ct-folder-icon",
      `"${escapeCssContent(this.settings.folderIcon || "")}"`
    );
    root.style.setProperty(
      "--ct-note-icon",
      `"${escapeCssContent(this.settings.noteIcon || "")}"`
    );

    this.renderOverrideCss();
  }

  clearSettings() {
    const root = document.body;
    for (const cssVariable of Object.values(CSS_VARIABLES)) {
      root.style.removeProperty(cssVariable);
    }
    root.style.removeProperty("--ct-folder-icon");
    root.style.removeProperty("--ct-note-icon");
  }

  renderOverrideCss() {
    if (!this.overrideStyleEl) return;

    const rules = [];

    for (const override of this.settings.overrides) {
      if (!override || !override.path || !override.type) continue;

      const path = escapeCssAttribute(override.path);
      const color = override.color || "";
      const size = Number(override.size) || 14;
      const icon = escapeCssContent(override.icon || "");

      if (override.type === "folder") {
        const base = `.nav-folder-title[data-path="${path}"] .nav-folder-title-content`;
        rules.push(`${base} {
          ${color ? `color: ${color} !important;` : ""}
          font-size: ${size}px !important;
        }`);

        rules.push(`${base}::before {
          content: "${icon}";
          ${icon ? "margin-right: 0.4em;" : ""}
        }`);
      }

      if (override.type === "file") {
        const base = `.nav-file-title[data-path="${path}"] .nav-file-title-content`;
        rules.push(`${base} {
          ${color ? `color: ${color} !important;` : ""}
          font-size: ${size}px !important;
        }`);

        rules.push(`${base}::before {
          content: "${icon}";
          ${icon ? "margin-right: 0.4em;" : ""}
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
    let override = this.getOverride(type, path);

    if (!override) {
      override = {
        type,
        path,
        color:
          values.color ||
          (type === "folder" ? this.settings.folderColor : this.settings.noteColor),
        size:
          values.size ||
          (type === "folder" ? this.settings.folderSize : this.settings.noteSize),
        icon: values.icon || ""
      };
      this.settings.overrides.push(override);
    } else {
      Object.assign(override, values);
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

  async resetSettings() {
    this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
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
            type === "folder" ? plugin.settings.folderColor : plugin.settings.noteColor,
          size:
            type === "folder" ? plugin.settings.folderSize : plugin.settings.noteSize,
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
        picker
          .setValue(this.values.color)
          .onChange((value) => {
            this.values.color = value;
          })
      );

    new Setting(contentEl)
      .setName("Font size")
      .setDesc(`${this.values.size} px`)
      .addSlider((slider) =>
        slider
          .setLimits(10, 40, 1)
          .setValue(this.values.size)
          .setDynamicTooltip()
          .onChange((value) => {
            this.values.size = value;
          })
      );

    new Setting(contentEl)
      .setName("Icon")
      .setDesc("Optional emoji or symbol, for example 📁, 🛡️, ⭐, 🔥.")
      .addText((text) =>
        text
          .setPlaceholder("e.g. 🛡️")
          .setValue(this.values.icon || "")
          .onChange((value) => {
            this.values.icon = value;
          })
      );

    const actions = new Setting(contentEl);

    actions.addButton((button) =>
      button
        .setButtonText("Save")
        .setCta()
        .onClick(async () => {
          await this.plugin.upsertOverride(this.type, this.path, this.values);
          this.close();
        })
    );

    if (this.plugin.getOverride(this.type, this.path)) {
      actions.addButton((button) =>
        button
          .setButtonText("Remove override")
          .setWarning()
          .onClick(async () => {
            await this.plugin.removeOverride(this.type, this.path);
            this.close();
          })
      );
    }
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

class ObsidianColoriSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Obsidian Colori" });
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
            new OverrideEditorModal(this.app, this.plugin, "folder", folder.path).open();
          }).open();
        })
      );

    new Setting(containerEl)
      .setName("Add note override")
      .setDesc("Choose a note and give it its own color, size, and icon.")
      .addButton((button) =>
        button.setButtonText("Choose note").onClick(() => {
          new VaultItemSuggestModal(this.app, "file", (file) => {
            new OverrideEditorModal(this.app, this.plugin, "file", file.path).open();
          }).open();
        })
      );

    if (this.plugin.settings.overrides.length === 0) {
      containerEl.createEl("p", {
        text: "No individual overrides yet. You can also right-click any note or folder in the File Explorer and choose ‘Customize title’.",
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
      .setDesc(description);

    colorSetting.addColorPicker((picker) => {
      picker
        .setValue(this.plugin.settings[colorKey])
        .onChange(async (value) => {
          this.plugin.settings[colorKey] = value;
          await this.plugin.saveSettings();
        });
    });

    const sizeSetting = new Setting(this.containerEl)
      .setName(`${name} font size`)
      .setDesc(`${this.plugin.settings[sizeKey]} px`);

    sizeSetting.addSlider((slider) => {
      slider
        .setLimits(min, max, 1)
        .setValue(this.plugin.settings[sizeKey])
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings[sizeKey] = value;
          sizeSetting.setDesc(`${value} px`);
          await this.plugin.saveSettings();
        });
    });
  }

  addIcon(name, description, key) {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(description)
      .addText((text) =>
        text
          .setPlaceholder("e.g. 📁")
          .setValue(this.plugin.settings[key] || "")
          .onChange(async (value) => {
            this.plugin.settings[key] = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
