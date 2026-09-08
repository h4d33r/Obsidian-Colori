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
  normalizePath,
  requestUrl
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
const MAX_LOCAL_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REMOTE_IMAGES_PER_RUN = 200;
const LOCAL_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico"]);

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
    this.addCommand({
      id: "localize-remote-images-current-note",
      name: "Localize remote images in current note",
      callback: async () => {
        const file = this.getTrackedFile();
        if (!(file instanceof TFile)) { new Notice("Open a Markdown note first."); return; }
        await this.localizeRemoteImages(file);
        this.refreshSidebar();
      }
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


  getRemoteImageEmbeds(text) {
    const source = typeof text === "string" ? text : "";
    const results = [];

    const markdown = /!\[([^\]]*)\]\(\s*(https?:\/\/[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/gi;
    let match;
    while ((match = markdown.exec(source))) {
      results.push({ kind: "markdown", full: match[0], url: match[2], alt: match[1] || "" });
      if (match.index === markdown.lastIndex) markdown.lastIndex++;
    }

    const html = /<img\b[^>]*\bsrc\s*=\s*(["'])(https?:\/\/.*?)\1[^>]*>/gi;
    while ((match = html.exec(source))) {
      const altMatch = match[0].match(/\balt\s*=\s*(["'])(.*?)\1/i);
      results.push({ kind: "html", full: match[0], url: match[2], alt: altMatch ? altMatch[2] : "" });
      if (match.index === html.lastIndex) html.lastIndex++;
    }

    return results;
  }

  getResponseHeader(headers, name) {
    if (!headers || typeof headers !== "object") return "";
    const wanted = String(name).toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (String(key).toLowerCase() === wanted) return String(value || "");
    }
    return "";
  }

  getLocalImageExtension(url, contentType) {
    const mime = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
    const mimeMap = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/bmp": "bmp",
      "image/avif": "avif",
      "image/x-icon": "ico",
      "image/vnd.microsoft.icon": "ico"
    };
    if (mimeMap[mime]) return mimeMap[mime];

    try {
      const pathname = new URL(url).pathname;
      const last = pathname.split("/").pop() || "";
      const dot = last.lastIndexOf(".");
      if (dot >= 0) {
        let ext = last.slice(dot + 1).toLowerCase();
        if (ext === "jpeg") ext = "jpg";
        if (LOCAL_IMAGE_EXTENSIONS.has(ext)) return ext;
      }
    } catch (_) {}
    return null;
  }

  buildLocalImageFilename(url, extension) {
    let base = "remote-image";
    try {
      const pathname = decodeURIComponent(new URL(url).pathname);
      const last = pathname.split("/").filter(Boolean).pop() || "remote-image";
      base = last.replace(/\.[^.]+$/, "") || "remote-image";
    } catch (_) {}
    base = base
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 80) || "remote-image";
    return `${base}.${extension}`;
  }

  async downloadRemoteImage(url, noteFile) {
    let response;
    try {
      response = await requestUrl({
        url,
        method: "GET",
        headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8" }
      });
    } catch (error) {
      throw new Error(`Download failed: ${error?.message || error}`);
    }

    if (!response || response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response?.status || "error"}`);
    }

    const contentLength = Number(this.getResponseHeader(response.headers, "content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_LOCAL_IMAGE_BYTES) {
      throw new Error("Image is larger than 20 MB");
    }

    const data = response.arrayBuffer;
    if (!(data instanceof ArrayBuffer) || data.byteLength === 0) throw new Error("Empty image response");
    if (data.byteLength > MAX_LOCAL_IMAGE_BYTES) throw new Error("Image is larger than 20 MB");

    const contentType = this.getResponseHeader(response.headers, "content-type");
    const extension = this.getLocalImageExtension(url, contentType);
    if (!extension) throw new Error("Unsupported or unknown image type");

    const filename = this.buildLocalImageFilename(url, extension);
    const attachmentPath = await this.app.fileManager.getAvailablePathForAttachment(filename, noteFile.path);
    await this.app.vault.createBinary(attachmentPath, data);
    const created = this.app.vault.getAbstractFileByPath(attachmentPath);
    if (!(created instanceof TFile)) throw new Error("Attachment was not created");
    return created;
  }

  async localizeRemoteImages(file) {
    if (!(file instanceof TFile) || file.extension !== "md") return false;
    const editor = this.getEditorForFile(file);
    const current = editor ? editor.getValue() : await this.app.vault.read(file);
    const allEmbeds = this.getRemoteImageEmbeds(current);
    if (!allEmbeds.length) {
      new Notice("No remote image embeds found in this note.");
      return false;
    }

    const embeds = allEmbeds.slice(0, MAX_REMOTE_IMAGES_PER_RUN);
    const downloaded = new Map();
    const failed = new Map();

    for (const embed of embeds) {
      if (downloaded.has(embed.url) || failed.has(embed.url)) continue;
      try {
        downloaded.set(embed.url, await this.downloadRemoteImage(embed.url, file));
      } catch (error) {
        failed.set(embed.url, error?.message || String(error));
        console.warn("Colori: remote image localization failed", embed.url, error);
      }
    }

    let updated = current;
    let localized = 0;
    for (const embed of embeds) {
      const attachment = downloaded.get(embed.url);
      if (!(attachment instanceof TFile)) continue;
      const localLink = `!${this.app.fileManager.generateMarkdownLink(attachment, file.path, undefined, embed.alt || undefined)}`;
      if (!updated.includes(embed.full)) continue;
      updated = updated.replace(embed.full, localLink);
      localized++;
    }

    if (updated !== current) {
      if (editor) editor.setValue(updated);
      else await this.app.vault.modify(file, updated);
    }

    const skipped = Math.max(0, allEmbeds.length - embeds.length);
    const parts = [`Localized ${localized} image${localized === 1 ? "" : "s"}.`];
    if (failed.size) parts.push(`${failed.size} download${failed.size === 1 ? "" : "s"} failed.`);
    if (skipped) parts.push(`${skipped} skipped because the per-run limit is ${MAX_REMOTE_IMAGES_PER_RUN}.`);
    new Notice(parts.join(" "));
    return localized > 0;
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


  getNoteTags(file) {
    const cache = file instanceof TFile ? this.app.metadataCache.getFileCache(file) : null;
    const tags = new Set();
    const add = (value) => {
      if (typeof value !== "string") return;
      for (const part of value.split(/[\s,]+/)) {
        const clean = part.trim().replace(/^#/, "").toLowerCase();
        if (clean) tags.add(clean);
      }
    };
    for (const tag of cache?.tags || []) add(tag?.tag || "");
    const frontmatterTags = cache?.frontmatter?.tags;
    if (Array.isArray(frontmatterTags)) for (const tag of frontmatterTags) add(String(tag));
    else add(frontmatterTags);
    return tags;
  }

  getRelationTerms(file) {
    if (!(file instanceof TFile)) return new Set();
    const stop = new Set(["the", "and", "for", "with", "from", "this", "that", "into", "note", "notes", "level", "module", "lesson"]);
    const cache = this.app.metadataCache.getFileCache(file);
    const text = [file.basename, ...(cache?.headings || []).map((item) => item.heading || "")].join(" ").toLowerCase();
    return new Set((text.match(/[a-z0-9][a-z0-9_-]{2,}/g) || []).filter((term) => !stop.has(term)));
  }

  getRelatedNotes(file, limit = 10) {
    if (!(file instanceof TFile)) return [];
    const resolved = this.app.metadataCache.resolvedLinks || {};
    const sourceLinks = new Set(Object.keys(resolved[file.path] || {}));
    const sourceTags = this.getNoteTags(file);
    const sourceTerms = this.getRelationTerms(file);
    const manual = new Set();
    for (const item of this.settings.connections) {
      if (item.source === file.path) manual.add(item.target);
      if (item.target === file.path) manual.add(item.source);
    }

    const related = [];
    for (const candidate of this.app.vault.getMarkdownFiles()) {
      if (candidate.path === file.path) continue;
      let score = 0;
      const reasons = [];
      const candidateLinks = new Set(Object.keys(resolved[candidate.path] || {}));

      if (manual.has(candidate.path)) { score += 100; reasons.push("Manual connection"); }
      if (sourceLinks.has(candidate.path)) { score += 70; reasons.push("Linked from this note"); }
      if (candidateLinks.has(file.path)) { score += 70; reasons.push("Links to this note"); }

      const candidateTags = this.getNoteTags(candidate);
      const sharedTags = [...sourceTags].filter((tag) => candidateTags.has(tag));
      if (sharedTags.length) {
        score += Math.min(sharedTags.length, 5) * 15;
        reasons.push(`${sharedTags.length} shared tag${sharedTags.length === 1 ? "" : "s"}`);
      }

      const sharedTargets = [...sourceLinks].filter((path) => candidateLinks.has(path));
      if (sharedTargets.length) {
        score += Math.min(sharedTargets.length, 5) * 6;
        reasons.push(`${sharedTargets.length} shared link${sharedTargets.length === 1 ? "" : "s"}`);
      }

      const candidateTerms = this.getRelationTerms(candidate);
      const sharedTerms = [...sourceTerms].filter((term) => candidateTerms.has(term));
      if (sharedTerms.length) {
        score += Math.min(sharedTerms.length, 5) * 4;
        reasons.push(`${sharedTerms.length} shared topic term${sharedTerms.length === 1 ? "" : "s"}`);
      }

      if (file.parent?.path && candidate.parent?.path === file.parent.path) {
        score += 3;
        reasons.push("Same folder");
      }

      if (score > 0) related.push({ file: candidate, score, reasons });
    }

    return related
      .sort((a, b) => b.score - a.score || a.file.basename.localeCompare(b.file.basename))
      .slice(0, Math.max(1, Math.min(25, Number(limit) || 10)));
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
    this.scanLimit = "all";
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


  renderNoteInfo(parent, file, text, counts) {
    const infoCard = parent.createDiv({ cls: "ct-note-info-card" });
    infoCard.createEl("div", { text: "Note Info", cls: "ct-note-info-title" });
    const infoGrid = infoCard.createDiv({ cls: "ct-note-info" });
    const words = (text.match(/\S+/g) || []).length;
    const lines = text ? text.split(/\r?\n/).length : 0;
    const size = file.stat.size < 1024 ? `${file.stat.size} B` : `${(file.stat.size / 1024).toFixed(1)} KB`;
    const infoRows = [
      ["Total IOCs", counts.Total],
      ["IOC breakdown", `URL ${counts.URL} · IP ${counts.IP} · Domain ${counts.Domain} · Hash ${counts.Hash} · Email ${counts.Email}`],
      ["Words", words],
      ["Lines", lines],
      ["File size", size],
      ["Created", new Date(file.stat.ctime).toLocaleString()],
      ["Modified", new Date(file.stat.mtime).toLocaleString()]
    ];
    for (const [name, value] of infoRows) {
      infoGrid.createEl("span", { text: name, cls: "ct-note-info-label" });
      infoGrid.createEl("span", { text: String(value), cls: "ct-note-info-value" });
    }
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

    const localImagesBody = this.makeDropdown(container, "local-images", "Local Images");
    const remoteImages = this.plugin.getRemoteImageEmbeds(text);
    localImagesBody.createEl("p", { text: `Remote image embeds: ${remoteImages.length}`, cls: "ct-muted" });
    const localizeButton = localImagesBody.createEl("button", { text: "Localize remote images", cls: "ct-sidebar-wide-button" });
    localizeButton.disabled = remoteImages.length === 0;
    localizeButton.addEventListener("click", async () => {
      localizeButton.disabled = true;
      localizeButton.setText("Localizing…");
      await this.plugin.localizeRemoteImages(file);
      this.openSections.add("local-images");
      await this.render();
    });
    localImagesBody.createEl("p", { text: "Downloads HTTP/HTTPS image embeds into your Obsidian attachment folder and rewrites this note to the local copy. Normal links are not changed.", cls: "ct-muted" });

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
    const existing = this.plugin.getOverride("file", file.path);
    const appearance = existing ? { ...existing } : { color: this.plugin.settings.noteColor, size: this.plugin.settings.noteSize, icon: "" };
    const colorSetting = new Setting(appearanceBody).setName("Title color").addColorPicker((picker) => picker.setValue(appearance.color).onChange(async (value) => { appearance.color = sanitizeColor(value, this.plugin.settings.noteColor); await this.plugin.upsertOverride("file", file.path, appearance); }));
    colorSetting.settingEl.addClass("ct-appearance-setting");
    const sizeSetting = new Setting(appearanceBody).setName("Title size").addSlider((slider) => slider.setLimits(10, 40, 1).setValue(appearance.size).setDynamicTooltip().onChange(async (value) => { appearance.size = sanitizeSize(value, 10, 40, this.plugin.settings.noteSize); await this.plugin.upsertOverride("file", file.path, appearance); }));
    sizeSetting.settingEl.addClass("ct-appearance-setting");
    const iconSetting = new Setting(appearanceBody).setName("Icon").addText((input) => input.setPlaceholder("Optional").setValue(appearance.icon || "").onChange(async (value) => { appearance.icon = sanitizeIcon(value); await this.plugin.upsertOverride("file", file.path, appearance); }));
    iconSetting.settingEl.addClass("ct-appearance-setting");
    if (existing) {
      const reset = appearanceBody.createEl("button", { text: "Reset appearance", cls: "ct-sidebar-wide-button" });
      reset.addEventListener("click", async () => { await this.plugin.removeOverride("file", file.path); this.openSections.add("appearance"); await this.render(); });
    }

    const graphBody = this.makeDropdown(container, "graph", "Connections");
    const count = this.plugin.getOutgoingConnections(file.path).length;
    const graphActions = graphBody.createDiv({ cls: "ct-sidebar-actions" });
    const connect = graphActions.createEl("button", { text: "Add manual" });
    connect.addEventListener("click", () => new NoteSuggestModal(this.app, file.path, async (target) => { await this.plugin.addConnection(file, target); this.openSections.add("graph"); await this.render(); }).open());
    const manage = graphActions.createEl("button", { text: `Manual (${count})` });
    manage.addEventListener("click", () => new ConnectionsModal(this.app, this.plugin, file).open());

    graphBody.createEl("div", { text: "Related Notes", cls: "ct-related-heading" });
    graphBody.createEl("p", { text: "Local relationship ranking from links, backlinks, tags, headings, folder proximity, and manual connections.", cls: "ct-muted ct-related-help" });
    const related = this.plugin.getRelatedNotes(file, 10);
    const relatedBox = graphBody.createDiv({ cls: "ct-related-list" });
    if (!related.length) {
      relatedBox.createEl("div", { text: "No related notes found yet.", cls: "ct-muted" });
    }
    for (const item of related) {
      const card = relatedBox.createEl("details", { cls: "ct-related-note" });
      const summary = card.createEl("summary");
      summary.createSpan({ text: item.file.basename, cls: "ct-related-note-name" });
      summary.createSpan({ text: `${item.reasons.length} signal${item.reasons.length === 1 ? "" : "s"}`, cls: "ct-related-note-signal" });
      const body = card.createDiv({ cls: "ct-related-note-body" });
      body.createEl("div", { text: item.file.path, cls: "ct-related-note-path" });
      body.createEl("div", { text: item.reasons.join(" · "), cls: "ct-related-note-reasons" });
      const open = body.createEl("button", { text: "Open note", cls: "ct-sidebar-wide-button" });
      open.addEventListener("click", async () => { await this.app.workspace.getLeaf(false).openFile(item.file); });
    }
    graphBody.createEl("p", { text: this.plugin.settings.graphMatchNoteColors ? "Graph color matching: ON" : "Graph color matching: OFF", cls: "ct-muted ct-graph-state" });

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
