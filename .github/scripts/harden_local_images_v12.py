from pathlib import Path
import json

main_path = Path('main.js')
s = main_path.read_text(encoding='utf-8')

old_constants = '''const MAX_LOCAL_IMAGE_BYTES = 20 * 1024 * 1024;\nconst MAX_REMOTE_IMAGES_PER_RUN = 200;\nconst LOCAL_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico"]);'''
new_constants = '''const MAX_LOCAL_IMAGE_BYTES = 20 * 1024 * 1024;\nconst MAX_REMOTE_IMAGES_PER_RUN = 50;\nconst MAX_REMOTE_IMAGE_TOTAL_BYTES_PER_RUN = 100 * 1024 * 1024;\nconst SAFE_REMOTE_IMAGE_MIME_TO_EXT = Object.freeze({\n  "image/png": "png",\n  "image/jpeg": "jpg",\n  "image/gif": "gif",\n  "image/webp": "webp",\n  "image/bmp": "bmp",\n  "image/avif": "avif",\n  "image/x-icon": "ico",\n  "image/vnd.microsoft.icon": "ico"\n});'''
if old_constants not in s:
    raise SystemExit('image constants block not found')
s = s.replace(old_constants, new_constants, 1)

start = s.find('  getLocalImageExtension(url, contentType) {')
end = s.find('\n  buildLocalImageFilename(url, extension) {', start)
if start < 0 or end < 0:
    raise SystemExit('getLocalImageExtension block not found')

security_helpers = r'''  validateRemoteImageUrl(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl || "").trim());
      if (parsed.protocol !== "https:") return { ok: false, reason: "Only HTTPS image URLs are allowed" };
      if (parsed.username || parsed.password) return { ok: false, reason: "URLs containing credentials are blocked" };
      if (parsed.port && parsed.port !== "443") return { ok: false, reason: "Non-standard HTTPS ports are blocked" };

      const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      if (!host || host.length > 253) return { ok: false, reason: "Invalid hostname" };
      if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".internal") || host.endsWith(".home") || host.endsWith(".corp")) {
        return { ok: false, reason: "Local/internal hostnames are blocked" };
      }

      // Do not allow literal IPv4/IPv6 destinations. This prevents obvious loopback,
      // RFC1918, link-local, and cloud-metadata targets from note-controlled URLs.
      if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(":")) {
        return { ok: false, reason: "IP-literal image URLs are blocked" };
      }

      // Require a normal DNS-style public hostname. Punycode labels are fine.
      if (!host.includes(".") || !/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".") || host.includes("..")) {
        return { ok: false, reason: "Non-public-looking hostnames are blocked" };
      }

      return { ok: true, url: parsed.href, hostname: host };
    } catch {
      return { ok: false, reason: "Invalid image URL" };
    }
  }

  getLocalImageExtension(contentType) {
    const mime = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
    return SAFE_REMOTE_IMAGE_MIME_TO_EXT[mime] || null;
  }

  hasValidImageMagic(arrayBuffer, extension) {
    if (!(arrayBuffer instanceof ArrayBuffer)) return false;
    const bytes = new Uint8Array(arrayBuffer);
    const ascii = (start, length) => {
      if (bytes.length < start + length) return "";
      return String.fromCharCode(...bytes.slice(start, start + length));
    };

    if (extension === "png") {
      const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      return bytes.length >= sig.length && sig.every((value, index) => bytes[index] === value);
    }
    if (extension === "jpg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (extension === "gif") return ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a";
    if (extension === "webp") return ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP";
    if (extension === "bmp") return ascii(0, 2) === "BM";
    if (extension === "ico") return bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00;
    if (extension === "avif") {
      if (ascii(4, 4) !== "ftyp") return false;
      const header = ascii(8, Math.min(32, Math.max(0, bytes.length - 8)));
      return header.includes("avif") || header.includes("avis");
    }
    return false;
  }
'''
s = s[:start] + security_helpers + s[end:]

start = s.find('  async downloadRemoteImage(url, noteFile) {')
end = s.find('\n  async localizeRemoteImages(file) {', start)
if start < 0 or end < 0:
    raise SystemExit('downloadRemoteImage block not found')

new_download = r'''  async downloadRemoteImage(url, noteFile, remainingRunBytes = MAX_REMOTE_IMAGE_TOTAL_BYTES_PER_RUN) {
    const checked = this.validateRemoteImageUrl(url);
    if (!checked.ok) throw new Error(checked.reason || "Blocked image URL");
    if (!(noteFile instanceof TFile) || noteFile.extension !== "md") throw new Error("Invalid destination note");

    const effectiveLimit = Math.min(MAX_LOCAL_IMAGE_BYTES, Math.max(0, Number(remainingRunBytes) || 0));
    if (effectiveLimit <= 0) throw new Error("Per-run download limit reached");

    let response;
    try {
      response = await requestUrl({
        url: checked.url,
        method: "GET",
        headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/bmp,image/x-icon;q=0.8" }
      });
    } catch (error) {
      throw new Error(`Download failed: ${error?.message || error}`);
    }

    if (!response || response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response?.status || "error"}`);
    }

    const contentLength = Number(this.getResponseHeader(response.headers, "content-length"));
    if (Number.isFinite(contentLength) && contentLength > effectiveLimit) {
      throw new Error(effectiveLimit < MAX_LOCAL_IMAGE_BYTES ? "Per-run download limit would be exceeded" : "Image is larger than 20 MB");
    }

    const contentType = this.getResponseHeader(response.headers, "content-type");
    const extension = this.getLocalImageExtension(contentType);
    if (!extension) throw new Error("Server did not return a supported image MIME type");

    const data = response.arrayBuffer;
    if (!(data instanceof ArrayBuffer) || data.byteLength === 0) throw new Error("Empty image response");
    if (data.byteLength > effectiveLimit) {
      throw new Error(effectiveLimit < MAX_LOCAL_IMAGE_BYTES ? "Per-run download limit would be exceeded" : "Image is larger than 20 MB");
    }
    if (!this.hasValidImageMagic(data, extension)) throw new Error("Downloaded bytes do not match the declared image type");

    const filename = this.buildLocalImageFilename(checked.url, extension);
    const attachmentPath = await this.app.fileManager.getAvailablePathForAttachment(filename, noteFile.path);
    await this.app.vault.createBinary(attachmentPath, data);
    const created = this.app.vault.getAbstractFileByPath(attachmentPath);
    if (!(created instanceof TFile)) throw new Error("Attachment was not created");
    return created;
  }
'''
s = s[:start] + new_download + s[end:]

start = s.find('  async localizeRemoteImages(file) {')
end = s.find('\n  getUrlHosts(text) {', start)
if start < 0 or end < 0:
    raise SystemExit('localizeRemoteImages block not found')

new_localize = r'''  async localizeRemoteImages(file) {
    if (!(file instanceof TFile) || file.extension !== "md") return false;
    const editor = this.getEditorForFile(file);
    const current = editor ? editor.getValue() : await this.app.vault.read(file);
    const allEmbeds = this.getRemoteImageEmbeds(current);
    if (!allEmbeds.length) {
      new Notice("No remote image embeds found in this note.");
      return false;
    }

    const eligible = [];
    const blocked = [];
    for (const embed of allEmbeds) {
      const checked = this.validateRemoteImageUrl(embed.url);
      if (checked.ok) eligible.push({ ...embed, url: checked.url, hostname: checked.hostname });
      else blocked.push({ ...embed, reason: checked.reason || "Blocked by security rules" });
    }

    if (!eligible.length) {
      new Notice(`No eligible HTTPS images. ${blocked.length} remote image${blocked.length === 1 ? " was" : "s were"} blocked by security rules.`);
      return false;
    }

    const hosts = [...new Set(eligible.map((item) => item.hostname))].sort();
    const visibleHosts = hosts.slice(0, 8);
    const hostLines = visibleHosts.map((host) => `• ${host}`);
    if (hosts.length > visibleHosts.length) hostLines.push(`• …and ${hosts.length - visibleHosts.length} more host${hosts.length - visibleHosts.length === 1 ? "" : "s"}`);
    const confirmation = [
      `Colori will download ${eligible.length} image embed${eligible.length === 1 ? "" : "s"} from:`,
      "",
      ...hostLines,
      "",
      "Only continue if you trust these hosts. No download has started yet."
    ].join("\n");
    if (!window.confirm(confirmation)) {
      new Notice("Image localization cancelled.");
      return false;
    }

    const embeds = eligible.slice(0, MAX_REMOTE_IMAGES_PER_RUN);
    const downloaded = new Map();
    const failed = new Map();
    let totalBytes = 0;
    let totalLimitReached = false;

    for (const embed of embeds) {
      if (downloaded.has(embed.url) || failed.has(embed.url)) continue;
      const remaining = MAX_REMOTE_IMAGE_TOTAL_BYTES_PER_RUN - totalBytes;
      if (remaining <= 0) {
        totalLimitReached = true;
        break;
      }
      try {
        const attachment = await this.downloadRemoteImage(embed.url, file, remaining);
        downloaded.set(embed.url, attachment);
        totalBytes += Math.max(0, Number(attachment.stat?.size) || 0);
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

    const skippedForCount = Math.max(0, eligible.length - embeds.length);
    const parts = [`Localized ${localized} image${localized === 1 ? "" : "s"}.`];
    if (blocked.length) parts.push(`${blocked.length} unsafe/ineligible URL${blocked.length === 1 ? " was" : "s were"} blocked.`);
    if (failed.size) parts.push(`${failed.size} download${failed.size === 1 ? "" : "s"} failed validation or download.`);
    if (skippedForCount) parts.push(`${skippedForCount} skipped because the per-run limit is ${MAX_REMOTE_IMAGES_PER_RUN}.`);
    if (totalLimitReached) parts.push("Stopped at the 100 MB per-run download limit.");
    new Notice(parts.join(" "));
    return localized > 0;
  }
'''
s = s[:start] + new_localize + s[end:]

old_sidebar = '''    const localImagesBody = this.makeDropdown(container, "local-images", "Local Images");\n    const remoteImages = this.plugin.getRemoteImageEmbeds(text);\n    localImagesBody.createEl("p", { text: `Remote images: ${remoteImages.length} · Total images: ${this.countImageEmbeds(text)}`, cls: "ct-muted" });\n    const localizeButton = localImagesBody.createEl("button", { text: "Localize remote images", cls: "ct-sidebar-wide-button" });\n    localizeButton.disabled = remoteImages.length === 0;'''
new_sidebar = '''    const localImagesBody = this.makeDropdown(container, "local-images", "Local Images");\n    const remoteImages = this.plugin.getRemoteImageEmbeds(text);\n    const eligibleRemoteImages = remoteImages.filter((item) => this.plugin.validateRemoteImageUrl(item.url).ok);\n    const blockedRemoteImages = remoteImages.length - eligibleRemoteImages.length;\n    localImagesBody.createEl("p", { text: `Eligible HTTPS images: ${eligibleRemoteImages.length} · Blocked: ${blockedRemoteImages} · Total images: ${this.countImageEmbeds(text)}`, cls: "ct-muted" });\n    const localizeButton = localImagesBody.createEl("button", { text: "Localize remote images", cls: "ct-sidebar-wide-button" });\n    localizeButton.disabled = eligibleRemoteImages.length === 0;'''
if old_sidebar not in s:
    raise SystemExit('Local Images sidebar block not found')
s = s.replace(old_sidebar, new_sidebar, 1)

old_help = 'localImagesBody.createEl("p", { text: "Downloads HTTP/HTTPS image embeds into your Obsidian attachment folder and rewrites this note to the local copy. Normal links are not changed.", cls: "ct-muted" });'
new_help = 'localImagesBody.createEl("p", { text: "Security-first: HTTPS only. You must confirm the source hosts before any network request. Downloads are MIME-checked, signature-checked, size-limited, and saved only through Obsidian’s attachment API.", cls: "ct-muted" });'
if old_help not in s:
    raise SystemExit('Local Images help text not found')
s = s.replace(old_help, new_help, 1)

main_path.write_text(s, encoding='utf-8')

manifest_path = Path('manifest.json')
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
manifest['version'] = '1.4.7'
manifest['description'] = 'Development build with Note Tools, Safe Links, IOC scanning, security-hardened local image localization, folder appearance inheritance, and note connections.'
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')

versions_path = Path('versions.json')
versions = json.loads(versions_path.read_text(encoding='utf-8'))
versions['1.4.7'] = '1.13.7'
versions_path.write_text(json.dumps(versions, indent=2) + '\n', encoding='utf-8')

for expected in [
    'MAX_REMOTE_IMAGE_TOTAL_BYTES_PER_RUN',
    'validateRemoteImageUrl(rawUrl)',
    'hasValidImageMagic(arrayBuffer, extension)',
    'Only continue if you trust these hosts',
    'Eligible HTTPS images:',
    'Server did not return a supported image MIME type',
    'Downloaded bytes do not match the declared image type'
]:
    if expected not in s:
        raise SystemExit(f'missing security hardening output: {expected}')

if 'LOCAL_IMAGE_EXTENSIONS' in s:
    raise SystemExit('legacy extension-only trust remains in main.js')
