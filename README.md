# Colori

**Colori** is a lightweight Obsidian plugin for customizing folder, note, active-note, inline-title, and Markdown heading appearance without manually editing CSS snippets.

It provides controls for **color, font size, and optional icons**. Global styles act as defaults, while individual folders and notes can have their own overrides.

## Features

- Customize folder and note title colors and font sizes
- Customize the active note title
- Customize the inline note title
- Customize H1-H6 heading colors and font sizes
- Add optional emoji or Unicode icons to folders and notes
- Set default icons globally
- Apply per-folder and per-note overrides
- Right-click a note or folder and choose **Customize title**
- Search for notes and folders from plugin settings
- Automatically follow renamed files and folders
- Automatically remove stale overrides when files or folders are deleted
- Reset all settings to defaults

## Privacy and security

Colori is designed to be local-first and minimal.

- No network requests
- No telemetry or analytics
- No ads
- No account or cloud service required
- No shell commands
- No Node.js filesystem access
- No modification of Markdown note contents
- Settings are stored locally using Obsidian's built-in plugin data API
- User-controlled values are validated before being used for generated styles

Colori only changes how titles and headings are displayed in the Obsidian interface.

## Installation

### Manual installation

1. Download the latest release.
2. Create this folder inside your vault:

```text
.obsidian/plugins/colori/
```

3. Copy these files into the folder:

```text
main.js
manifest.json
styles.css
```

4. Restart Obsidian or reload the app.
5. Open **Settings -> Community plugins**.
6. Enable **Colori**.
7. Open **Settings -> Colori** to configure it.

### Migrating from an earlier development build

Earlier development versions used a different plugin ID. If you already use one of those versions, rename its plugin folder to:

```text
colori
```

Keep the existing `data.json` in that folder if you want to preserve your saved settings, then replace `main.js`, `manifest.json`, and `styles.css` with the new files.

## Individual customization

You can customize a specific item in two ways.

### File Explorer

Right-click a note or folder and select **Customize title**.

You can then assign:

- Color
- Font size
- Optional icon

### Settings

Open **Settings -> Colori -> Individual overrides** and choose a folder or note.

## Icons

Icons use emoji or Unicode symbols, so Colori has no external icon-library dependency.

Examples:

`📁` `🛡️` `⭐` `🔥` `🧪` `📝` `✅` `⚠️` `💻` `📚`

## How it works

Colori uses Obsidian's plugin API for settings, vault item selection, and context-menu integration. Global appearance values are exposed as CSS variables. Per-item overrides generate narrowly scoped CSS rules that target the selected file or folder path.

The plugin does not rewrite note files. Appearance preferences are stored separately as plugin settings.

## License

Colori is released under the MIT License. See [LICENSE](LICENSE).

## Project status

Colori is under active development. Releases and future updates are maintained in this repository.

---

**Created by H4d33r**
