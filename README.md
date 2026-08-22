# Obsidian Colori

**Obsidian Colori** is a lightweight Obsidian plugin for visually customizing your vault without manually editing CSS snippets.

It provides simple controls for changing the **color, font size, and optional icon** of folders and note titles directly from Obsidian. Global styles can be used as defaults, while individual folders and notes can have their own overrides.

## Features

- Customize folder title color and font size
- Customize note/file title color and font size
- Customize the active note title
- Customize the inline note title
- Customize H1-H6 heading colors and font sizes
- Add optional icons to folders and notes
- Set default icons globally
- Apply individual overrides to specific folders
- Apply individual overrides to specific notes
- Right-click a note or folder in the File Explorer and choose **Customize title**
- Search for notes and folders from the plugin settings
- Edit or remove existing overrides
- Changes are saved automatically

## Example

You can style your File Explorer like this:

```text
📁 Projects
🛡️ Cyber Security
📷 Photography

   🧪 Malware Analysis.md
   🔥 Important.md
   ✅ Completed Tasks.md
```

Each folder or note can have its own color, font size, and icon.

## Installation

Obsidian Colori is currently a private plugin and is installed manually.

1. Download or clone this repository.
2. Create the following folder inside your Obsidian vault:

```text
.obsidian/plugins/obsidian-colori/
```

3. Copy these files into that folder:

```text
main.js
manifest.json
styles.css
```

4. Restart Obsidian, or reload the app.
5. Go to **Settings → Community plugins**.
6. Enable **Obsidian Colori**.
7. Open **Settings → Obsidian Colori** to configure it.

If you previously used the old CSS snippet or the earlier plugin version, disable the old snippet to avoid conflicting styles.

## Individual customization

There are two ways to customize a specific item.

### From the File Explorer

Right-click any note or folder and select **Customize title**.

You can then assign:

- Color
- Font size
- Icon

### From Settings

Open **Settings → Obsidian Colori → Individual overrides** and choose a folder or note to configure its appearance.

## Icons

Icons are currently implemented using emoji or Unicode symbols, so there is no external icon-library dependency.

Examples: `📁` `🛡️` `⭐` `🔥` `🧪` `📝` `✅` `⚠️` `💻` `📚`

## Project status

This project is being actively developed for personal use. Future improvements and updates will be maintained in this repository.

---

**Created by H4d33r**
