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
const CONNECTIONS_START_MARKER = "<!-- colori-connections:start -->";
const CONNECTIONS_END_MARKER = "<!-- colori-connections:end -->";

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
  overrides: [],
  folderHubs: [],
  connections: []
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
  const cleaned = value.replace(/\u0000/g, "").replace(/\\/g, "/").trim();
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

function parentPath(path) {
  const safe = sanitizePath(path);
  if (!safe) return null;
  const index = safe.lastIndexOf("/");
  return index < 0 ? "/" : safe.slice(0, index) || "/";
}

function pathMatchesOrDescends(path, basePath) {
  return path === basePath || path.startsWith(`${basePath}/`);
}

function normalizeOverride(raw, settings) {
  if (!raw || (raw.type !== "folder" && raw.type !== "file")) return null;
  const path = sanitizePath(raw.path);
  if (!path) return null;

  const fallbackColor = raw.type === "folder" ? settings.folderColor : settings.noteColor;
  const fallbackSize = raw.type === "folder" ? settings.folderSize : settings.noteSize;

  return {
    type: raw.type,
    path,
    color: sanitizeColor(raw.color, fallbackColor),
    size: sanitizeSize(raw.size, 10, 40, fallbackSize),
    icon: sanitizeIcon(raw.icon)
  };
}

function normalizeConnection(raw) {
  if (!raw || typeof raw !== "object") return null;
  const source = sanitizePath(raw.source);
  const target = sanitizePath(raw.target);
  if (!source || !target || source === target) return null;
  return { source, target };
}

function normalizeSettings(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const result = { ...DEFAULT_SETTINGS, overrides: [], folderHubs: [], connections: [] };

  for (const key of Object.keys(CSS_VARIABLES)) {
    if (key.endsWith("Color")) {
      result[key] = sanitizeColor(source[key], DEFAULT_SETTINGS[key]);
    } else if (key.endsWith("Size")) {
      const [min, max] = SIZE_LIMITS[key];
      result[key] = sanitizeSize(source[key], min, max, DEFAULT_SETTINGS[key]);
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

  if (Array.isArray(source.folderHubs)) {
    const seen = new Set();
    for (const rawPath of source.folderHubs) {
      const path = sanitizePath(rawPath);
      if (!path || path === "/" || seen.has(path)) continue;
      seen.add(path);
      result.folderHubs.push(path);
    }
  }

  if (Array.isArray(source.connections)) {
    const seen = new Set();
    for (const rawConnection of source.connections) {
      const connection = normalizeConnection(rawConnection);
      if (!connection) continue;
      const key = `${connection.source}\n${connection.target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.connections.push(connection);
    }
  }

  return result;
}

function replaceManagedSection(current, startMarker, endMarker, newSection) {
  const start = current.indexOf(startMarker);
  const end = start >= 0 ? current.indexOf(endMarker, start) : -1;

  if (start < 0 && end < 0) {
    const separator = current.trimEnd() ? "\n\n" : "";
    return `${current.trimEnd()}${separator}${newSection}\n`;
  }

  if (start < 0 || end < start) return null;
  return current.slice(0, start) + newSection + current.slice(end + endMarker.length);
}

function removeManagedSection(current, startMarker, endMarker) {
  const start = current.indexOf(startMarker);
  const end = start >= 0 ? current.indexOf(endMarker, start) : -1;

  if (start < 0 && end < 0) return current;
  if (start < 0 || end < start) return null;

  const before = current.slice(0, start).trimEnd();
  const after = current.slice(end + endMarker.length).trimStart();
  if (before && after) return `${before}\n\n${after}`;
  if (before) return `${before}\n`;
  if (after) return after;
  return "";
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
        if (file instanceof TFile && file.extension !== "md") return;

        menu.addItem((item) => {
          item
            .setTitle("Colori")
            .setIcon("palette")
            .onClick(() => new ColoriLauncherModal(this.app, this, file).open());
        });
      })
    );

    this.registerEvent(this.app.vault.on("create", async (file) => this.handleCreate(file)));
    this.registerEvent(this.app.vault.on("rename", async (file, oldPath) => this.handleRename(file, oldPath)));
    this.registerEvent(this.app.vault.on("delete", async (file) => this.handleDelete(file)));
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
      root.style.setProperty(cssVariable, key.endsWith("Size") ? `${value}px` : value);
    }

    root.style.setProperty("--ct-folder-icon", `"${escapeCssString(this.settings.folderIcon)}"`);
    root.style.setProperty("--ct-note-icon", `"${escapeCssString(this.settings.noteIcon)}"`);
    root.style.setProperty("--graph-node", this.settings.noteColor);
    root.style.setProperty("--graph-node-focused", this.settings.activeNoteColor);
    this.renderOverrideCss();
  }

  clearSettings() {
    const root = document.body;
    if (!root) return;
    for (const cssVariable of Object.values(CSS_VARIABLES)) root.style.removeProperty(cssVariable);
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
        override.type === "folder" ? this.settings.folderColor : this.settings.noteColor
      );
      const size = sanitizeSize(
        override.size,
        10,
        40,
        override.type === "folder" ? this.settings.folderSize : this.settings.noteSize
      );
      const icon = escapeCssString(sanitizeIcon(override.icon));
      const selector = override.type === "folder"
        ? `.nav-folder-title[data-path="${path}"] .nav-folder-title-content`
        : `.nav-file-title[data-path="${path}"] .nav-file-title-content`;

      rules.push(`${selector} {\n  color: ${color} !important;\n  font-size: ${size}px !important;\n}`);
      rules.push(`${selector}::before {\n  content: "${icon}";\n  margin-right: ${icon ? "0.4em" : "0"};\n}`);
    }

    this.overrideStyleEl.textContent = rules.join("\n");
  }

  getOverride(type, path) {
    return this.settings.overrides.find((item) => item.type === type && item.path === path);
  }

  async upsertOverride(type, path, values) {
    const safePath = sanitizePath(path);
    if ((type !== "folder" && type !== "file") || !safePath) return;

    const fallbackColor = type === "folder" ? this.settings.folderColor : this.settings.noteColor;
    const fallbackSize = type === "folder" ? this.settings.folderSize : this.settings.noteSize;
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

  isFolderHubEnabled(folderPath) {
    return this.settings.folderHubs.includes(folderPath);
  }

  getHubPath(folder) {
    return normalizePath(`${folder.path}/${folder.name}.md`);
  }

  buildFolderHubSection(folder, hubPath) {
    const notes = this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.parent?.path === folder.path && file.path !== hubPath)
      .sort((a, b) => a.basename.localeCompare(b.basename));

    const links = notes.map(
      (file) => `- ${this.app.fileManager.generateMarkdownLink(file, hubPath)}`
    );

    return {
      count: notes.length,
      content: [
        HUB_START_MARKER,
        "## Notes",
        links.length ? links.join("\n") : "_No notes in this folder yet._",
        HUB_END_MARKER
      ].join("\n")
    };
  }

  async enableFolderHub(folder) {
    if (!(folder instanceof TFolder) || folder.path === "/") return;
    if (!this.settings.folderHubs.includes(folder.path)) {
      this.settings.folderHubs.push(folder.path);
      await this.saveSettings();
    }
    await this.syncFolderHub(folder, false);
  }

  async syncFolderHub(folder, silent = true) {
    if (!(folder instanceof TFolder) || folder.path === "/") return;
    const hubPath = this.getHubPath(folder);
    const existing = this.app.vault.getAbstractFileByPath(hubPath);

    if (existing && !(existing instanceof TFile)) {
      if (!silent) new Notice(`Cannot create graph hub at ${hubPath}.`);
      return;
    }

    const section = this.buildFolderHubSection(folder, hubPath);

    try {
      if (!existing) {
        await this.app.vault.create(hubPath, `# ${folder.name}\n\n${section.content}\n`);
      } else {
        const current = await this.app.vault.read(existing);
        const updated = replaceManagedSection(current, HUB_START_MARKER, HUB_END_MARKER, section.content);
        if (updated === null) {
          if (!silent) new Notice("Colori found damaged graph-hub markers and did not modify the note.");
          return;
        }
        if (updated !== current) await this.app.vault.modify(existing, updated);
      }

      if (!silent) {
        new Notice(`${folder.name} graph hub synced with ${section.count} ${section.count === 1 ? "note" : "notes"}.`);
      }
    } catch (error) {
      console.error("Colori: unable to sync folder graph hub", error);
      if (!silent) new Notice(`Unable to sync the ${folder.name} graph hub.`);
    }
  }

  async disableFolderHub(folder, deleteIfSafe = false) {
    if (!(folder instanceof TFolder) || folder.path === "/") return;

    this.settings.folderHubs = this.settings.folderHubs.filter((path) => path !== folder.path);
    await this.saveSettings();

    const hubPath = this.getHubPath(folder);
    const hub = this.app.vault.getAbstractFileByPath(hubPath);
    if (!(hub instanceof TFile)) return;

    try {
      const current = await this.app.vault.read(hub);
      const cleaned = removeManagedSection(current, HUB_START_MARKER, HUB_END_MARKER);
      if (cleaned === null) {
        new Notice("Colori found damaged graph-hub markers and left the note unchanged.");
        return;
      }

      if (deleteIfSafe) {
        const remaining = cleaned.trim();
        if (remaining === `# ${folder.name}`) {
          await this.app.vault.delete(hub);
          new Notice(`${folder.name} graph hub removed.`);
          return;
        }
        new Notice("Hub note contains other content, so Colori kept the note and removed only its managed links.");
      }

      if (cleaned !== current) await this.app.vault.modify(hub, cleaned);
      if (!deleteIfSafe) new Notice(`${folder.name} graph hub links removed and auto-sync disabled.`);
    } catch (error) {
      console.error("Colori: unable to remove folder graph hub", error);
      new Notice(`Unable to remove the ${folder.name} graph hub.`);
    }
  }

  getOutgoingConnections(sourcePath) {
    return this.settings.connections.filter((item) => item.source === sourcePath);
  }

  async addConnection(sourceFile, targetFile) {
    if (!(sourceFile instanceof TFile) || !(targetFile instanceof TFile)) return;
    if (sourceFile.extension !== "md" || targetFile.extension !== "md") return;
    if (sourceFile.path === targetFile.path) {
      new Notice("A note cannot be connected to itself.");
      return;
    }

    const exists = this.settings.connections.some(
      (item) => item.source === sourceFile.path && item.target === targetFile.path
    );
    if (!exists) {
      this.settings.connections.push({ source: sourceFile.path, target: targetFile.path });
      await this.saveSettings();
    }

    await this.syncConnectionSection(sourceFile, false);
  }

  async removeConnection(sourcePath, targetPath) {
    this.settings.connections = this.settings.connections.filter(
      (item) => !(item.source === sourcePath && item.target === targetPath)
    );
    await this.saveSettings();

    const source = this.app.vault.getAbstractFileByPath(sourcePath);
    if (source instanceof TFile) await this.syncConnectionSection(source, true);
  }

  async removeAllConnections(sourcePath) {
    this.settings.connections = this.settings.connections.filter((item) => item.source !== sourcePath);
    await this.saveSettings();

    const source = this.app.vault.getAbstractFileByPath(sourcePath);
    if (source instanceof TFile) await this.syncConnectionSection(source, true);
  }

  buildConnectionSection(sourceFile) {
    const targets = this.getOutgoingConnections(sourceFile.path)
      .map((item) => this.app.vault.getAbstractFileByPath(item.target))
      .filter((file) => file instanceof TFile && file.extension === "md")
      .sort((a, b) => a.basename.localeCompare(b.basename));

    if (!targets.length) return null;

    const links = targets.map(
      (file) => `- ${this.app.fileManager.generateMarkdownLink(file, sourceFile.path)}`
    );

    return [
      CONNECTIONS_START_MARKER,
      "## Colori connections",
      links.join("\n"),
      CONNECTIONS_END_MARKER
    ].join("\n");
  }

  async syncConnectionSection(sourceFile, silent = true) {
    if (!(sourceFile instanceof TFile) || sourceFile.extension !== "md") return;

    try {
      const current = await this.app.vault.read(sourceFile);
      const section = this.buildConnectionSection(sourceFile);
      const updated = section
        ? replaceManagedSection(current, CONNECTIONS_START_MARKER, CONNECTIONS_END_MARKER, section)
        : removeManagedSection(current, CONNECTIONS_START_MARKER, CONNECTIONS_END_MARKER);

      if (updated === null) {
        if (!silent) new Notice("Colori found damaged connection markers and did not modify the note.");
        return;
      }

      if (updated !== current) await this.app.vault.modify(sourceFile, updated);
      if (!silent) new Notice("Colori note connections updated.");
    } catch (error) {
      console.error("Colori: unable to sync note connections", error);
      if (!silent) new Notice("Unable to update Colori note connections.");
    }
  }

  async syncTrackedFolderPath(folderPath) {
    if (!folderPath || folderPath === "/" || !this.settings.folderHubs.includes(folderPath)) return;
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (folder instanceof TFolder) await this.syncFolderHub(folder, true);
  }

  async handleCreate(file) {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    const folderPath = file.parent?.path;
    if (!folderPath || folderPath === "/") return;

    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (folder instanceof TFolder && file.path === this.getHubPath(folder)) return;
    await this.syncTrackedFolderPath(folderPath);
  }

  async handleRename(file, oldPath) {
    const newPath = sanitizePath(file.path);
    const safeOldPath = sanitizePath(oldPath);
    if (!newPath || !safeOldPath || newPath === safeOldPath) return;

    const affectedSources = new Set();
    let changed = false;

    for (const override of this.settings.overrides) {
      if (override.path === safeOldPath) {
        override.path = newPath;
        changed = true;
      } else if (file instanceof TFolder && override.path.startsWith(`${safeOldPath}/`)) {
        override.path = `${newPath}${override.path.slice(safeOldPath.length)}`;
        changed = true;
      }
    }

    this.settings.folderHubs = this.settings.folderHubs.map((hubPath) => {
      if (hubPath === safeOldPath) {
        changed = true;
        return newPath;
      }
      if (file instanceof TFolder && hubPath.startsWith(`${safeOldPath}/`)) {
        changed = true;
        return `${newPath}${hubPath.slice(safeOldPath.length)}`;
      }
      return hubPath;
    });

    for (const connection of this.settings.connections) {
      const oldSource = connection.source;
      const oldTarget = connection.target;

      if (connection.source === safeOldPath) {
        connection.source = newPath;
      } else if (file instanceof TFolder && connection.source.startsWith(`${safeOldPath}/`)) {
        connection.source = `${newPath}${connection.source.slice(safeOldPath.length)}`;
      }

      if (connection.target === safeOldPath) {
        connection.target = newPath;
      } else if (file instanceof TFolder && connection.target.startsWith(`${safeOldPath}/`)) {
        connection.target = `${newPath}${connection.target.slice(safeOldPath.length)}`;
      }

      if (connection.source !== oldSource || connection.target !== oldTarget) {
        changed = true;
        affectedSources.add(connection.source);
      }
    }

    if (changed) await this.saveSettings();

    if (file instanceof TFile && file.extension === "md") {
      const oldParent = parentPath(safeOldPath);
      const newParent = file.parent?.path || parentPath(newPath);
      await this.syncTrackedFolderPath(oldParent);
      if (newParent !== oldParent) await this.syncTrackedFolderPath(newParent);
      affectedSources.add(newPath);
    } else if (file instanceof TFolder) {
      await this.syncTrackedFolderPath(newPath);
    }

    for (const sourcePath of affectedSources) {
      const source = this.app.vault.getAbstractFileByPath(sourcePath);
      if (source instanceof TFile) await this.syncConnectionSection(source, true);
    }
  }

  async handleDelete(file) {
    const deletedPath = sanitizePath(file.path);
    if (!deletedPath) return;

    const oldParent = file instanceof TFile
      ? file.parent?.path || parentPath(deletedPath)
      : parentPath(deletedPath);
    const affectedSources = new Set();

    const beforeOverrides = this.settings.overrides.length;
    this.settings.overrides = this.settings.overrides.filter(
      (override) => !pathMatchesOrDescends(override.path, deletedPath)
    );

    const beforeHubs = this.settings.folderHubs.length;
    this.settings.folderHubs = this.settings.folderHubs.filter(
      (hubPath) => !pathMatchesOrDescends(hubPath, deletedPath)
    );

    const beforeConnections = this.settings.connections.length;
    this.settings.connections = this.settings.connections.filter((connection) => {
      const sourceDeleted = pathMatchesOrDescends(connection.source, deletedPath);
      const targetDeleted = pathMatchesOrDescends(connection.target, deletedPath);
      if (!sourceDeleted && targetDeleted) affectedSources.add(connection.source);
      return !sourceDeleted && !targetDeleted;
    });

    if (
      this.settings.overrides.length !== beforeOverrides ||
      this.settings.folderHubs.length !== beforeHubs ||
      this.settings.connections.length !== beforeConnections
    ) {
      await this.saveSettings();
    }

    if (file instanceof TFile && file.extension === "md") {
      await this.syncTrackedFolderPath(oldParent);
    }

    for (const sourcePath of affectedSources) {
      const source = this.app.vault.getAbstractFileByPath(sourcePath);
      if (source instanceof TFile) await this.syncConnectionSection(source, true);
    }
  }

  async resetSettings() {
    this.settings = { ...DEFAULT_SETTINGS, overrides: [], folderHubs: [], connections: [] };
    await this.saveSettings();
  }
};

class ColoriLauncherModal extends Modal {
  constructor(app, plugin, file) {
    super(app);
    this.plugin = plugin;
    this.file = file;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ct-launcher-modal");
    contentEl.createEl("h2", { text: "Colori" });
    contentEl.createEl("p", { text: this.file.path, cls: "ct-path-preview" });

    const appearance = new Setting(contentEl)
      .setName("Customize appearance")
      .setDesc("Change this item's title color, font size, and icon.");
    appearance.settingEl.addClass("ct-launcher-option");
    appearance.addButton((button) =>
      button.setButtonText("Open").setIcon("chevron-right").onClick(() => {
        this.close();
        new AppearanceModal(this.app, this.plugin, this.file).open();
      })
    );

    const graph = new Setting(contentEl)
      .setName("Graph")
      .setDesc(
        this.file instanceof TFolder
          ? "Create and manage this folder's graph hub."
          : "Create and manage this note's Colori connections."
      );
    graph.settingEl.addClass("ct-launcher-option");
    graph.addButton((button) =>
      button.setButtonText("Open").setIcon("chevron-right").onClick(() => {
        this.close();
        new GraphModal(this.app, this.plugin, this.file).open();
      })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

class AppearanceModal extends Modal {
  constructor(app, plugin, file) {
    super(app);
    this.plugin = plugin;
    this.file = file;
    this.type = file instanceof TFolder ? "folder" : "file";
    this.path = file.path;

    const existing = plugin.getOverride(this.type, this.path);
    this.values = existing
      ? { ...existing }
      : {
          color: this.type === "folder" ? plugin.settings.folderColor : plugin.settings.noteColor,
          size: this.type === "folder" ? plugin.settings.folderSize : plugin.settings.noteSize,
          icon: ""
        };
  }

  onOpen() {
    this.render();
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ct-item-modal");
    contentEl.createEl("h2", { text: "Customize appearance" });
    contentEl.createEl("p", { text: this.path, cls: "ct-path-preview" });

    const appearance = new Setting(contentEl).setName("Title");
    appearance.settingEl.addClass("ct-inline-controls");
    appearance.addColorPicker((picker) =>
      picker.setValue(this.values.color).onChange((value) => {
        this.values.color = sanitizeColor(
          value,
          this.type === "folder" ? this.plugin.settings.folderColor : this.plugin.settings.noteColor
        );
      })
    );

    const sizeValue = appearance.controlEl.createSpan({
      text: `${this.values.size}px`,
      cls: "ct-size-value"
    });

    appearance.addSlider((slider) =>
      slider
        .setLimits(10, 40, 1)
        .setValue(this.values.size)
        .setDynamicTooltip()
        .onChange((value) => {
          this.values.size = sanitizeSize(value, 10, 40, 14);
          sizeValue.setText(`${this.values.size}px`);
        })
    );

    const iconSetting = new Setting(contentEl)
      .setName("Icon")
      .setDesc("Optional emoji or symbol.")
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
    iconSetting.settingEl.addClass("ct-clean-setting");

    const actions = new Setting(contentEl);
    actions.settingEl.addClass("ct-clean-setting", "ct-modal-actions");
    actions.addButton((button) =>
      button.setButtonText("Reset to default").onClick(async () => {
        await this.plugin.removeOverride(this.type, this.path);
        this.values = {
          color: this.type === "folder" ? this.plugin.settings.folderColor : this.plugin.settings.noteColor,
          size: this.type === "folder" ? this.plugin.settings.folderSize : this.plugin.settings.noteSize,
          icon: ""
        };
        this.render();
      })
    );
    actions.addButton((button) =>
      button.setButtonText("Save").setCta().onClick(async () => {
        await this.plugin.upsertOverride(this.type, this.path, this.values);
        new Notice("Colori appearance saved.");
        this.close();
      })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

class GraphModal extends Modal {
  constructor(app, plugin, file) {
    super(app);
    this.plugin = plugin;
    this.file = file;
  }

  onOpen() {
    this.render();
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ct-graph-modal");
    contentEl.createEl("h2", { text: "Graph" });
    contentEl.createEl("p", { text: this.file.path, cls: "ct-path-preview" });

    if (this.file instanceof TFolder) {
      const enabled = this.plugin.isFolderHubEnabled(this.file.path);
      const hub = new Setting(contentEl)
        .setName("Folder hub")
        .setDesc(
          enabled
            ? "Auto-sync is on. Colori keeps direct note links synchronized automatically."
            : "Create a hub note linked to every Markdown note directly inside this folder."
        );
      hub.settingEl.addClass("ct-clean-setting");
      hub.addButton((button) => {
        if (!enabled) {
          button.setButtonText("Enable hub").setCta().onClick(async () => {
            await this.plugin.enableFolderHub(this.file);
            this.render();
          });
        } else {
          button.setButtonText("Sync now").onClick(async () => {
            await this.plugin.syncFolderHub(this.file, false);
          });
        }
      });

      if (enabled) {
        const remove = new Setting(contentEl)
          .setName("Remove folder hub")
          .setDesc("Disable auto-sync and remove only the section managed by Colori.");
        remove.settingEl.addClass("ct-clean-setting");
        remove.addButton((button) =>
          button.setButtonText("Remove links").setWarning().onClick(async () => {
            await this.plugin.disableFolderHub(this.file, false);
            this.render();
          })
        );
        remove.addButton((button) =>
          button.setButtonText("Delete if safe").onClick(async () => {
            await this.plugin.disableFolderHub(this.file, true);
            this.close();
          })
        );
      }
    } else if (this.file instanceof TFile) {
      const count = this.plugin.getOutgoingConnections(this.file.path).length;

      const connect = new Setting(contentEl)
        .setName("Connect to note")
        .setDesc("Add a Colori-managed Obsidian link so the notes connect in Graph view.");
      connect.settingEl.addClass("ct-clean-setting");
      connect.addButton((button) =>
        button.setButtonText("Choose note…").setCta().onClick(() => {
          new NoteSuggestModal(this.app, this.file.path, async (target) => {
            await this.plugin.addConnection(this.file, target);
            this.render();
          }).open();
        })
      );

      const manage = new Setting(contentEl)
        .setName("Manage connections")
        .setDesc(`${count} outgoing Colori ${count === 1 ? "connection" : "connections"}.`);
      manage.settingEl.addClass("ct-clean-setting");
      manage.addButton((button) =>
        button.setButtonText("Manage…").onClick(() => {
          new ConnectionsModal(this.app, this.plugin, this.file).open();
        })
      );
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class NoteSuggestModal extends FuzzySuggestModal {
  constructor(app, excludedPath, onChoose) {
    super(app);
    this.excludedPath = excludedPath;
    this.onChoose = onChoose;
    this.setPlaceholder("Choose a note to connect…");
  }

  getItems() {
    return this.app.vault.getMarkdownFiles().filter((file) => file.path !== this.excludedPath);
  }

  getItemText(item) {
    return item.path;
  }

  onChooseItem(item) {
    this.onChoose(item);
  }
}

class ConnectionsModal extends Modal {
  constructor(app, plugin, sourceFile) {
    super(app);
    this.plugin = plugin;
    this.sourceFile = sourceFile;
  }

  onOpen() {
    this.render();
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ct-graph-modal");
    contentEl.createEl("h2", { text: "Colori connections" });
    contentEl.createEl("p", { text: this.sourceFile.path, cls: "ct-path-preview" });

    const connections = this.plugin.getOutgoingConnections(this.sourceFile.path);
    if (!connections.length) {
      contentEl.createEl("p", { text: "No outgoing Colori connections.", cls: "ct-muted" });
      return;
    }

    for (const connection of connections) {
      const row = new Setting(contentEl).setName(connection.target);
      row.settingEl.addClass("ct-clean-setting");
      row.addExtraButton((button) =>
        button.setIcon("trash").setTooltip("Remove connection").onClick(async () => {
          await this.plugin.removeConnection(connection.source, connection.target);
          this.render();
        })
      );
    }

    const removeAll = new Setting(contentEl)
      .setName("Remove all")
      .setDesc("Remove every Colori-managed outgoing connection from this note.");
    removeAll.settingEl.addClass("ct-clean-setting");
    removeAll.addButton((button) =>
      button.setButtonText("Remove all").setWarning().onClick(async () => {
        await this.plugin.removeAllConnections(this.sourceFile.path);
        this.render();
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

    containerEl.createEl("h2", { text: "Colori Dev" });
    containerEl.createEl("p", {
      text: "Global styles apply everywhere. Individual overrides take priority. Right-click a note or folder and choose Colori for item-specific controls."
    });

    this.addSection("File explorer");
    this.addColorAndSize("Folder title", "Folder title color and font size.", "folderColor", "folderSize", 10, 30);
    this.addIcon("Folder icon", "Optional icon shown before every folder title.", "folderIcon");
    this.addColorAndSize("Note title", "Note title color and font size.", "noteColor", "noteSize", 10, 30);
    this.addIcon("Note icon", "Optional icon shown before every note title.", "noteIcon");
    this.addColorAndSize("Active note title", "Selected note title color and font size.", "activeNoteColor", "activeNoteSize", 10, 30);

    this.addSection("Individual overrides");

    new Setting(containerEl)
      .setName("Add folder override")
      .setDesc("Choose a folder and give it its own color, size, and icon.")
      .addButton((button) =>
        button.setButtonText("Choose folder").onClick(() => {
          new VaultItemSuggestModal(this.app, "folder", (folder) => {
            new AppearanceModal(this.app, this.plugin, folder).open();
          }).open();
        })
      );

    new Setting(containerEl)
      .setName("Add note override")
      .setDesc("Choose a note and give it its own color, size, and icon.")
      .addButton((button) =>
        button.setButtonText("Choose note").onClick(() => {
          new VaultItemSuggestModal(this.app, "file", (file) => {
            new AppearanceModal(this.app, this.plugin, file).open();
          }).open();
        })
      );

    if (!this.plugin.settings.overrides.length) {
      containerEl.createEl("p", { text: "No individual overrides yet.", cls: "ct-muted" });
    } else {
      const sorted = [...this.plugin.settings.overrides].sort((a, b) => a.path.localeCompare(b.path));
      for (const override of sorted) {
        const file = this.app.vault.getAbstractFileByPath(override.path);
        const label = `${override.icon ? `${override.icon} ` : ""}${override.path}`;
        new Setting(containerEl)
          .setName(label)
          .setDesc(`${override.type === "folder" ? "Folder" : "Note"} · ${override.size}px · ${override.color}`)
          .addButton((button) =>
            button.setButtonText("Edit").onClick(() => {
              if (file instanceof TFile || file instanceof TFolder) {
                new AppearanceModal(this.app, this.plugin, file).open();
              } else {
                new Notice("That vault item no longer exists.");
              }
            })
          )
          .addExtraButton((button) =>
            button.setIcon("trash").setTooltip("Remove override").onClick(async () => {
              await this.plugin.removeOverride(override.type, override.path);
              this.display();
            })
          );
      }
    }

    this.addSection("Note title");
    this.addColorAndSize("Inline title", "Inline note title color and font size.", "inlineTitleColor", "inlineTitleSize", 12, 60);

    this.addSection("Markdown headings");
    for (let level = 1; level <= 6; level++) {
      this.addColorAndSize(
        `Heading ${level}`,
        `H${level} color and font size in Reading view and Live Preview.`,
        `h${level}Color`,
        `h${level}Size`,
        10,
        60
      );
    }

    this.addSection("Reset");
    new Setting(containerEl)
      .setName("Restore defaults")
      .setDesc("Restore global defaults, remove all individual overrides, and forget Colori graph configuration. Managed Markdown sections are not deleted automatically.")
      .addButton((button) =>
        button.setButtonText("Reset").setWarning().onClick(async () => {
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
    const setting = new Setting(this.containerEl).setName(name);
    setting.settingEl.addClass("ct-compact-setting");
    setting.nameEl.setAttr("title", description);

    setting.addColorPicker((picker) => {
      picker.setValue(this.plugin.settings[colorKey]).onChange(async (value) => {
        this.plugin.settings[colorKey] = sanitizeColor(value, DEFAULT_SETTINGS[colorKey]);
        await this.plugin.saveSettings();
      });
    });

    const sizeValue = setting.controlEl.createSpan({
      text: `${this.plugin.settings[sizeKey]} px`,
      cls: "ct-size-value"
    });

    setting.addSlider((slider) => {
      slider
        .setLimits(min, max, 1)
        .setValue(this.plugin.settings[sizeKey])
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings[sizeKey] = sanitizeSize(value, min, max, DEFAULT_SETTINGS[sizeKey]);
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
