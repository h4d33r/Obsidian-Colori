from pathlib import Path
import json

main_path = Path('main.js')
s = main_path.read_text(encoding='utf-8')

# Obsidian request API.
old_import = '''  TFile,\n  TFolder,\n  normalizePath\n} = require("obsidian");'''
new_import = '''  TFile,\n  TFolder,\n  normalizePath,\n  requestUrl\n} = require("obsidian");'''
if old_import not in s:
    raise SystemExit('obsidian import marker not found')
s = s.replace(old_import, new_import, 1)

old_constants = 'const IOC_LIMITS = new Set([10, 25, 50, 100, 250]);\n'
new_constants = '''const IOC_LIMITS = new Set([10, 25, 50, 100, 250]);\nconst MAX_LOCAL_IMAGE_BYTES = 20 * 1024 * 1024;\nconst MAX_REMOTE_IMAGES_PER_RUN = 200;\nconst LOCAL_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico"]);\n'''
if old_constants not in s:
    raise SystemExit('IOC constants marker not found')
s = s.replace(old_constants, new_constants, 1)

# Add command after refang command.
old_commands = '''    this.addCommand({\n      id: "refang-current-note",\n      name: "Refang selection or current note",\n      editorCallback: (editor, view) => this.transformEditor(editor, view?.file, "refang")\n    });\n\n    const rememberMarkdown = () => {'''
new_commands = '''    this.addCommand({\n      id: "refang-current-note",\n      name: "Refang selection or current note",\n      editorCallback: (editor, view) => this.transformEditor(editor, view?.file, "refang")\n    });\n    this.addCommand({\n      id: "localize-remote-images-current-note",\n      name: "Localize remote images in current note",\n      callback: async () => {\n        const file = this.getTrackedFile();\n        if (!(file instanceof TFile)) { new Notice("Open a Markdown note first."); return; }\n        await this.localizeRemoteImages(file);\n        this.refreshSidebar();\n      }\n    });\n\n    const rememberMarkdown = () => {'''
if old_commands not in s:
    raise SystemExit('command marker not found')
s = s.replace(old_commands, new_commands, 1)

local_image_methods = r'''

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
'''
marker = '\n  getUrlHosts(text) {'
if marker not in s:
    raise SystemExit('getUrlHosts marker not found')
s = s.replace(marker, local_image_methods + marker, 1)

# Sidebar section between Defang/Refang and IOC Scanner.
old_ui = '''    defangBody.createEl("p", { text: "If text is selected in the note, only the selection is processed. Otherwise the whole note is processed.", cls: "ct-muted" });\n\n    const iocBody = this.makeDropdown(container, "ioc", "IOC Scanner");'''
new_ui = '''    defangBody.createEl("p", { text: "If text is selected in the note, only the selection is processed. Otherwise the whole note is processed.", cls: "ct-muted" });\n\n    const localImagesBody = this.makeDropdown(container, "local-images", "Local Images");\n    const remoteImages = this.plugin.getRemoteImageEmbeds(text);\n    localImagesBody.createEl("p", { text: `Remote image embeds: ${remoteImages.length}`, cls: "ct-muted" });\n    const localizeButton = localImagesBody.createEl("button", { text: "Localize remote images", cls: "ct-sidebar-wide-button" });\n    localizeButton.disabled = remoteImages.length === 0;\n    localizeButton.addEventListener("click", async () => {\n      localizeButton.disabled = true;\n      localizeButton.setText("Localizing…");\n      await this.plugin.localizeRemoteImages(file);\n      this.openSections.add("local-images");\n      await this.render();\n    });\n    localImagesBody.createEl("p", { text: "Downloads HTTP/HTTPS image embeds into your Obsidian attachment folder and rewrites this note to the local copy. Normal links are not changed.", cls: "ct-muted" });\n\n    const iocBody = this.makeDropdown(container, "ioc", "IOC Scanner");'''
if old_ui not in s:
    raise SystemExit('sidebar insertion marker not found')
s = s.replace(old_ui, new_ui, 1)

main_path.write_text(s, encoding='utf-8')

manifest_path = Path('manifest.json')
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
manifest['version'] = '1.4.2'
manifest['description'] = 'Development build with Note Tools, Safe Links, IOC scanning, local image localization, appearance controls, and note connections.'
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')

versions_path = Path('versions.json')
versions = json.loads(versions_path.read_text(encoding='utf-8'))
versions['1.4.2'] = manifest.get('minAppVersion', '1.13.7')
versions_path.write_text(json.dumps(versions, indent=2) + '\n', encoding='utf-8')

# Sanity checks before CI syntax check.
checks = [
    'requestUrl',
    'getRemoteImageEmbeds(text)',
    'async localizeRemoteImages(file)',
    'Local Images',
    'Localize remote images',
    '"version": "1.4.2"'
]
combined = main_path.read_text(encoding='utf-8') + manifest_path.read_text(encoding='utf-8')
for expected in checks:
    if expected not in combined:
        raise SystemExit(f'missing expected output: {expected}')
