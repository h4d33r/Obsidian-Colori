from pathlib import Path

p = Path('main.js')
s = p.read_text(encoding='utf-8')

# 1) Make refang restore Colori-defanged Markdown links.
old_refang = '''function refangUrlText(value) {\n  if (typeof value !== "string" || !value) return value;\n  return value\n    .replace(/\\bhxxps?:\\/\\/[^\\s<>"'`]+/gi, (url) => refangDestination(url))\n    .replace(/\\b(?:www\\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\[\\.\\])+[a-z]{2,63}(?::\\d{1,5})?(?:[\\/?#][^\\s<>"'`]*)?/gi, (domain) => refangDestination(domain));\n}\n'''
new_refang = '''function refangUrlText(value) {\n  if (typeof value !== "string" || !value) return value;\n  let output = value;\n\n  // Reverse Colori's clean Markdown-link defang format:\n  // Label - hxxps://example[.]com  ->  [Label](https://example.com)\n  // Label - example[.]com          ->  [Label](example.com)\n  output = output.replace(/^(\\s*(?:[-*>]\\s*)?)(.+?)\\s+-\\s+((?:hxxps?:\\/\\/)?(?:www\\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\[\\.\\])+[a-z]{2,63}(?::\\d{1,5})?(?:[\\/?#][^\\s]*)?)\\s*$/gim, (full, prefix, label, destination) => {\n    const cleanLabel = label.trim();\n    const cleanDestination = refangDestination(destination);\n    return cleanLabel ? `${prefix}[${cleanLabel}](${cleanDestination})` : full;\n  });\n\n  return output\n    .replace(/\\bhxxps?:\\/\\/[^\\s<>"'`]+/gi, (url) => refangDestination(url))\n    .replace(/\\b(?:www\\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\[\\.\\])+[a-z]{2,63}(?::\\d{1,5})?(?:[\\/?#][^\\s<>"'`]*)?/gi, (domain) => refangDestination(domain));\n}\n'''
if old_refang not in s:
    raise SystemExit('refang function not found')
s = s.replace(old_refang, new_refang, 1)

# 2) Remove the top-level IOC summary and Safe Links dropdown.
old_top = '''    const text = await this.readTrackedText(file);\n    const counts = this.plugin.countIocs(text);\n    const summary = container.createDiv({ cls: "ct-ioc-summary" });\n    summary.createEl("strong", { text: `IOCs: ${counts.Total}` });\n    summary.createEl("span", { text: `URLs ${counts.URL} · IPs ${counts.IP} · Domains ${counts.Domain} · Hashes ${counts.Hash} · Emails ${counts.Email}` });\n\n    const safeBody = this.makeDropdown(container, "safe", "Safe Links");\n    safeBody.createEl("div", { text: this.plugin.settings.safeLinksEnabled ? "Protection is ON" : "Protection is OFF", cls: this.plugin.settings.safeLinksEnabled ? "ct-status ct-status-on" : "ct-status" });\n    safeBody.createEl("p", { text: "Normal clicks on web links are blocked, including Markdown links such as [Google](google.com). Hold Ctrl/Cmd while clicking to open intentionally.", cls: "ct-muted" });\n\n'''
new_top = '''    const text = await this.readTrackedText(file);\n    const counts = this.plugin.countIocs(text);\n\n    const safeRow = container.createDiv({ cls: "ct-safe-links-row" });\n    safeRow.createSpan({ text: "Safe Links" });\n    const safeToggle = safeRow.createEl("button", {\n      text: this.plugin.settings.safeLinksEnabled ? "ON" : "OFF",\n      cls: this.plugin.settings.safeLinksEnabled ? "mod-cta" : ""\n    });\n    safeToggle.setAttribute("aria-pressed", this.plugin.settings.safeLinksEnabled ? "true" : "false");\n    safeToggle.addEventListener("click", async () => {\n      this.plugin.settings.safeLinksEnabled = !this.plugin.settings.safeLinksEnabled;\n      this.plugin.blockNoticeShown = false;\n      await this.plugin.saveSettings();\n      await this.render();\n    });\n\n    const infoCard = container.createDiv({ cls: "ct-note-info-card" });\n    infoCard.createEl("div", { text: "Note Info", cls: "ct-note-info-title" });\n    const infoGrid = infoCard.createDiv({ cls: "ct-note-info" });\n    const words = (text.match(/\\S+/g) || []).length;\n    const lines = text ? text.split(/\\r?\\n/).length : 0;\n    const size = file.stat.size < 1024 ? `${file.stat.size} B` : `${(file.stat.size / 1024).toFixed(1)} KB`;\n    const infoRows = [\n      ["Total IOCs", counts.Total],\n      ["IOC breakdown", `URL ${counts.URL} · IP ${counts.IP} · Domain ${counts.Domain} · Hash ${counts.Hash} · Email ${counts.Email}`],\n      ["Words", words],\n      ["Lines", lines],\n      ["File size", size],\n      ["Created", new Date(file.stat.ctime).toLocaleString()],\n      ["Modified", new Date(file.stat.mtime).toLocaleString()]\n    ];\n    for (const [name, value] of infoRows) {\n      infoGrid.createEl("span", { text: name, cls: "ct-note-info-label" });\n      infoGrid.createEl("span", { text: String(value), cls: "ct-note-info-value" });\n    }\n\n'''
if old_top not in s:
    raise SystemExit('top summary/safe block not found')
s = s.replace(old_top, new_top, 1)

# 3) Remove old collapsible Note Info block.
old_info = '''    const infoBody = this.makeDropdown(container, "info", "Note Info");\n    const words = (text.match(/\\S+/g) || []).length;\n    const resolved = this.app.metadataCache.resolvedLinks || {};\n    const outgoing = resolved[file.path] ? Object.keys(resolved[file.path]).length : 0;\n    let backlinks = 0;\n    for (const links of Object.values(resolved)) if (links && Object.prototype.hasOwnProperty.call(links, file.path)) backlinks++;\n    const grid = infoBody.createDiv({ cls: "ct-note-info" });\n    for (const [name, value] of [["Words", words], ["Backlinks", backlinks], ["Outgoing", outgoing], ["Created", new Date(file.stat.ctime).toLocaleString()], ["Modified", new Date(file.stat.mtime).toLocaleString()]]) {\n      grid.createEl("span", { text: name, cls: "ct-note-info-label" });\n      grid.createEl("span", { text: String(value), cls: "ct-note-info-value" });\n    }\n'''
if old_info not in s:
    raise SystemExit('old Note Info block not found')
s = s.replace(old_info, '', 1)

p.write_text(s, encoding='utf-8')

css = Path('styles.css')
c = css.read_text(encoding='utf-8')
addition = r'''

/* Always-visible Note Info and Safe Links control */
.ct-safe-links-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 12px 0 10px;
  padding: 9px 10px;
  border: 1px solid var(--background-modifier-border);
  border-radius: 8px;
  background: var(--background-secondary);
  font-weight: 600;
}

.ct-safe-links-row button {
  min-width: 56px;
}

.ct-note-info-card {
  margin: 0 0 10px;
  padding: 10px;
  border: 1px solid var(--background-modifier-border);
  border-radius: 8px;
  background: var(--background-secondary);
}

.ct-note-info-title {
  margin-bottom: 8px;
  font-weight: 700;
}

.ct-note-info-card .ct-note-info {
  grid-template-columns: minmax(90px, auto) minmax(0, 1fr);
}
'''
if '/* Always-visible Note Info and Safe Links control */' not in c:
    c += addition
css.write_text(c, encoding='utf-8')
