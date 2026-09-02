from pathlib import Path

p = Path('main.js')
s = p.read_text(encoding='utf-8')

def one(old, new):
    global s
    if old not in s:
        raise SystemExit('Expected block not found: ' + old[:180])
    s = s.replace(old, new, 1)

# Replace URL transforms with Markdown-aware web destination handling.
start = s.index('function defangUrlText(value) {')
end = s.index('function normalizeOverride(', start)
new_helpers = r'''function isWebDestination(value) {
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

'''
s = s[:start] + new_helpers + s[end:]

# Re-introduce robust event-based Safe Links after the markdown tracking registration.
needle = '''    this.registerEvent(this.app.workspace.on("file-open", rememberMarkdown));\n    this.registerEvent(this.app.workspace.on("active-leaf-change", rememberMarkdown));\n'''
insert = needle + '''\n    const blockSafeLink = (event) => this.blockSafeLinkEvent(event);\n    for (const eventName of ["pointerdown", "mousedown", "click", "auxclick"]) {\n      this.registerDomEvent(document, eventName, blockSafeLink, true);\n    }\n'''
one(needle, insert)

# Add Safe Links methods before getTrackedFile.
marker = '  getTrackedFile() {'
safe_methods = r'''  getWebDestinationFromEvent(event) {
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

'''
if marker not in s:
    raise SystemExit('getTrackedFile marker missing')
s = s.replace(marker, safe_methods + marker, 1)

# Make tracked transform honor editor selection if present, otherwise whole note.
old = '''  async transformTrackedNote(mode) {\n    const file = this.getTrackedFile();\n    if (!file) return false;\n    const transform = mode === "refang" ? refangUrlText : defangUrlText;\n    const current = await this.app.vault.read(file);\n    const updated = transform(current);\n    if (updated === current) return false;\n    await this.app.vault.modify(file, updated);\n    new Notice(mode === "refang" ? "URLs refanged." : "URLs defanged.");\n    return true;\n  }\n'''
new = '''  async transformTrackedNote(mode) {\n    const file = this.getTrackedFile();\n    if (!file) return false;\n    const transform = mode === "refang" ? refangUrlText : defangUrlText;\n    const editor = this.getEditorForFile(file);\n\n    if (editor) {\n      const selection = editor.getSelection();\n      if (selection) {\n        const updatedSelection = transform(selection);\n        if (updatedSelection === selection) return false;\n        editor.replaceSelection(updatedSelection);\n        new Notice(mode === "refang" ? "Selection refanged." : "Selection defanged.");\n        return true;\n      }\n\n      const current = editor.getValue();\n      const updated = transform(current);\n      if (updated === current) return false;\n      editor.setValue(updated);\n      new Notice(mode === "refang" ? "Note refanged." : "Note defanged.");\n      return true;\n    }\n\n    const current = await this.app.vault.read(file);\n    const updated = transform(current);\n    if (updated === current) return false;\n    await this.app.vault.modify(file, updated);\n    new Notice(mode === "refang" ? "Note refanged." : "Note defanged.");\n    return true;\n  }\n'''
one(old, new)

# Preserve editor selection when sidebar button is pressed by preventing focus change on mousedown.
one('''    const defang = transformActions.createEl("button", { text: "Defang note" });\n    defang.addEventListener("click", async () => { const changed = await this.plugin.transformTrackedNote("defang"); if (changed) { this.openSections.add("defang"); await this.render(); } });\n    const refang = transformActions.createEl("button", { text: "Refang note" });\n    refang.addEventListener("click", async () => { const changed = await this.plugin.transformTrackedNote("refang"); if (changed) { this.openSections.add("defang"); await this.render(); } });\n    defangBody.createEl("p", { text: "Sidebar buttons process the whole tracked note. Use the Command Palette commands for selected text.", cls: "ct-muted" });\n''', '''    const defang = transformActions.createEl("button", { text: "Defang" });\n    defang.addEventListener("mousedown", (event) => event.preventDefault());\n    defang.addEventListener("click", async () => { const changed = await this.plugin.transformTrackedNote("defang"); if (changed) { this.openSections.add("defang"); await this.render(); } });\n    const refang = transformActions.createEl("button", { text: "Refang" });\n    refang.addEventListener("mousedown", (event) => event.preventDefault());\n    refang.addEventListener("click", async () => { const changed = await this.plugin.transformTrackedNote("refang"); if (changed) { this.openSections.add("defang"); await this.render(); } });\n    defangBody.createEl("p", { text: "If text is selected in the note, only the selection is processed. Otherwise the whole note is processed.", cls: "ct-muted" });\n''')

# Update Safe Links description.
one('''    safeBody.createEl("p", { text: "When enabled, external web links in Markdown notes are disabled. Change this in plugin settings.", cls: "ct-muted" });\n''', '''    safeBody.createEl("p", { text: "Normal clicks on web links are blocked, including Markdown links such as [Google](google.com). Hold Ctrl/Cmd while clicking to open intentionally.", cls: "ct-muted" });\n''')

# CSS hard-block currently prevents the modifier bypass. Remove that block; event interception now owns Safe Links.
css = Path('styles.css')
c = css.read_text(encoding='utf-8')
css_start = c.find('/* Safe Links: hard block inside Markdown notes */')
css_end = c.find('/* Persistent Note Tools dropdowns */', css_start)
if css_start >= 0 and css_end > css_start:
    c = c[:css_start] + c[css_end:]
css.write_text(c, encoding='utf-8')

p.write_text(s, encoding='utf-8')
