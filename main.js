const {
  Plugin,
  PluginSettingTab,
  Setting,
  ItemView,
  MarkdownView,
  FuzzySuggestModal,
  Notice,
  TFile,
  TFolder,
} = require("obsidian");

const VIEW_TYPE = "colori-note-tools";
const CONNECTIONS_START = "<!-- colori-connections:start -->";
const CONNECTIONS_END = "<!-- colori-connections:end -->";
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_ICON_CODE_POINTS = 12;
const MAX_PATH_LENGTH = 4096;
const IOC_LIMITS = new Set([10, 25, 50, 100, 250]);
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
  safeLinksEnabled: true,
  graphMatchNoteColors: false,
  overrides: [],
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

function sanitizeColor(value, fallback) {
  return typeof value === "string" && HEX_COLOR_RE.test(value) ? value.toLowerCase() : fallback;
}

function sanitizeSize(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(Math.min(max, Math.max(min, number)));
}

function sanitizeIcon(value) {
  if (typeof value !== "string") return "";
  return Array.from(value.replace(/[\u0000-\u001f\u007f]/g, ""))
    .slice(0, MAX_ICON_CODE_POINTS)
    .join("");
}

function sanitizePath(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\u0000/g, "").replace(/\\/g, "/").trim();
  return cleaned && cleaned.length <= MAX_PATH_LENGTH ? cleaned : null;
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

function isWebDestination(value) {
  if (typeof value !== "string") return false;
  const text = value.trim().replace(/^<|>$/g, "");
  return /^(?:https?:\/\/)?(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:[\/?#].*)?$/i.test(text);
}

function defangDestination(value) {
  if (typeof value !== "string" || !value) return value;
  let text = value.trim().replace(/^<|>$/g, "");
  text = text.replace(/^https:\/\//i, "hxxps://").replace(/^http:\/\//i, "hxxp://");
  const schemeMatch = text.match(/^(hxxps?:\/\/)([^\/?#]+)(.*)$/i);
  if (schemeMatch) {
    return `${schemeMatch[1]}${schemeMatch[2].replace(/\./g, "[.]")}${schemeMatch[3]}`;
  }
  const hostMatch = text.match(/^([^\/?#]+)(.*)$/);
  return hostMatch ? `${hostMatch[1].replace(/\./g, "[.]")}${hostMatch[2]}` : text;
}

function refangDestination(value) {
  if (typeof value !== "string" || !value) return value;
  return value
    .replace(/^hxxps:\/\//i, "https://")
    .replace(/^hxxp:\/\//i, "http://")
    .replace(/\[\.\]/g, ".");
}

function defangUrlText(value) {
  if (typeof value !== "string" || !value) return value;
  let output = value;

  // Markdown inline links: remove the clickable wrapper completely.
  output = output.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (full, label, destination) => {
    if (!isWebDestination(destination)) return full;
    return `${label} - ${defangDestination(destination)}`;
  });

  // Markdown autolinks such as <https://example.com>.
  output = output.replace(/<((?:https?:\/\/)?(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,63}[^>]*)>/gi, (full, destination) => {
    if (!isWebDestination(destination)) return full;
    return defangDestination(destination);
  });

  // Raw HTTP(S) URLs.
  output = output.replace(/\bhttps?:\/\/[^\s<>"'`\])]+/gi, (url) => defangDestination(url));

  // Bare domains that have not already been defanged.
  output = output.replace(/\b(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:[\/?#][^\s<>"'`]*)?/gi, (domain, offset, whole) => {
    const before = whole.slice(Math.max(0, offset - 8), offset).toLowerCase();
    if (before.endsWith("hxxps://") || before.endsWith("hxxp://")) return domain;
    if (domain.includes("[.]")) return domain;
    return defangDestination(domain);
  });

  return output;
}

function refangUrlText(value) {
  if (typeof value !== "string" || !value) return value;
  let output = value;

  // Reverse Colori's clean Markdown-link defang format:
  // Label - hxxps://example[.]com  ->  [Label](https://example.com)
  // Label - example[.]com          ->  [Label](example.com)
  output = output.replace(/^(\s*(?:[-*>]\s*)?)(.+?)\s+-\s+((?:hxxps?:\/\/)?(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\[\.\])+[a-z]{2,63}(?::\d{1,5})?(?:[\/?#][^\s]*)?)\s*$/gim, (full, prefix, label, destination) => {
    const cleanLabel = label.trim();
    const cleanDestination = refangDestination(destination);
    return cleanLabel ? `${prefix}[${cleanLabel}](${cleanDestination})` : full;
  });

  return output
    .replace(/\bhxxps?:\/\/[^\s<>"'`]+/gi, (url) => refangDestination(url))
    .replace(/\b(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\[\.\])+[a-z]{2,63}(?::\d{1,5})?(?:[\/?#][^\s<>"'`]*)?/gi, (domain) => refangDestination(domain));
}

function normalizeOverride(raw, settings) {
  if (!raw || !["folder", "file", "folder-note"].includes(raw.type)) return null;
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
  const result = { ...DEFAULT_SETTINGS, overrides: [], connections: [] };

  for (const [key] of Object.entries(CSS_VARIABLES)) {
    if (key.endsWith("Color")) result[key] = sanitizeColor(source[key], DEFAULT_SETTINGS[key]);
    else if (key.endsWith("Size")) {
      const [min, max] = SIZE_LIMITS[key];
      result[key] = sanitizeSize(source[key], min, max, DEFAULT_SETTINGS[key]);
    }
  }

  result.folderIcon = sanitizeIcon(source.folderIcon);
  result.noteIcon = sanitizeIcon(source.noteIcon);
  result.safeLinksEnabled = source.safeLinksEnabled !== false;
  result.graphMatchNoteColors = source.graphMatchNoteColors === true;

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
  return after;
}

function graphColor(value) {
  const safe = sanitizeColor(value, null);
  return safe ? { a: 1, rgb: Number.parseInt(safe.slice(1), 16) } : null;
}

module.exports = class ColoriPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.graphOriginalColors = new WeakMap();
    this.lastMarkdownPath = null;
    this.blockNoticeShown = false;

    this.overrideStyleEl = document.createElement("style");
    this.overrideStyleEl.id = "colori-overrides";
    document.head.appendChild(this.overrideStyleEl);
    this.register(() => this.overrideStyleEl?.remove());

    this.applySettings();
    this.addSettingTab(new ColoriSettingTab(this.app, this));
    this.registerView(VIEW_TYPE, (leaf) => new NoteToolsView(leaf, this));
    this.addRibbonIcon("shield-check", "Open Note Tools", () => this.openSidebar());

    this.addCommand({ id: "open-note-tools", name: "Open Note Tools sidebar", callback: () => this.openSidebar() });
    this.addCommand({
      id: "defang-current-note",
      name: "Defang selection or current note",
      editorCallback: (editor, view) => this.transformEditor(editor, view?.file, "defang")
    });
    this.addCommand({
      id: "refang-current-note",
      name: "Refang selection or current note",
      editorCallback: (editor, view) => this.transformEditor(editor, view?.file, "refang")
    });

    this.addCommand({
      id: "connect-current-note",
      name: "Connect current note…",
      callback: () => {
        const file = this.getTrackedFile();
        if (!(file instanceof TFile)) { new Notice("Open a Markdown note first."); return; }
        new NoteSuggestModal(this.app, file.path, async (target) => {
          await this.addConnection(file, target);
          new Notice(`Connected to ${target.basename}.`);
          this.refreshSidebar();
        }).open();
      }
    });

    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== "md") return;
      menu.addItem((item) => item
        .setTitle("Colori: Connect note…")
        .setIcon("link")
        .onClick(() => {
          new NoteSuggestModal(this.app, file.path, async (target) => {
            await this.addConnection(file, target);
            new Notice(`Connected ${file.basename} to ${target.basename}.`);
            this.refreshSidebar();
          }).open();
        }));
    }));

    const rememberMarkdown = () => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!(view?.file instanceof TFile)) return;
      const changed = this.lastMarkdownPath !== view.file.path;
      this.lastMarkdownPath = view.file.path;
      if (changed) this.refreshSidebar();
    };
    this.registerEvent(this.app.workspace.on("file-open", rememberMarkdown));
    this.registerEvent(this.app.workspace.on("active-leaf-change", rememberMarkdown));

    const blockSafeLink = (event) => this.blockSafeLinkEvent(event);
    for (const eventName of ["pointerdown", "mousedown", "click", "auxclick"]) {
      this.registerDomEvent(document, eventName, blockSafeLink, true);
    }

    this.registerEvent(this.app.workspace.on("layout-change", () => this.applyGraphNodeColors()));
    this.registerInterval(window.setInterval(() => {
      if (this.settings.graphMatchNoteColors) this.applyGraphNodeColors();
    }, 750));

    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.handleRename(file, oldPath)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.handleDelete(file)));
  }

  onunload() {
    this.restoreGraphNodeColors();
    this.clearSettings();
  }

  async loadSettings() {
    this.settings = normalizeSettings(await this.loadData());
  }

  async saveSettings() {
    this.settings = normalizeSettings(this.settings);
    await this.saveData(this.settings);
    this.applySettings();
    if (this.settings.graphMatchNoteColors) this.applyGraphNodeColors();
    else this.restoreGraphNodeColors();
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
    for (const name of ["--ct-folder-icon", "--ct-note-icon", "--graph-node", "--graph-node-focused"]) {
      root.style.removeProperty(name);
    }
  }

  renderOverrideCss() {
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

  getOverride(type, path) {
    return this.settings.overrides.find((item) => item.type === type && item.path === path);
  }

  async upsertOverride(type, path, values) {
    const safePath = sanitizePath(path);
    if (!["folder", "file", "folder-note"].includes(type) || !safePath) return;
    const fallbackColor = type === "folder" ? this.settings.folderColor : this.settings.noteColor;
    const fallbackSize = type === "folder" ? this.settings.folderSize : this.settings.noteSize;
    const safe = {
      color: sanitizeColor(values.color, fallbackColor),
      size: sanitizeSize(values.size, 10, 40, fallbackSize),
      icon: sanitizeIcon(values.icon)
    };
    const existing = this.getOverride(type, safePath);
    if (existing) Object.assign(existing, safe);
    else this.settings.overrides.push({ type, path: safePath, ...safe });
    await this.saveSettings();
  }

  async removeOverride(type, path) {
    this.settings.overrides = this.settings.overrides.filter((item) => !(item.type === type && item.path === path));
    await this.saveSettings();
  }

  getWebDestinationFromEvent(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return null;

    const anchor = target.closest("a[href]");
    if (anchor) {
      const href = anchor.getAttribute("href") || "";
      if (isWebDestination(href)) return href;
      try {
        const url = new URL(anchor.href);
        if (url.protocol === "http:" || url.protocol === "https:") return anchor.href;
      } catch (_) {}
    }

    const urlToken = target.closest(".cm-url, .cm-link, .external-link");
    if (urlToken) {
      const text = (urlToken.textContent || "").trim().replace(/^\(|\)$/g, "");
      if (isWebDestination(text)) return text;

      const line = urlToken.closest(".cm-line");
      if (line) {
        const lineText = line.textContent || "";
        const candidates = lineText.match(/(?:https?:\/\/)?(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,63}(?:[\/?#][^\s)]*)?/gi) || [];
        const candidate = candidates.find((item) => isWebDestination(item));
        if (candidate) return candidate;
      }
    }

    return null;
  }

  blockSafeLinkEvent(event) {
    if (!this.settings.safeLinksEnabled || event.ctrlKey || event.metaKey) return;
    const destination = this.getWebDestinationFromEvent(event);
    if (!destination) return;

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();

    if (event.type === "click" && !this.blockNoticeShown) {
      this.blockNoticeShown = true;
      new Notice("External web link blocked. Hold Ctrl/Cmd while clicking to open it.");
    }
  }

  getTrackedFile() {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    if (active instanceof TFile) {
      this.lastMarkdownPath = active.path;
      return active;
    }
    const stored = this.lastMarkdownPath ? this.app.vault.getAbstractFileByPath(this.lastMarkdownPath) : null;
    return stored instanceof TFile && stored.extension === "md" ? stored : null;
  }

  getEditorForFile(file) {
    if (!(file instanceof TFile)) return null;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === file.path && view.editor) return view.editor;
    }
    return null;
  }

  transformEditor(editor, file, mode) {
    if (!editor) return false;
    const transform = mode === "refang" ? refangUrlText : defangUrlText;
    const selection = editor.getSelection();
    if (selection) {
      const updated = transform(selection);
      if (updated !== selection) editor.replaceSelection(updated);
      return updated !== selection;
    }
    const current = editor.getValue();
    const updated = transform(current);
    if (updated !== current) editor.setValue(updated);
    if (file instanceof TFile) this.lastMarkdownPath = file.path;
    return updated !== current;
  }

  async transformTrackedNote(mode) {
    const file = this.getTrackedFile();
    if (!file) return false;
    const transform = mode === "refang" ? refangUrlText : defangUrlText;
    const editor = this.getEditorForFile(file);

    if (editor) {
      const selection = editor.getSelection();
      if (selection) {
        const updatedSelection = transform(selection);
        if (updatedSelection === selection) return false;
        editor.replaceSelection(updatedSelection);
        new Notice(mode === "refang" ? "Selection refanged." : "Selection defanged.");
        return true;
      }

      const current = editor.getValue();
      const updated = transform(current);
      if (updated === current) return false;
      editor.setValue(updated);
      new Notice(mode === "refang" ? "Note refanged." : "Note defanged.");
      return true;
    }

    const current = await this.app.vault.read(file);
    const updated = transform(current);
    if (updated === current) return false;
    await this.app.vault.modify(file, updated);
    new Notice(mode === "refang" ? "Note refanged." : "Note defanged.");
    return true;
  }


  getUrlHosts(text) {
    const source = typeof text === "string" ? text : "";
    const hosts = new Set();
    const regex = /\b(?:https?|hxxps?):\/\/([^\s<>"'`\/?)#]+)/gi;
    let match;
    while ((match = regex.exec(source))) {
      const host = match[1].replace(/:\d+$/, "").replace(/\[\.\]/g, ".").toLowerCase();
      if (host) hosts.add(host);
      if (match.index === regex.lastIndex) regex.lastIndex++;
    }
    return hosts;
  }

  scanIocs(text, type, limit) {
    const source = typeof text === "string" ? text : "";
    const safeLimit = limit === "all" ? Number.POSITIVE_INFINITY : (IOC_LIMITS.has(Number(limit)) ? Number(limit) : Number.POSITIVE_INFINITY);
    const wanted = ["all", "url", "ip", "domain", "hash", "email"].includes(type) ? type : "all";
    const results = [];
    const seen = new Set();
    const urlHosts = this.getUrlHosts(source);

    const add = (kind, value) => {
      const normalized = value.trim();
      const key = `${kind}:${normalized.toLowerCase()}`;
      if (!normalized || seen.has(key) || results.length >= safeLimit) return;
      seen.add(key);
      results.push({ type: kind, value: normalized });
    };

    const run = (kind, regex, validate) => {
      regex.lastIndex = 0;
      let match;
      while (results.length < safeLimit && (match = regex.exec(source))) {
        if (!validate || validate(match[0])) add(kind, match[0]);
        if (match.index === regex.lastIndex) regex.lastIndex++;
      }
    };

    if (wanted === "all" || wanted === "url") run("URL", /\b(?:https?|hxxps?):\/\/[^\s<>"'`\)]+/gi);
    if (wanted === "all" || wanted === "ip") run("IP", /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (value) => value.split(".").every((part) => Number(part) <= 255));
    if (wanted === "all" || wanted === "hash") run("Hash", /\b(?:[a-f0-9]{64}|[a-f0-9]{40}|[a-f0-9]{32})\b/gi);
    if (wanted === "all" || wanted === "email") run("Email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi);
    if (wanted === "all" || wanted === "domain") run("Domain", /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.|\[\.\]))+[a-z]{2,63}\b/gi, (value) => {
      const normalized = value.replace(/\[\.\]/g, ".").toLowerCase();
      return !urlHosts.has(normalized);
    });
    return Number.isFinite(safeLimit) ? results.slice(0, safeLimit) : results;
  }

  countIocs(text) {
    const source = typeof text === "string" ? text : "";
    const counts = { URL: 0, IP: 0, Domain: 0, Hash: 0, Email: 0 };
    const urlHosts = this.getUrlHosts(source);
    const countMatches = (kind, regex, validate) => {
      regex.lastIndex = 0;
      let match;
      const seen = new Set();
      while ((match = regex.exec(source))) {
        const value = match[0];
        if ((!validate || validate(value)) && !seen.has(value.toLowerCase())) {
          seen.add(value.toLowerCase());
          counts[kind]++;
        }
        if (match.index === regex.lastIndex) regex.lastIndex++;
      }
    };
    countMatches("URL", /\b(?:https?|hxxps?):\/\/[^\s<>"'`\)]+/gi);
    countMatches("IP", /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (value) => value.split(".").every((part) => Number(part) <= 255));
    countMatches("Hash", /\b(?:[a-f0-9]{64}|[a-f0-9]{40}|[a-f0-9]{32})\b/gi);
    countMatches("Email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi);
    countMatches("Domain", /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.|\[\.\]))+[a-z]{2,63}\b/gi, (value) => {
      const normalized = value.replace(/\[\.\]/g, ".").toLowerCase();
      return !urlHosts.has(normalized);
    });
    counts.Total = counts.URL + counts.IP + counts.Domain + counts.Hash + counts.Email;
    return counts;
  }


  async openSidebar() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  refreshSidebar() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof NoteToolsView) leaf.view.render();
    }
  }

  getGraphRenderers() {
    const renderers = [];
    for (const type of ["graph", "localgraph"]) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        if (leaf?.view?.renderer?.nodes) renderers.push(leaf.view.renderer);
      }
    }
    return renderers;
  }

  getGraphNodes(renderer) {
    const nodes = renderer?.nodes;
    if (!nodes) return [];
    if (Array.isArray(nodes)) return nodes;
    if (nodes instanceof Map) return Array.from(nodes.values());
    if (typeof nodes.values === "function") {
      try { return Array.from(nodes.values()); } catch (_) {}
    }
    return Object.values(nodes);
  }

  getGraphNodePath(node) {
    if (!node || typeof node.id !== "string") return null;
    const raw = sanitizePath(node.id);
    if (!raw) return null;
    const direct = this.app.vault.getAbstractFileByPath(raw);
    if (direct instanceof TFile && direct.extension === "md") return direct.path;
    const withMd = this.app.vault.getAbstractFileByPath(raw.toLowerCase().endsWith(".md") ? raw : `${raw}.md`);
    return withMd instanceof TFile && withMd.extension === "md" ? withMd.path : null;
  }

  applyGraphNodeColors() {
    if (!this.settings.graphMatchNoteColors) return;
    try {
      for (const renderer of this.getGraphRenderers()) {
        for (const node of this.getGraphNodes(renderer)) {
          const path = this.getGraphNodePath(node);
          const override = path ? this.getEffectiveNoteOverride(path) : null;
          if (!override) continue;
          const color = graphColor(override.color);
          if (!color) continue;
          if (!this.graphOriginalColors.has(node)) this.graphOriginalColors.set(node, node.color);
          node.color = color;
        }
      }
    } catch (error) {
      console.error("Colori: unable to apply graph colors", error);
    }
  }

  restoreGraphNodeColors() {
    try {
      for (const renderer of this.getGraphRenderers()) {
        for (const node of this.getGraphNodes(renderer)) {
          if (!this.graphOriginalColors.has(node)) continue;
          node.color = this.graphOriginalColors.get(node);
          this.graphOriginalColors.delete(node);
        }
      }
    } catch (error) {
      console.error("Colori: unable to restore graph colors", error);
    }
  }

  getOutgoingConnections(sourcePath) {
    return this.settings.connections.filter((item) => item.source === sourcePath);
  }

  getConnectionsFor(path) {
    const safePath = sanitizePath(path);
    if (!safePath) return [];
    const seen = new Set();
    const results = [];
    for (const item of this.settings.connections) {
      let otherPath = null;
      if (item.source === safePath) otherPath = item.target;
      else if (item.target === safePath) otherPath = item.source;
      if (!otherPath || seen.has(otherPath)) continue;
      const file = this.app.vault.getAbstractFileByPath(otherPath);
      if (!(file instanceof TFile) || file.extension !== "md") continue;
      seen.add(otherPath);
      results.push({ file, source: item.source, target: item.target });
    }
    return results.sort((a, b) => a.file.basename.localeCompare(b.file.basename));
  }

  async addConnection(sourceFile, targetFile) {
    if (!(sourceFile instanceof TFile) || !(targetFile instanceof TFile) || sourceFile.path === targetFile.path) return;
    const exists = this.settings.connections.some((item) => item.source === sourceFile.path && item.target === targetFile.path);
    if (!exists) {
      this.settings.connections.push({ source: sourceFile.path, target: targetFile.path });
      await this.saveSettings();
    }
    await this.syncConnectionSection(sourceFile, false);
  }

  async removeConnection(sourcePath, targetPath) {
    this.settings.connections = this.settings.connections.filter((item) => !(item.source === sourcePath && item.target === targetPath));
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
    const links = targets.map((file) => `- ${this.app.fileManager.generateMarkdownLink(file, sourceFile.path)}`);
    return [CONNECTIONS_START, "## Colori connections", links.join("\n"), CONNECTIONS_END].join("\n");
  }

  async syncConnectionSection(sourceFile, silent = true) {
    if (!(sourceFile instanceof TFile) || sourceFile.extension !== "md") return;
    try {
      const current = await this.app.vault.read(sourceFile);
      const section = this.buildConnectionSection(sourceFile);
      const updated = section
        ? replaceManagedSection(current, CONNECTIONS_START, CONNECTIONS_END, section)
        : removeManagedSection(current, CONNECTIONS_START, CONNECTIONS_END);
      if (updated === null) {
        if (!silent) new Notice("Damaged Colori connection markers found; note was not changed.");
        return;
      }
      if (updated !== current) await this.app.vault.modify(sourceFile, updated);
    } catch (error) {
      console.error("Colori: unable to sync connections", error);
    }
  }

  async handleRename(file, oldPath) {
    const newPath = sanitizePath(file.path);
    const safeOldPath = sanitizePath(oldPath);
    if (!newPath || !safeOldPath || newPath === safeOldPath) return;
    let changed = false;

    for (const override of this.settings.overrides) {
      if (override.path === safeOldPath) { override.path = newPath; changed = true; }
      else if (file instanceof TFolder && override.path.startsWith(`${safeOldPath}/`)) {
        override.path = `${newPath}${override.path.slice(safeOldPath.length)}`; changed = true;
      }
    }


    for (const connection of this.settings.connections) {
      if (connection.source === safeOldPath) { connection.source = newPath; changed = true; }
      else if (file instanceof TFolder && connection.source.startsWith(`${safeOldPath}/`)) {
        connection.source = `${newPath}${connection.source.slice(safeOldPath.length)}`; changed = true;
      }
      if (connection.target === safeOldPath) { connection.target = newPath; changed = true; }
      else if (file instanceof TFolder && connection.target.startsWith(`${safeOldPath}/`)) {
        connection.target = `${newPath}${connection.target.slice(safeOldPath.length)}`; changed = true;
      }
    }

    if (this.lastMarkdownPath === safeOldPath) this.lastMarkdownPath = newPath;
    if (changed) await this.saveSettings();
  }

  async handleDelete(file) {
    const deletedPath = sanitizePath(file.path);
    if (!deletedPath) return;
    const before = JSON.stringify([this.settings.overrides, this.settings.connections]);
    this.settings.overrides = this.settings.overrides.filter((item) => !pathMatchesOrDescends(item.path, deletedPath));
    this.settings.connections = this.settings.connections.filter((item) => !pathMatchesOrDescends(item.source, deletedPath) && !pathMatchesOrDescends(item.target, deletedPath));
    if (this.lastMarkdownPath && pathMatchesOrDescends(this.lastMarkdownPath, deletedPath)) this.lastMarkdownPath = null;
    const after = JSON.stringify([this.settings.overrides, this.settings.connections]);
    if (before !== after) await this.saveSettings();
  }

  async resetSettings() {
    this.settings = { ...DEFAULT_SETTINGS, overrides: [], connections: [] };
    await this.saveSettings();
  }
};

class NoteToolsView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.openSections = new Set();
    this.scanTypes = new Set(["url", "ip", "domain", "hash", "email"]);
    this.scanLimit = "all";
    this.scanResults = null;
    this.scanPath = null;
    this.appearanceScope = "note";
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Note Tools"; }
  getIcon() { return "shield-check"; }

  async onOpen() { await this.render(); }

  makeDropdown(parent, key, title) {
    const details = parent.createEl("details", { cls: "ct-tools-dropdown" });
    details.open = this.openSections.has(key);
    details.addEventListener("toggle", () => {
      if (details.open) this.openSections.add(key);
      else this.openSections.delete(key);
    });
    details.createEl("summary", { text: title });
    return details.createDiv({ cls: "ct-tools-dropdown-body" });
  }

  async readTrackedText(file) {
    const editor = this.plugin.getEditorForFile(file);
    return editor ? editor.getValue() : this.app.vault.cachedRead(file);
  }


  countRenderedImages(file) {
    if (!(file instanceof TFile)) return 0;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf?.view;
      if (!(view instanceof MarkdownView) || view.file?.path !== file.path || !view.contentEl) continue;

      const images = new Set();
      for (const image of view.contentEl.querySelectorAll(".markdown-preview-view img, .markdown-source-view img")) {
        if (image instanceof HTMLImageElement) images.add(image);
      }
      return images.size;
    }
    return 0;
  }

  countImageEmbeds(file, text) {
    const source = typeof text === "string" ? text : "";
    let count = 0;
    const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"]);

    // Parse standard Markdown images with balanced destination parentheses.
    // This handles ordinary paths/URLs and very large inline data:image/... payloads.
    let cursor = 0;
    while (cursor < source.length) {
      const start = source.indexOf("![", cursor);
      if (start < 0) break;

      // ![[...]] is Obsidian wiki-embed syntax; handle it separately below.
      if (source[start + 2] === "[") {
        cursor = start + 3;
        continue;
      }

      let altEnd = start + 2;
      let escaped = false;
      for (; altEnd < source.length; altEnd++) {
        const ch = source[altEnd];
        if (escaped) { escaped = false; continue; }
        if (ch === "\\") { escaped = true; continue; }
        if (ch === "]") break;
      }

      if (altEnd >= source.length || source[altEnd] !== "]") {
        cursor = start + 2;
        continue;
      }

      let pos = altEnd + 1;
      while (pos < source.length && /\s/.test(source[pos])) pos++;
      if (source[pos] !== "(") {
        cursor = altEnd + 1;
        continue;
      }

      let depth = 1;
      let quote = "";
      escaped = false;
      pos++;
      for (; pos < source.length; pos++) {
        const ch = source[pos];
        if (escaped) { escaped = false; continue; }
        if (ch === "\\") { escaped = true; continue; }

        if (quote) {
          if (ch === quote) quote = "";
          continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth === 0) {
            count++;
            pos++;
            break;
          }
        }
      }

      cursor = Math.max(start + 2, pos);
    }

    // Obsidian wiki image embeds: ![[attachment]] or ![[attachment|size]].
    // Metadata only resolves embeds that are actually present in current source.
    const wiki = /!\[\[([^\]]+)\]\]/g;
    let match;
    while ((match = wiki.exec(source))) {
      const target = String(match[1] || "").split("|", 1)[0].split("#", 1)[0].trim();
      const resolved = target && file instanceof TFile
        ? this.app.metadataCache.getFirstLinkpathDest(target, file.path)
        : null;

      let extension = "";
      if (resolved instanceof TFile) {
        extension = String(resolved.extension || "").toLowerCase();
      } else {
        const clean = target.split(/[?#]/, 1)[0];
        if (clean.includes(".")) extension = clean.slice(clean.lastIndexOf(".") + 1).toLowerCase();
      }

      if (imageExtensions.has(extension)) count++;
      if (match.index === wiki.lastIndex) wiki.lastIndex++;
    }

    // Raw HTML image tags.
    count += (source.match(/<img\b[^>]*>/gi) || []).length;

    return Math.max(count, this.countRenderedImages(file));
  }

  renderNoteInfo(parent, file, text, counts) {
    const infoCard = parent.createDiv({ cls: "ct-note-info-card" });
    infoCard.createEl("div", { text: "Note Info", cls: "ct-note-info-title" });
    const infoGrid = infoCard.createDiv({ cls: "ct-note-info" });
    const words = (text.match(/\S+/g) || []).length;
    const lines = text ? text.split(/\r?\n/).length : 0;
    const images = this.countImageEmbeds(file, text);
    const size = file.stat.size < 1024 ? `${file.stat.size} B` : `${(file.stat.size / 1024).toFixed(1)} KB`;

    const addInfoRow = (name, value, valueClass = "") => {
      infoGrid.createEl("span", { text: name, cls: "ct-note-info-label" });
      infoGrid.createEl("span", { text: String(value), cls: `ct-note-info-value ${valueClass}`.trim() });
    };

    addInfoRow("Total IOCs", counts.Total, "ct-note-info-ioc-total");

    addInfoRow("Words", words);
    addInfoRow("Lines", lines);
    addInfoRow("Images", images);
    addInfoRow("File size", size);
    addInfoRow("Created", new Date(file.stat.ctime).toLocaleString());
    addInfoRow("Modified", new Date(file.stat.mtime).toLocaleString());
  }

  async render() {
    const container = this.containerEl.children[1];
    if (!container) return;
    container.empty();
    container.addClass("ct-sidebar");
    const sidebarHeader = container.createDiv({ cls: "ct-sidebar-header" });
    sidebarHeader.createDiv({ text: "Colori", cls: "ct-sidebar-brand" });
    sidebarHeader.createDiv({ text: "NOTE WORKSPACE", cls: "ct-sidebar-subtitle" });

    const file = this.plugin.getTrackedFile();
    if (!(file instanceof TFile)) {
      container.createEl("p", { text: "Open a Markdown note to use these tools.", cls: "ct-muted" });
      return;
    }

    this.plugin.lastMarkdownPath = file.path;
    if (this.scanPath && this.scanPath !== file.path) {
      this.scanResults = null;
      this.scanPath = null;
    }

    container.createEl("div", { text: file.basename, cls: "ct-sidebar-note" });
    container.createEl("div", { text: file.path, cls: "ct-sidebar-path" });

    const text = await this.readTrackedText(file);
    const counts = this.plugin.countIocs(text);

    const safeRow = container.createDiv({ cls: "ct-safe-links-row" });
    safeRow.createSpan({ text: "Safe Links" });
    const safeToggle = safeRow.createEl("button", {
      text: this.plugin.settings.safeLinksEnabled ? "ON" : "OFF",
      cls: this.plugin.settings.safeLinksEnabled ? "mod-cta" : ""
    });
    safeToggle.setAttribute("aria-pressed", this.plugin.settings.safeLinksEnabled ? "true" : "false");
    safeToggle.addEventListener("click", async () => {
      this.plugin.settings.safeLinksEnabled = !this.plugin.settings.safeLinksEnabled;
      this.plugin.blockNoticeShown = false;
      await this.plugin.saveSettings();
      await this.render();
    });

    const defangBody = this.makeDropdown(container, "defang", "Defang / Refang");
    const transformActions = defangBody.createDiv({ cls: "ct-sidebar-actions" });
    const defang = transformActions.createEl("button", { text: "Defang" });
    defang.addEventListener("mousedown", (event) => event.preventDefault());
    defang.addEventListener("click", async () => { const changed = await this.plugin.transformTrackedNote("defang"); if (changed) { this.openSections.add("defang"); await this.render(); } });
    const refang = transformActions.createEl("button", { text: "Refang" });
    refang.addEventListener("mousedown", (event) => event.preventDefault());
    refang.addEventListener("click", async () => { const changed = await this.plugin.transformTrackedNote("refang"); if (changed) { this.openSections.add("defang"); await this.render(); } });
    defangBody.createEl("p", { text: "If text is selected in the note, only the selection is processed. Otherwise the whole note is processed.", cls: "ct-muted" });

    const iocBody = this.makeDropdown(container, "ioc", "IOC Scanner");
    const iocSummary = iocBody.createDiv({ cls: "ct-ioc-scanner-summary" });
    iocSummary.createSpan({ text: `Total ${counts.Total}`, cls: "ct-ioc-scanner-total" });
    const iocBreakdown = iocSummary.createDiv({ cls: "ct-ioc-breakdown" });
    for (const [label, value] of [["URL", counts.URL], ["IP", counts.IP], ["Domain", counts.Domain], ["Hash", counts.Hash], ["Email", counts.Email]]) {
      const pill = iocBreakdown.createSpan({ cls: "ct-ioc-pill" });
      pill.createSpan({ text: label, cls: "ct-ioc-pill-label" });
      pill.createSpan({ text: String(value), cls: "ct-ioc-pill-count" });
    }
    const typeBox = iocBody.createDiv({ cls: "ct-ioc-type-grid" });
    const choices = [["url", "URLs"], ["ip", "IPs"], ["domain", "Domains"], ["hash", "Hashes"], ["email", "Emails"]];
    for (const [value, label] of choices) {
      const item = typeBox.createEl("label", { cls: "ct-ioc-check" });
      const box = item.createEl("input", { type: "checkbox" });
      box.checked = this.scanTypes.has(value);
      box.addEventListener("change", () => {
        if (box.checked) this.scanTypes.add(value); else this.scanTypes.delete(value);
        this.scanResults = null;
      });
      item.createSpan({ text: label });
    }

    const limitRow = iocBody.createDiv({ cls: "ct-ioc-limit-row" });
    limitRow.createSpan({ text: "Maximum results" });
    const limitSelect = limitRow.createEl("select");
    for (const [value, label] of [["all", "All"], ["10", "10"], ["25", "25"], ["50", "50"], ["100", "100"], ["250", "250"]]) {
      const option = limitSelect.createEl("option", { value, text: label });
      if (String(this.scanLimit) === value) option.selected = true;
    }
    limitSelect.addEventListener("change", () => {
      this.scanLimit = limitSelect.value === "all" ? "all" : Number(limitSelect.value);
      this.scanResults = null;
    });

    const scanButton = iocBody.createEl("button", { text: "Scan current note", cls: "ct-sidebar-wide-button" });
    scanButton.addEventListener("click", async () => {
      if (!this.scanTypes.size) { new Notice("Choose at least one IOC type."); return; }
      const currentFile = this.plugin.getTrackedFile();
      if (!(currentFile instanceof TFile)) return;
      const currentText = await this.readTrackedText(currentFile);
      const all = [];
      const numericLimit = this.scanLimit === "all" ? Number.POSITIVE_INFINITY : Number(this.scanLimit);
      for (const type of this.scanTypes) {
        if (Number.isFinite(numericLimit) && all.length >= numericLimit) break;
        const remaining = Number.isFinite(numericLimit) ? Math.max(0, numericLimit - all.length) : "all";
        all.push(...this.plugin.scanIocs(currentText, type, remaining));
      }
      this.scanResults = Number.isFinite(numericLimit) ? all.slice(0, numericLimit) : all;
      this.scanPath = currentFile.path;
      this.openSections.add("ioc");
      await this.render();
    });

    if (this.scanResults && this.scanPath === file.path) {
      const grouped = new Map();
      for (const item of this.scanResults) {
        if (!grouped.has(item.type)) grouped.set(item.type, []);
        grouped.get(item.type).push(item.value);
      }
      const labels = { URL: "URLs", IP: "IPs", Domain: "Domains", Hash: "Hashes", Email: "Emails" };
      const resultBox = iocBody.createDiv({ cls: "ct-ioc-results" });
      resultBox.createEl("div", { text: `${this.scanResults.length} found`, cls: "ct-ioc-result-count" });
      for (const [type, values] of grouped.entries()) {
        const group = resultBox.createEl("details", { cls: "ct-ioc-result-group" });
        const summary = group.createEl("summary");
        summary.createSpan({ text: `${labels[type] || type} (${values.length})`, cls: "ct-ioc-group-title" });
        const body = group.createDiv({ cls: "ct-ioc-group-body" });
        let rendered = false;
        const renderValues = () => {
          if (rendered) return;
          rendered = true;
          for (const value of values) {
            const row = body.createDiv({ cls: "ct-ioc-row" });
            row.createEl("code", { text: value, cls: "ct-ioc-code" });
            const copy = row.createEl("button", { text: "Copy", cls: "ct-ioc-copy" });
            copy.setAttribute("aria-label", `Copy ${type}`);
            copy.addEventListener("click", () => navigator.clipboard.writeText(value));
          }
        };
        group.addEventListener("toggle", () => { if (group.open) renderValues(); });
      }
    }

    const appearanceBody = this.makeDropdown(container, "appearance", "Appearance");
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

    const graphBody = this.makeDropdown(container, "graph", "Connections");
    const connect = graphBody.createEl("button", { text: "Connect another note", cls: "ct-sidebar-wide-button mod-cta" });
    connect.addEventListener("click", () => new NoteSuggestModal(this.app, file.path, async (target) => {
      await this.plugin.addConnection(file, target);
      this.openSections.add("graph");
      await this.render();
    }).open());

    const connections = this.plugin.getConnectionsFor(file.path);
    const connectionHeader = graphBody.createDiv({ cls: "ct-connection-header" });
    connectionHeader.createSpan({ text: `Connected notes (${connections.length})` });

    if (!connections.length) {
      graphBody.createEl("p", { text: "No manual connections yet.", cls: "ct-muted" });
    } else {
      const list = graphBody.createDiv({ cls: "ct-connection-list" });
      for (const item of connections) {
        const row = list.createDiv({ cls: "ct-connection-row" });
        const open = row.createEl("button", { text: item.file.basename, cls: "ct-connection-open" });
        open.setAttribute("title", item.file.path);
        open.addEventListener("click", async () => {
          await this.app.workspace.getLeaf(false).openFile(item.file);
        });
        const remove = row.createEl("button", { text: "×", cls: "ct-connection-remove" });
        remove.setAttribute("aria-label", `Remove connection to ${item.file.basename}`);
        remove.setAttribute("title", "Remove connection");
        remove.addEventListener("click", async () => {
          await this.plugin.removeConnection(item.source, item.target);
          this.openSections.add("graph");
          await this.render();
        });
      }
    }

    this.renderNoteInfo(container, file, text, counts);

  }
}

class NoteSuggestModal extends FuzzySuggestModal {
  constructor(app, excludedPath, onChoose) {
    super(app);
    this.excludedPath = excludedPath;
    this.onChoose = onChoose;
    this.setPlaceholder("Choose a note to connect…");
  }
  getItems() { return this.app.vault.getMarkdownFiles().filter((file) => file.path !== this.excludedPath); }
  getItemText(item) { return item.path; }
  onChooseItem(item) { this.onChoose(item); }
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
    containerEl.createEl("p", { text: "Global defaults and security behavior. Use Note Tools in the sidebar for note-specific actions." });

    this.addSection("Security");
    new Setting(containerEl)
      .setName("Safe Links")
      .setDesc("Block normal clicks on external HTTP/HTTPS links. Hold Ctrl/Cmd while clicking to open intentionally.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.safeLinksEnabled).onChange(async (value) => {
        this.plugin.settings.safeLinksEnabled = value === true;
        this.plugin.blockNoticeShown = false;
        await this.plugin.saveSettings();
        this.plugin.refreshSidebar();
      }));

    this.addSection("Graph");
    new Setting(containerEl)
      .setName("Match graph nodes to note colors")
      .setDesc("Experimental: use individual note override colors for matching Graph nodes.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.graphMatchNoteColors).onChange(async (value) => {
        this.plugin.settings.graphMatchNoteColors = value === true;
        await this.plugin.saveSettings();
      }));

    this.addSection("File explorer");
    this.addColorAndSize("Folder title", "folderColor", "folderSize", 10, 30);
    this.addIcon("Folder icon", "folderIcon");
    this.addColorAndSize("Note title", "noteColor", "noteSize", 10, 30);
    this.addIcon("Note icon", "noteIcon");
    this.addColorAndSize("Active note title", "activeNoteColor", "activeNoteSize", 10, 30);

    this.addSection("Note title");
    this.addColorAndSize("Inline title", "inlineTitleColor", "inlineTitleSize", 12, 60);

    this.addSection("Markdown headings");
    for (let level = 1; level <= 6; level++) {
      this.addColorAndSize(`Heading ${level}`, `h${level}Color`, `h${level}Size`, 10, 60);
    }

    this.addSection("Reset");
    new Setting(containerEl).setName("Restore defaults").addButton((button) =>
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

  addColorAndSize(name, colorKey, sizeKey, min, max) {
    const setting = new Setting(this.containerEl).setName(name);
    setting.settingEl.addClass("ct-compact-setting");
    setting.addColorPicker((picker) => picker.setValue(this.plugin.settings[colorKey]).onChange(async (value) => {
      this.plugin.settings[colorKey] = sanitizeColor(value, DEFAULT_SETTINGS[colorKey]);
      await this.plugin.saveSettings();
    }));
    setting.addSlider((slider) => slider.setLimits(min, max, 1).setValue(this.plugin.settings[sizeKey]).setDynamicTooltip().onChange(async (value) => {
      this.plugin.settings[sizeKey] = sanitizeSize(value, min, max, DEFAULT_SETTINGS[sizeKey]);
      await this.plugin.saveSettings();
    }));
  }

  addIcon(name, key) {
    const setting = new Setting(this.containerEl).setName(name);
    setting.settingEl.addClass("ct-compact-setting");
    setting.addText((text) => text.setPlaceholder("e.g. 🛡️").setValue(this.plugin.settings[key] || "").onChange(async (value) => {
      this.plugin.settings[key] = sanitizeIcon(value);
      await this.plugin.saveSettings();
    }));
  }
}
