from pathlib import Path
import json

main_path = Path('main.js')
s = main_path.read_text(encoding='utf-8')

# Rebuild Note Info with image count and structured IOC pills.
start = s.find('  renderNoteInfo(parent, file, text, counts) {')
end = s.find('\n  async render() {', start)
if start < 0 or end < 0:
    raise SystemExit('renderNoteInfo block not found')

new_method = r'''  countImageEmbeds(text) {
    const source = typeof text === "string" ? text : "";
    let count = 0;

    // Standard Markdown images, including remote URLs and local Markdown paths.
    const markdown = /!\[[^\]]*\]\(\s*[^)]+\)/g;
    count += (source.match(markdown) || []).length;

    // Obsidian image embeds such as ![[image.png]] or ![[image.png|500]].
    const wiki = /!\[\[([^\]]+)\]\]/g;
    let match;
    while ((match = wiki.exec(source))) {
      const target = String(match[1] || "").split("|", 1)[0].split("#", 1)[0].trim();
      if (/\.(?:png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i.test(target)) count++;
      if (match.index === wiki.lastIndex) wiki.lastIndex++;
    }

    // Raw HTML images.
    count += (source.match(/<img\b[^>]*>/gi) || []).length;
    return count;
  }

  renderNoteInfo(parent, file, text, counts) {
    const infoCard = parent.createDiv({ cls: "ct-note-info-card" });
    infoCard.createEl("div", { text: "Note Info", cls: "ct-note-info-title" });
    const infoGrid = infoCard.createDiv({ cls: "ct-note-info" });
    const words = (text.match(/\S+/g) || []).length;
    const lines = text ? text.split(/\r?\n/).length : 0;
    const images = this.countImageEmbeds(text);
    const size = file.stat.size < 1024 ? `${file.stat.size} B` : `${(file.stat.size / 1024).toFixed(1)} KB`;

    const addInfoRow = (name, value, valueClass = "") => {
      infoGrid.createEl("span", { text: name, cls: "ct-note-info-label" });
      infoGrid.createEl("span", { text: String(value), cls: `ct-note-info-value ${valueClass}`.trim() });
    };

    addInfoRow("Total IOCs", counts.Total, "ct-note-info-ioc-total");

    infoGrid.createEl("span", { text: "IOC breakdown", cls: "ct-note-info-label ct-ioc-breakdown-label" });
    const breakdown = infoGrid.createDiv({ cls: "ct-ioc-breakdown" });
    for (const [label, value] of [["URL", counts.URL], ["IP", counts.IP], ["Domain", counts.Domain], ["Hash", counts.Hash], ["Email", counts.Email]]) {
      const pill = breakdown.createSpan({ cls: "ct-ioc-pill" });
      pill.createSpan({ text: label, cls: "ct-ioc-pill-label" });
      pill.createSpan({ text: String(value), cls: "ct-ioc-pill-count" });
    }

    addInfoRow("Words", words);
    addInfoRow("Lines", lines);
    addInfoRow("Images", images);
    addInfoRow("File size", size);
    addInfoRow("Created", new Date(file.stat.ctime).toLocaleString());
    addInfoRow("Modified", new Date(file.stat.mtime).toLocaleString());
  }
'''
s = s[:start] + new_method + s[end:]

# Replace the plain Note Tools H3 with a centered Colori workspace header.
old_title = '    container.createEl("h3", { text: "Note Tools" });\n'
new_title = '''    const sidebarHeader = container.createDiv({ cls: "ct-sidebar-header" });\n    sidebarHeader.createDiv({ text: "Colori", cls: "ct-sidebar-brand" });\n    sidebarHeader.createDiv({ text: "NOTE WORKSPACE", cls: "ct-sidebar-subtitle" });\n'''
if old_title not in s:
    raise SystemExit('Note Tools title marker not found')
s = s.replace(old_title, new_title, 1)

main_path.write_text(s, encoding='utf-8')

styles_path = Path('styles.css')
c = styles_path.read_text(encoding='utf-8')
marker = '/* Note Info + workspace header v1.4.5 */'
if marker not in c:
    c += r'''

/* Note Info + workspace header v1.4.5 */
.ct-sidebar-header {
  margin: 1px 0 14px;
  padding: 7px 6px 11px;
  text-align: center;
  border-bottom: 1px solid var(--background-modifier-border);
}

.ct-sidebar-brand {
  color: var(--text-accent);
  font-size: 1.45em;
  font-weight: 800;
  line-height: 1.1;
  letter-spacing: 0.035em;
}

.ct-sidebar-subtitle {
  margin-top: 4px;
  color: var(--text-muted);
  font-size: 0.72em;
  font-weight: 650;
  letter-spacing: 0.16em;
}

.ct-note-info-ioc-total {
  color: var(--text-accent);
  font-weight: 750;
}

.ct-ioc-breakdown-label {
  align-self: start;
  padding-top: 3px;
}

.ct-ioc-breakdown {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
  min-width: 0;
}

.ct-ioc-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border: 1px solid var(--background-modifier-border);
  border-radius: 999px;
  background: var(--background-modifier-hover);
  font-size: var(--font-ui-smaller);
  white-space: nowrap;
}

.ct-ioc-pill-label {
  color: var(--text-muted);
}

.ct-ioc-pill-count {
  color: var(--text-normal);
  font-weight: 750;
  font-variant-numeric: tabular-nums;
}
'''
styles_path.write_text(c, encoding='utf-8')

# Version bump.
manifest_path = Path('manifest.json')
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
manifest['version'] = '1.4.5'
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')

versions_path = Path('versions.json')
versions = json.loads(versions_path.read_text(encoding='utf-8'))
versions['1.4.5'] = '1.13.7'
versions_path.write_text(json.dumps(versions, indent=2) + '\n', encoding='utf-8')

for expected in ['countImageEmbeds(text)', 'addInfoRow("Images", images)', 'ct-ioc-breakdown', 'text: "Colori"', 'NOTE WORKSPACE']:
    if expected not in s:
        raise SystemExit(f'missing expected main.js output: {expected}')
