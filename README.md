# Table Doctor

An [Obsidian](https://obsidian.md) plugin that automatically fixes broken markdown tables by removing blank lines between table rows.

## The Problem

When LLMs (ChatGPT, Claude, Gemini, etc.) generate markdown tables, they often insert blank lines between rows:

```markdown
| Name | Score |

|---|---|

| Alice | 95 |

| Bob | 82 |
```

CommonMark requires table rows to be **contiguous** — no blank lines between them. Obsidian follows this spec, so tables with blank lines render as plain text instead of formatted tables.

Table Doctor detects this pattern and removes the blank lines automatically:

```markdown
| Name | Score |
|---|---|
| Alice | 95 |
| Bob | 82 |
```

## Features

**Automatic triggers (all configurable):**

- **Fix on save** — tables are fixed whenever a file is modified, with per-file debouncing
- **Fix on paste** — broken tables in clipboard content are fixed before insertion
- **Fix on file open** — catches files arriving via sync, git, or external editors

**Manual commands** (Command Palette / Cmd+P / Ctrl+P):

- `Table Doctor: Fix tables in current file` — one-shot fix for the active file
- `Table Doctor: Fix tables in all files` — batch scan and fix across your entire vault
- `Table Doctor: Preview table fixes (dry run)` — diff preview showing exactly what will change, with Apply/Cancel buttons

**UI elements:**

- Ribbon icon (stethoscope) for quick one-click manual fix
- Status bar indicator (`TD: ready` / `TD: fixing...` / `TD: fixed`)

## What It Protects

Table Doctor will **not** touch:

- Fenced code blocks (backticks and tildes, with proper fence length matching per CommonMark spec)
- HTML comments (`<!-- ... -->`)
- YAML frontmatter (`---`)
- Lines that don't look like table rows (requires `|` delimiters with 2+ columns to avoid false positives)

It **does** handle:

- Tables inside blockquotes (`> | ... |`)
- Nested blockquotes (`>> | ... |`)
- Multiple consecutive blank lines between rows
- Empty blockquote lines (`>` or `> `) between blockquote table rows
- CRLF and LF line endings (detects and preserves original style)

## Settings

All settings are accessible via **Settings > Table Doctor**.

| Setting | Default | Description |
|---|---|---|
| Fix on save | On | Auto-fix when files are modified |
| Fix on paste | On | Fix pasted content before insertion |
| Fix on file open | On | Fix when opening a file (catches sync/git) |
| Show notices | On | Display notification toasts when tables are fixed |
| Excluded folders | (empty) | Comma-separated folder paths to skip (e.g. `Templates, Archive/old`) |

## Installation

### From Community Plugins (recommended)

1. Open **Settings > Community Plugins**
2. Click **Browse** and search for **"Table Doctor"**
3. Click **Install**, then **Enable**

### Manual Installation

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/robertoecf/obsidian-table-doctor/releases/latest)
2. Create a folder: `<your-vault>/.obsidian/plugins/table-doctor/`
3. Place both files in that folder
4. Restart Obsidian and enable the plugin in **Settings > Community Plugins**

## Building from Source

```bash
git clone https://github.com/robertoecf/obsidian-table-doctor.git
cd obsidian-table-doctor
npm install
npm run build
```

The built `main.js` will be in the project root. Copy it along with `manifest.json` to your vault's plugin folder.

For development with watch mode:

```bash
npm run dev
```

## Architecture

The plugin uses a two-pass approach:

1. **`buildProtectedMask()`** scans the file and builds a `Set<number>` of line indices inside fenced code blocks, HTML comments, and YAML frontmatter. These lines are never modified.

2. **`fixBrokenTables()`** walks the remaining lines. When it finds a table row followed by blank lines followed by another table row, it removes the blank lines.

Key design decisions:

- **Atomic file operations** via `vault.process()` prevent race conditions between read and write
- **Per-file debounce** (`Map<string, timeout>`) prevents cascading fixes when multiple saves happen quickly
- **`processingFiles` guard** (`Set<string>`) prevents infinite loops where fix triggers a modify event which triggers another fix
- **`editor.replaceRange()`** instead of `editor.setValue()` preserves undo history in the editor
- **Line mapping algorithm** adjusts cursor position after content changes, finding the nearest preserved line
- **Fence length matching** follows CommonMark spec — closing fence must be >= opening fence length
- **Blockquote prefix stripping** enables detection of tables and fences inside `> ` prefixed lines

## Known Limitations

- Tables inside blockquotes are fixed structurally (blank lines removed) but may not render as formatted tables in all Obsidian themes — Obsidian's blockquote table rendering support varies
- The plugin requires at least 2 columns (4 pipe segments) to identify a table row. This reduces false positives but will not fix single-column tables (rare in practice)
- HTML comment detection is line-based: handles `<!-- -->` on same line and multi-line blocks, but not all edge cases of interleaved HTML
- Cursor positioning after fix uses greedy line matching; files with many identical duplicate lines may see minor cursor drift
- Indented code fences inside complex nested list items may have edge cases with the standard 0-3 space indentation detection

## Contributing

Issues and PRs welcome at [github.com/robertoecf/obsidian-table-doctor](https://github.com/robertoecf/obsidian-table-doctor).

## License

[MIT](LICENSE)

## Author

[robertoecf](https://github.com/robertoecf)
