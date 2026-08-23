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
- Use one **Colori** right-click action for item-specific controls
- Reset an individual title so it inherits the global defaults again
- Create folder hub notes that auto-sync when direct child notes are added, moved, renamed, or removed
- Revert a folder hub by disabling sync and removing only Colori-managed links
- Safely delete a generated hub note only when it contains no additional user content
- Connect one Markdown note to another through Colori-managed real Obsidian links
- Manage or remove Colori note connections later
- Show the global note and active-note colors in Graph view
- Search for notes and folders from plugin settings
- Automatically follow renamed files and folders
- Automatically remove stale overrides and graph configuration when files or folders are deleted
- Reset all settings to defaults

## Privacy and security

Colori is designed to be local-first and minimal.

- No network requests
- No telemetry or analytics
- No ads
- No account or cloud service required
- No shell commands
- No Node.js filesystem access
- Settings are stored locally using Obsidian's built-in plugin data API
- User-controlled values are validated before being used for generated styles
- Graph features use Obsidian vault APIs rather than direct filesystem access
- Colori only writes inside clearly marked managed sections when you explicitly enable a graph feature
- If managed markers are malformed, Colori refuses to rewrite that section rather than guessing

## Installation

### Manual installation

1. Download the version you want to test.
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

4. Keep your existing `data.json` if you are updating and want to preserve settings.
5. Restart Obsidian or reload the app.
6. Open **Settings -> Community plugins**.
7. Enable **Colori**.
8. Open **Settings -> Colori** to configure it.

### Migrating from an earlier development build

Earlier development versions used a different plugin ID. If you already use one of those versions, rename its plugin folder to:

```text
colori
```

Keep the existing `data.json` in that folder if you want to preserve your saved settings, then replace `main.js`, `manifest.json`, and `styles.css` with the new files.

## Individual customization

Right-click a Markdown note or folder and choose **Colori**.

The Colori window keeps the item-specific controls together:

- Color and font size on the same row
- Optional icon below them
- Reset to default
- Graph controls relevant to the selected note or folder

The same appearance overrides can also be created from **Settings -> Colori -> Individual overrides**.

## Folder graph hubs

Right-click a folder, choose **Colori**, then enable its folder hub.

Colori creates a Markdown note with the same name inside that folder and places links to every Markdown note directly inside the folder in a managed section.

Once enabled, the hub is automatically synchronized when direct child notes are:

- created
- deleted
- renamed
- moved into the folder
- moved out of the folder

You can still use **Sync now** manually.

To revert the feature, choose **Remove hub links**. This disables auto-sync and removes only the section between Colori's hub markers. Other content in the note is preserved.

**Delete if safe** removes the generated hub note only when the remaining note contains no user-added content. Otherwise Colori keeps the note and removes only its managed section.

## Note-to-note graph connections

Right-click a Markdown note and choose **Colori -> Connect to note** from the Colori window.

Choose another Markdown note and Colori adds a real Obsidian Markdown link inside this managed section:

```text
<!-- colori-connections:start -->
...
<!-- colori-connections:end -->
```

Because these are normal Obsidian links, Graph view displays the connection normally.

Use **Manage connections** to remove one connection or all Colori-managed outgoing connections from that note.

Colori updates stored connection paths when notes or folders are renamed and removes stale connection records when referenced items are deleted.

## Graph colors

Colori uses Obsidian's Graph CSS variables to match resolved nodes to the global note color and the focused node to the active-note color.

It does not replace or hook into the private Graph renderer.

## Icons

Icons use emoji or Unicode symbols, so Colori has no external icon-library dependency.

Examples:

`📁` `🛡️` `⭐` `🔥` `🧪` `📝` `✅` `⚠️` `💻` `📚`

## How it works

Colori uses Obsidian's plugin API for settings, vault item selection, context-menu integration, file lifecycle events, and graph-related Markdown links.

Global appearance values are exposed as CSS variables. Per-item overrides generate narrowly scoped CSS rules that target the selected file or folder path.

Graph features are reversible. Colori tracks enabled folder hubs and note connections in plugin settings while writing only their corresponding managed Markdown sections into notes.

## Development workflow

The repository uses a simple workflow:

- `main` is the stable branch
- `dev` is used for features currently being tested
- stable versions should receive clear version tags
- releases are created only after the tested development state is accepted

## License

Colori is released under the MIT License. See [LICENSE](LICENSE).

## Project status

Colori is under active development. Releases and future updates are maintained in this repository.

---

**Created by H4d33r**
