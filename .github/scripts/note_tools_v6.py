from pathlib import Path
import re

main_path = Path('main.js')
s = main_path.read_text(encoding='utf-8')

# Scanner: All is the default and a valid unlimited result mode.
s = s.replace('this.scanLimit = 25;', 'this.scanLimit = "all";', 1)
s = s.replace(
    'const safeLimit = IOC_LIMITS.has(Number(limit)) ? Number(limit) : 25;',
    'const safeLimit = limit === "all" ? Number.POSITIVE_INFINITY : (IOC_LIMITS.has(Number(limit)) ? Number(limit) : Number.POSITIVE_INFINITY);',
    1,
)
s = s.replace('return results.slice(0, safeLimit);', 'return Number.isFinite(safeLimit) ? results.slice(0, safeLimit) : results;', 1)
# Avoid keeping the Markdown closing parenthesis in URL IOC values.
s = s.replace('/\\b(?:https?|hxxps?):\\/\\/[^\\s<>"\'`]+/gi', '/\\b(?:https?|hxxps?):\\/\\/[^\\s<>"\'`\\)]+/gi')

# Lightweight local relationship scoring helpers. No network, embeddings, or external model.
relation_helpers = r'''

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
'''
marker = '\n  async openSidebar() {'
if marker not in s:
    raise SystemExit('openSidebar marker not found')
s = s.replace(marker, relation_helpers + marker, 1)

# Add a reusable always-visible Note Info renderer; it will be called at the bottom.
info_method = r'''

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
'''
read_marker = '  async readTrackedText(file) {\n    const editor = this.plugin.getEditorForFile(file);\n    return editor ? editor.getValue() : this.app.vault.cachedRead(file);\n  }\n'
if read_marker not in s:
    raise SystemExit('readTrackedText marker not found')
s = s.replace(read_marker, read_marker + info_method, 1)

# Remove old Note Info card from the top.
old_info = r'''    const infoCard = container.createDiv({ cls: "ct-note-info-card" });
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

'''
if old_info not in s:
    raise SystemExit('top Note Info block not found')
s = s.replace(old_info, '', 1)

# Result limit selector: All first/default.
old_limit = r'''    const limitSelect = limitRow.createEl("select");
    for (const limit of [10, 25, 50, 100, 250]) {
      const option = limitSelect.createEl("option", { value: String(limit), text: String(limit) });
      if (limit === this.scanLimit) option.selected = true;
    }
    limitSelect.addEventListener("change", () => { this.scanLimit = Number(limitSelect.value); this.scanResults = null; });
'''
new_limit = r'''    const limitSelect = limitRow.createEl("select");
    for (const [value, label] of [["all", "All"], ["10", "10"], ["25", "25"], ["50", "50"], ["100", "100"], ["250", "250"]]) {
      const option = limitSelect.createEl("option", { value, text: label });
      if (String(this.scanLimit) === value) option.selected = true;
    }
    limitSelect.addEventListener("change", () => {
      this.scanLimit = limitSelect.value === "all" ? "all" : Number(limitSelect.value);
      this.scanResults = null;
    });
'''
if old_limit not in s:
    raise SystemExit('IOC limit block not found')
s = s.replace(old_limit, new_limit, 1)

# Scanner execution: unlimited unless the user chooses a number.
old_scan = r'''      const all = [];
      for (const type of this.scanTypes) {
        if (all.length >= this.scanLimit) break;
        all.push(...this.plugin.scanIocs(currentText, type, this.scanLimit - all.length));
      }
      this.scanResults = all.slice(0, this.scanLimit);
'''
new_scan = r'''      const all = [];
      const numericLimit = this.scanLimit === "all" ? Number.POSITIVE_INFINITY : Number(this.scanLimit);
      for (const type of this.scanTypes) {
        if (Number.isFinite(numericLimit) && all.length >= numericLimit) break;
        const remaining = Number.isFinite(numericLimit) ? Math.max(0, numericLimit - all.length) : "all";
        all.push(...this.plugin.scanIocs(currentText, type, remaining));
      }
      this.scanResults = Number.isFinite(numericLimit) ? all.slice(0, numericLimit) : all;
'''
if old_scan not in s:
    raise SystemExit('IOC scan execution block not found')
s = s.replace(old_scan, new_scan, 1)

# Scanner output: collapsible groups, distinct headings, lazy row rendering, hover-only per-row Copy.
old_results = r'''    if (this.scanResults && this.scanPath === file.path) {
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
'''
new_results = r'''    if (this.scanResults && this.scanPath === file.path) {
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
'''
if old_results not in s:
    raise SystemExit('IOC results block not found')
s = s.replace(old_results, new_results, 1)

# Appearance: tag each Setting row so narrow-sidebar alignment is deterministic.
old_appearance = r'''    const appearanceBody = this.makeDropdown(container, "appearance", "Appearance");
    const existing = this.plugin.getOverride("file", file.path);
    const appearance = existing ? { ...existing } : { color: this.plugin.settings.noteColor, size: this.plugin.settings.noteSize, icon: "" };
    new Setting(appearanceBody).setName("Title color").addColorPicker((picker) => picker.setValue(appearance.color).onChange(async (value) => { appearance.color = sanitizeColor(value, this.plugin.settings.noteColor); await this.plugin.upsertOverride("file", file.path, appearance); }));
    new Setting(appearanceBody).setName("Title size").addSlider((slider) => slider.setLimits(10, 40, 1).setValue(appearance.size).setDynamicTooltip().onChange(async (value) => { appearance.size = sanitizeSize(value, 10, 40, this.plugin.settings.noteSize); await this.plugin.upsertOverride("file", file.path, appearance); }));
    new Setting(appearanceBody).setName("Icon").addText((input) => input.setPlaceholder("Optional").setValue(appearance.icon || "").onChange(async (value) => { appearance.icon = sanitizeIcon(value); await this.plugin.upsertOverride("file", file.path, appearance); }));
'''
new_appearance = r'''    const appearanceBody = this.makeDropdown(container, "appearance", "Appearance");
    appearanceBody.addClass("ct-appearance-body");
    const existing = this.plugin.getOverride("file", file.path);
    const appearance = existing ? { ...existing } : { color: this.plugin.settings.noteColor, size: this.plugin.settings.noteSize, icon: "" };
    const colorSetting = new Setting(appearanceBody).setName("Title color").addColorPicker((picker) => picker.setValue(appearance.color).onChange(async (value) => { appearance.color = sanitizeColor(value, this.plugin.settings.noteColor); await this.plugin.upsertOverride("file", file.path, appearance); }));
    colorSetting.settingEl.addClass("ct-appearance-setting");
    const sizeSetting = new Setting(appearanceBody).setName("Title size").addSlider((slider) => slider.setLimits(10, 40, 1).setValue(appearance.size).setDynamicTooltip().onChange(async (value) => { appearance.size = sanitizeSize(value, 10, 40, this.plugin.settings.noteSize); await this.plugin.upsertOverride("file", file.path, appearance); }));
    sizeSetting.settingEl.addClass("ct-appearance-setting");
    const iconSetting = new Setting(appearanceBody).setName("Icon").addText((input) => input.setPlaceholder("Optional").setValue(appearance.icon || "").onChange(async (value) => { appearance.icon = sanitizeIcon(value); await this.plugin.upsertOverride("file", file.path, appearance); }));
    iconSetting.settingEl.addClass("ct-appearance-setting");
'''
if old_appearance not in s:
    raise SystemExit('Appearance block not found')
s = s.replace(old_appearance, new_appearance, 1)

# Replace the old Graph-only controls with a Smart-Connections-inspired local Related Notes list.
old_graph = r'''    const graphBody = this.makeDropdown(container, "graph", "Graph");
    const count = this.plugin.getOutgoingConnections(file.path).length;
    const graphActions = graphBody.createDiv({ cls: "ct-sidebar-actions" });
    const connect = graphActions.createEl("button", { text: "Connect note" });
    connect.addEventListener("click", () => new NoteSuggestModal(this.app, file.path, async (target) => { await this.plugin.addConnection(file, target); this.openSections.add("graph"); await this.render(); }).open());
    const manage = graphActions.createEl("button", { text: `Connections (${count})` });
    manage.addEventListener("click", () => new ConnectionsModal(this.app, this.plugin, file).open());
    graphBody.createEl("p", { text: this.plugin.settings.graphMatchNoteColors ? "Graph color matching is enabled globally." : "Graph color matching is disabled globally.", cls: "ct-muted" });

'''
new_graph = r'''    const graphBody = this.makeDropdown(container, "graph", "Connections");
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

'''
if old_graph not in s:
    raise SystemExit('Graph block not found')
s = s.replace(old_graph, new_graph, 1)

main_path.write_text(s, encoding='utf-8')

# CSS overrides/additions for grouped IOC results, related notes, and aligned Appearance controls.
css_path = Path('styles.css')
c = css_path.read_text(encoding='utf-8')
marker_css = '/* Note Tools v6: grouped IOCs, related notes, aligned appearance */'
if marker_css not in c:
    c += r'''

/* Note Tools v6: grouped IOCs, related notes, aligned appearance */
.ct-ioc-result-count {
  margin: 4px 0 8px;
  color: var(--text-muted);
  font-size: var(--font-ui-small);
}

.ct-ioc-result-group {
  margin: 7px 0;
  border: 1px solid var(--background-modifier-border);
  border-radius: 7px;
  overflow: hidden;
  background: var(--background-secondary);
}

.ct-ioc-result-group > summary {
  cursor: pointer;
  list-style: none;
  padding: 8px 10px;
  user-select: none;
}

.ct-ioc-result-group > summary::-webkit-details-marker { display: none; }
.ct-ioc-result-group > summary::after {
  content: "›";
  float: right;
  color: var(--text-muted);
  transition: transform 120ms ease;
}
.ct-ioc-result-group[open] > summary::after { transform: rotate(90deg); }

.ct-ioc-result-group .ct-ioc-group-title {
  margin: 0;
  color: var(--text-accent);
  font-weight: 750;
  font-size: var(--font-ui-small);
}

.ct-ioc-group-body {
  padding: 4px 9px 8px;
  border-top: 1px solid var(--background-modifier-border);
  background: var(--background-primary);
}

.ct-ioc-row .ct-ioc-code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ct-ioc-row .ct-ioc-copy {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 100ms ease;
}
.ct-ioc-row:hover .ct-ioc-copy,
.ct-ioc-row:focus-within .ct-ioc-copy {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
}

.ct-related-heading {
  margin-top: 14px;
  color: var(--text-accent);
  font-weight: 750;
}
.ct-related-help { margin: 4px 0 8px; }
.ct-related-list { display: flex; flex-direction: column; gap: 6px; }
.ct-related-note {
  border: 1px solid var(--background-modifier-border);
  border-radius: 7px;
  overflow: hidden;
  background: var(--background-secondary);
}
.ct-related-note > summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  list-style: none;
  padding: 8px 9px;
}
.ct-related-note > summary::-webkit-details-marker { display: none; }
.ct-related-note-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 650;
}
.ct-related-note-signal {
  color: var(--text-accent);
  font-size: var(--font-ui-smaller);
}
.ct-related-note-body {
  padding: 8px 9px 9px;
  border-top: 1px solid var(--background-modifier-border);
  background: var(--background-primary);
}
.ct-related-note-path {
  color: var(--text-muted);
  font-size: var(--font-ui-smaller);
  overflow-wrap: anywhere;
}
.ct-related-note-reasons {
  margin-top: 5px;
  font-size: var(--font-ui-small);
  line-height: 1.4;
}
.ct-graph-state { margin: 9px 0 0; }

.ct-appearance-body .ct-appearance-setting {
  display: grid !important;
  grid-template-columns: minmax(86px, 1fr) minmax(0, 1.2fr);
  align-items: center;
  gap: 8px;
  padding: 7px 0 !important;
}
.ct-appearance-setting .setting-item-info {
  min-width: 0;
  margin: 0 !important;
}
.ct-appearance-setting .setting-item-control {
  width: 100%;
  min-width: 0;
  margin: 0 !important;
  justify-content: flex-end;
}
.ct-appearance-setting .setting-item-control input[type="text"] {
  width: 100%;
  min-width: 0;
}
.ct-appearance-setting .setting-item-control input[type="range"],
.ct-appearance-setting .setting-item-control .slider {
  width: 100%;
  min-width: 0;
}

.ct-note-info-card {
  margin-top: 12px;
  margin-bottom: 0;
}
'''
css_path.write_text(c, encoding='utf-8')

# Sanity checks so the workflow fails before committing if the intended UI was not produced.
checks = [
    'this.scanLimit = "all";',
    'text: "Connections"',
    'text: "Related Notes"',
    'this.renderNoteInfo(container, file, text, counts);',
    'ct-ioc-result-group',
    'ct-appearance-setting',
]
for check in checks:
    if check not in s and check not in c:
        raise SystemExit(f'missing expected output: {check}')
