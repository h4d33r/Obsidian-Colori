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
  normalizePath
} = require("obsidian");

const VIEW_TYPE = "colori-note-tools";
const HUB_START = "<!-- colori-folder-hub:start -->";
const HUB_END = "<!-- colori-folder-hub:end -->";
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
    return `${label} — ${defangDestination(destination)}`;
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
  return value
    .replace(/\bhxxps?:\/\/[^\s<>"'`]+/gi, (url) => refangDestination(url))
    .replace(/\b(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\[\.\])+[a-z]{2,63}(?::\d{1,5})?(?:[\/?#][^\s<>"'`]*)?/gi, (domain) => refangDestination(domain));
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

    this.registerEvent(this.app.vault.on("create", (file) => this.handleCreate(file)));
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
    root.classList.toggle("ct-safe-links", this.settings.safeLinksEnabled);
    this.renderOverrideCss();
  }

  clearSettings() {
    const root = document.body;
    if (!root) return;
    for (const cssVariable of Object.values(CSS_VARIABLES)) root.style.removeProperty(cssVariable);
    for (const name of ["--ct-folder-icon", "--ct-note-icon", "--graph-node", "--graph-node-focused"]) {
      root.style.removeProperty(name);
    }
    root.classList.remove("ct-safe-links");
  }

  renderOverrideCss() {
    if (!this.overrideStyleEl) return;
    const rules = [];
    for (const override of this.settings.overrides) {
      const path = escapeCssString(override.path);
      const color = sanitizeColor(override.color, override.type === "folder" ? this.settings.folderColor : this.settings.noteColor);
      const size = sanitizeSize(override.size, 10, 40, override.type === "folder" ? this.settings.folderSize : this.settings.noteSize);
      const icon = escapeCssString(sanitizeIcon(override.icon));
      const selector = override.type === "folder"
        ? `.nav-folder-title[data-path="${path}"] .nav-folder-title-content`
        : `.nav-file-title[data-path="${path}"] .nav-file-title-content`;
      rules.push(`${selector}{color:${color}!important;font-size:${size}px!important;}`);
      rules.push(`${selector}::before{content:"${icon}";margin-right:${icon ? "0.4em" : "0"};}`);
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

  scanIocs(text, type, limit) {
    const source = typeof text === "string" ? text : "";
    const safeLimit = IOC_LIMITS.has(Number(limit)) ? Number(limit) : 25;
    const wanted = ["all", "url", "ip", "domain", "hash", "email"].includes(type) ? type : "all";
    const results = [];
    const seen = new Set();

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

    if (wanted === "all" || wanted === "url") run("URL", /\b(?:https?|hxxps?):\/\/[^\s<>"'`]+/gi);
    if (wanted === "all" || wanted === "ip") run("IP", /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (value) => value.split(".").every((part) => Number(part) <= 255));
    if (wanted === "all" || wanted === "hash") run("Hash", /\b(?:[a-f0-9]{64}|[a-f0-9]{40}|[a-f0-9]{32})\b/gi);
    if (wanted === "all" || wanted === "email") run("Email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi);
    if (wanted === "all" || wanted === "domain") run("Domain", /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.|\[\.\]))+[a-z]{2,63}\b/gi);
    return results.slice(0, safeLimit);
  }

  countIocs(text) {
    const source = typeof text === "string" ? text : "";
    const counts = { URL: 0, IP: 0, Domain: 0, Hash: 0, Email: 0 };
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
    countMatches("URL", /\b(?:https?|hxxps?):\/\/[^\s<>"'`]+/gi);
    countMatches("IP", /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (value) => value.split(".").every((part) => Number(part) <= 255));
    countMatches("Hash", /\b(?:[a-f0-9]{64}|[a-f0-9]{40}|[a-f0-9]{32})\b/gi);
    countMatches("Email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi);
    countMatches("Domain", /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.|\[\.\]))+[a-z]{2,63}\b/gi);
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
          const override = path ? this.getOverride("file", path) : null;
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

  getHubPath(folder) {
    return normalizePath(`${folder.path}/${folder.name}.md`);
  }

  isFolderHubEnabled(path) {
    return this.settings.folderHubs.includes(path);
  }

  buildFolderHubSection(folder, hubPath) {
    const notes = this.app.vault.getMarkdownFiles()
      .filter((file) => file.parent?.path === folder.path && file.path !== hubPath)
      .sort((a, b) => a.basename.localeCompare(b.basename));
    const links = notes.map((file) => `- ${this.app.fileManager.generateMarkdownLink(file, hubPath)}`);
    return [HUB_START, "## Notes", links.length ? links.join("\n") : "_No notes in this folder yet._", HUB_END].join("\n");
  }

  async enableFolderHub(folder) {
    if (!(folder instanceof TFolder) || folder.path === "/") return;
    if (!this.settings.folderHubs.includes(folder.path)) {
      this.settings.folderHubs.push(folder.path);
      await this.saveSettings();
    }
    await this.syncFolderHub(folder);
  }

  async syncFolderHub(folder) {
    if (!(folder instanceof TFolder) || folder.path === "/") return;
    const hubPath = this.getHubPath(folder);
    const existing = this.app.vault.getAbstractFileByPath(hubPath);
    if (existing && !(existing instanceof TFile)) return;
    const section = this.buildFolderHubSection(folder, hubPath);
    if (!existing) await this.app.vault.create(hubPath, `# ${folder.name}\n\n${section}\n`);
    else {
      const current = await this.app.vault.read(existing);
      const updated = replaceManagedSection(current, HUB_START, HUB_END, section);
      if (updated !== null && updated !== current) await this.app.vault.modify(existing, updated);
    }
  }

  async syncTrackedFolderPath(folderPath) {
    if (!folderPath || folderPath === "/" || !this.settings.folderHubs.includes(folderPath)) return;
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (folder instanceof TFolder) await this.syncFolderHub(folder);
  }

  async handleCreate(file) {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    await this.syncTrackedFolderPath(file.parent?.path);
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

    this.settings.folderHubs = this.settings.folderHubs.map((path) => {
      if (path === safeOldPath) { changed = true; return newPath; }
      if (file instanceof TFolder && path.startsWith(`${safeOldPath}/`)) { changed = true; return `${newPath}${path.slice(safeOldPath.length)}`; }
      return path;
    });

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
    if (file instanceof TFile && file.extension === "md") {
      await this.syncTrackedFolderPath(parentPath(safeOldPath));
      await this.syncTrackedFolderPath(file.parent?.path);
    }
  }

  async handleDelete(file) {
    const deletedPath = sanitizePath(file.path);
    if (!deletedPath) return;
    const before = JSON.stringify([this.settings.overrides, this.settings.folderHubs, this.settings.connections]);
    this.settings.overrides = this.settings.overrides.filter((item) => !pathMatchesOrDescends(item.path, deletedPath));
    this.settings.folderHubs = this.settings.folderHubs.filter((path) => !pathMatchesOrDescends(path, deletedPath));
    this.settings.connections = this.settings.connections.filter((item) => !pathMatchesOrDescends(item.source, deletedPath) && !pathMatchesOrDescends(item.target, deletedPath));
    if (this.lastMarkdownPath && pathMatchesOrDescends(this.lastMarkdownPath, deletedPath)) this.lastMarkdownPath = null;
    const after = JSON.stringify([this.settings.overrides, this.settings.folderHubs, this.settings.connections]);
    if (before !== after) await this.saveSettings();
  }

  async resetSettings() {
    this.settings = { ...DEFAULT_SETTINGS, overrides: [], folderHubs: [], connections: [] };
    await this.saveSettings();
  }
};

class NoteToolsView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.openSections = new Set();
    this.scanTypes = new Set(["url", "ip", "domain", "hash", "email"]);
    this.scanLimit = 25;
    this.scanResults = null;
    this.scanPath = null;
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

  async render() {
    const container = this.containerEl.children[1];
    if (!container) return;
    container.empty();
    container.addClass("ct-sidebar");
    container.createEl("h3", { text: "Note Tools" });

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
    const summary = container.createDiv({ cls: "ct-ioc-summary" });
    summary.createEl("strong", { text: `IOCs: ${counts.Total}` });
    summary.createEl("span", { text: `URLs ${counts.URL} · IPs ${counts.IP} · Domains ${counts.Domain} · Hashes ${counts.Hash} · Emails ${counts.Email}` });

    const safeBody = this.makeDropdown(container, "safe", "Safe Links");
    safeBody.createEl("div", { text: this.plugin.settings.safeLinksEnabled ? "Protection is ON" : "Protection is OFF", cls: this.plugin.settings.safeLinksEnabled ? "ct-status ct-status-on" : "ct-status" });
    safeBody.createEl("p", { text: "Normal clicks on web links are blocked, including Markdown links such as [Google](google.com). Hold Ctrl/Cmd while clicking to open intentionally.", cls: "ct-muted" });

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
    for (const limit of [10, 25, 50, 100, 250]) {
      const option = limitSelect.createEl("option", { value: String(limit), text: String(limit) });
      if (limit === this.scanLimit) option.selected = true;
    }
    limitSelect.addEventListener("change", () => { this.scanLimit = Number(limitSelect.value); this.scanResults = null; });

    const scanButton = iocBody.createEl("button", { text: "Scan current note", cls: "ct-sidebar-wide-button" });
    scanButton.addEventListener("click", async () => {
      if (!this.scanTypes.size) { new Notice("Choose at least one IOC type."); return; }
      const currentFile = this.plugin.getTrackedFile();
      if (!(currentFile instanceof TFile)) return;
      const currentText = await this.readTrackedText(currentFile);
      const all = [];
      for (const type of this.scanTypes) {
        if (all.length >= this.scanLimit) break;
        all.push(...this.plugin.scanIocs(currentText, type, this.scanLimit - all.length));
      }
      this.scanResults = all.slice(0, this.scanLimit);
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
      const resultBox = iocBody.createDiv({ cls: "ct-ioc-results" });
      resultBox.createEl("div", { text: `${this.scanResults.length} shown`, cls: "ct-muted" });
      for (const [type, values] of grouped.entries()) {
        resultBox.createEl("div", { text: `${type}${values.length === 1 ? "" : "s"}`, cls: "ct-ioc-group-title" });
        for (const value of values) {
          const row = resultBox.createDiv({ cls: "ct-ioc-row" });
          row.createEl("code", { text: value });
          const copy = row.createEl("button", { text: "Copy" });
          copy.addEventListener("click", () => navigator.clipboard.writeText(value));
        }
      }
      if (this.scanResults.length) {
        const copyAll = iocBody.createEl("button", { text: "Copy shown results", cls: "ct-sidebar-wide-button" });
        copyAll.addEventListener("click", () => navigator.clipboard.writeText(this.scanResults.map((item) => item.value).join("\n")));
      }
    }

    const appearanceBody = this.makeDropdown(container, "appearance", "Appearance");
    const existing = this.plugin.getOverride("file", file.path);
    const appearance = existing ? { ...existing } : { color: this.plugin.settings.noteColor, size: this.plugin.settings.noteSize, icon: "" };
    new Setting(appearanceBody).setName("Title color").addColorPicker((picker) => picker.setValue(appearance.color).onChange(async (value) => { appearance.color = sanitizeColor(value, this.plugin.settings.noteColor); await this.plugin.upsertOverride("file", file.path, appearance); }));
    new Setting(appearanceBody).setName("Title size").addSlider((slider) => slider.setLimits(10, 40, 1).setValue(appearance.size).setDynamicTooltip().onChange(async (value) => { appearance.size = sanitizeSize(value, 10, 40, this.plugin.settings.noteSize); await this.plugin.upsertOverride("file", file.path, appearance); }));
    new Setting(appearanceBody).setName("Icon").addText((input) => input.setPlaceholder("Optional").setValue(appearance.icon || "").onChange(async (value) => { appearance.icon = sanitizeIcon(value); await this.plugin.upsertOverride("file", file.path, appearance); }));
    if (existing) {
      const reset = appearanceBody.createEl("button", { text: "Reset appearance", cls: "ct-sidebar-wide-button" });
      reset.addEventListener("click", async () => { await this.plugin.removeOverride("file", file.path); this.openSections.add("appearance"); await this.render(); });
    }

    const graphBody = this.makeDropdown(container, "graph", "Graph");
    const count = this.plugin.getOutgoingConnections(file.path).length;
    const graphActions = graphBody.createDiv({ cls: "ct-sidebar-actions" });
    const connect = graphActions.createEl("button", { text: "Connect note" });
    connect.addEventListener("click", () => new NoteSuggestModal(this.app, file.path, async (target) => { await this.plugin.addConnection(file, target); this.openSections.add("graph"); await this.render(); }).open());
    const manage = graphActions.createEl("button", { text: `Connections (${count})` });
    manage.addEventListener("click", () => new ConnectionsModal(this.app, this.plugin, file).open());
    graphBody.createEl("p", { text: this.plugin.settings.graphMatchNoteColors ? "Graph color matching is enabled globally." : "Graph color matching is disabled globally.", cls: "ct-muted" });

    const infoBody = this.makeDropdown(container, "info", "Note Info");
    const words = (text.match(/\S+/g) || []).length;
    const resolved = this.app.metadataCache.resolvedLinks || {};
    const outgoing = resolved[file.path] ? Object.keys(resolved[file.path]).length : 0;
    let backlinks = 0;
    for (const links of Object.values(resolved)) if (links && Object.prototype.hasOwnProperty.call(links, file.path)) backlinks++;
    const grid = infoBody.createDiv({ cls: "ct-note-info" });
    for (const [name, value] of [["Words", words], ["Backlinks", backlinks], ["Outgoing", outgoing], ["Created", new Date(file.stat.ctime).toLocaleString()], ["Modified", new Date(file.stat.mtime).toLocaleString()]]) {
      grid.createEl("span", { text: name, cls: "ct-note-info-label" });
      grid.createEl("span", { text: String(value), cls: "ct-note-info-value" });
    }
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

class ConnectionsModal extends FuzzySuggestModal {
  constructor(app, plugin, sourceFile) {
    super(app);
    this.plugin = plugin;
    this.sourceFile = sourceFile;
    this.setPlaceholder("Choose a connection to remove…");
  }
  getItems() { return this.plugin.getOutgoingConnections(this.sourceFile.path); }
  getItemText(item) { return item.target; }
  async onChooseItem(item) {
    await this.plugin.removeConnection(item.source, item.target);
    new Notice("Connection removed.");
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
