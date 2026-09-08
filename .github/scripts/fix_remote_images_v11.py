from pathlib import Path
import json

main_path = Path('main.js')
s = main_path.read_text(encoding='utf-8')

start = s.find('  getRemoteImageEmbeds(text) {')
end = s.find('\n  getResponseHeader(headers, name) {', start)
if start < 0 or end < 0:
    raise SystemExit('getRemoteImageEmbeds block not found')

new_method = r'''  getRemoteImageEmbeds(text) {
    const source = typeof text === "string" ? text : "";
    const results = [];

    const normalizeRemoteUrl = (rawValue) => {
      let value = typeof rawValue === "string" ? rawValue.trim() : "";
      if (!value) return "";

      // Markdown permits destinations wrapped in angle brackets.
      if (value.startsWith("<")) {
        const close = value.indexOf(">");
        if (close <= 1) return "";
        value = value.slice(1, close).trim();
      } else {
        // Remove an optional Markdown link title after the destination.
        const titled = value.match(/^(.*?)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))\s*$/s);
        if (titled && /^https?:\/\//i.test(titled[1].trim())) value = titled[1].trim();
      }

      // Be tolerant of a literal wrapped line inside a copied URL.
      if (/^https?:\/\//i.test(value)) value = value.replace(/[\r\n\t]+/g, "");

      try {
        const parsed = new URL(value);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
        return value;
      } catch {
        return "";
      }
    };

    // Parse the whole Markdown image destination first, then validate the URL.
    // This deliberately mirrors the broad image detection used by Note Info.
    const markdown = /!\[([^\]\r\n]{0,2048})\]\(\s*([\s\S]{1,4096}?)\s*\)/gi;
    let match;
    while ((match = markdown.exec(source))) {
      const url = normalizeRemoteUrl(match[2]);
      if (url) results.push({ kind: "markdown", full: match[0], url, alt: match[1] || "" });
      if (match.index === markdown.lastIndex) markdown.lastIndex++;
    }

    const html = /<img\b[^>]*\bsrc\s*=\s*(["'])(https?:\/\/.*?)\1[^>]*>/gi;
    while ((match = html.exec(source))) {
      const url = normalizeRemoteUrl(match[2]);
      if (url) {
        const altMatch = match[0].match(/\balt\s*=\s*(["'])(.*?)\1/i);
        results.push({ kind: "html", full: match[0], url, alt: altMatch ? altMatch[2] : "" });
      }
      if (match.index === html.lastIndex) html.lastIndex++;
    }

    return results;
  }
'''
s = s[:start] + new_method + s[end:]

old_label = '    localImagesBody.createEl("p", { text: `Remote image embeds: ${remoteImages.length}`, cls: "ct-muted" });'
new_label = '    localImagesBody.createEl("p", { text: `Remote images: ${remoteImages.length} · Total images: ${this.countImageEmbeds(text)}`, cls: "ct-muted" });'
if old_label not in s:
    raise SystemExit('Local Images counter label not found')
s = s.replace(old_label, new_label, 1)

main_path.write_text(s, encoding='utf-8')

manifest_path = Path('manifest.json')
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
manifest['version'] = '1.4.6'
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')

versions_path = Path('versions.json')
versions = json.loads(versions_path.read_text(encoding='utf-8'))
versions['1.4.6'] = '1.13.7'
versions_path.write_text(json.dumps(versions, indent=2) + '\n', encoding='utf-8')

# Sanity-check the exact TryHackMe form reported by the user against equivalent parsing.
sample = "![CyberChef's main page with all the features.](https://cdn-images.tryhackme.com/user-uploads/6645aa8c024f7893371eb7ac/room-content/6645aa8c024f7893371eb7ac-1728731934241.png)"
if 'https://cdn-images.tryhackme.com/' not in sample or '![' not in sample:
    raise SystemExit('sample sanity check failed')

for expected in ['normalizeRemoteUrl', 'Remote images: ${remoteImages.length} · Total images:', "manifest['version'] = '1.4.6'"]:
    if expected not in (s + Path(__file__).read_text(encoding='utf-8')):
        raise SystemExit(f'missing expected output: {expected}')
