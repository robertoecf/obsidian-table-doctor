import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TAbstractFile,
} from "obsidian";

// ─── Settings ────────────────────────────────────────────────────────────────

interface TableDoctorSettings {
	fixOnSave: boolean;
	fixOnPaste: boolean;
	fixOnOpen: boolean;
	excludedFolders: string;
	showNotice: boolean;
}

const DEFAULT_SETTINGS: TableDoctorSettings = {
	fixOnSave: true,
	fixOnPaste: true,
	fixOnOpen: true,
	excludedFolders: "",
	showNotice: true,
};

// ─── Core logic ──────────────────────────────────────────────────────────────

/**
 * Strip blockquote prefix ("> " or ">") from a line.
 * Returns the prefix and the inner content.
 * Handles nested blockquotes (>> , >>> , etc.).
 */
function stripBlockquotePrefix(line: string): { prefix: string; inner: string } {
	const match = /^((?:>\s*)*)(.*)$/.exec(line);
	if (match && match[1].length > 0) {
		return { prefix: match[1], inner: match[2] };
	}
	return { prefix: "", inner: line };
}

/**
 * Check if a line (after stripping blockquote prefix) is a table row.
 * Requires 2+ columns (4+ pipe-separated segments) to reduce false positives.
 */
function isTableRow(line: string): boolean {
	const { inner } = stripBlockquotePrefix(line);
	const trimmed = inner.trim();
	if (trimmed.length === 0 || !trimmed.startsWith("|") || !trimmed.endsWith("|")) {
		return false;
	}
	const segments = trimmed.split("|");
	return segments.length >= 4;
}

/**
 * Parse a fenced code block opening/closing line.
 * Returns the fence character and its length, or null if not a fence.
 * CommonMark: 0-3 spaces indentation before 3+ backticks or tildes.
 * Also handles fences inside blockquotes (strips > prefix first).
 */
function parseFence(line: string): { char: string; length: number } | null {
	const { inner } = stripBlockquotePrefix(line);
	const match = /^[ ]{0,3}(`{3,}|~{3,})/.exec(inner);
	if (!match) return null;
	return { char: match[1][0], length: match[1].length };
}

/**
 * Detect YAML frontmatter at the start of the file.
 * Returns the line index AFTER the closing ---, or 0 if no frontmatter.
 */
function detectFrontmatterEnd(lines: string[]): number {
	if (lines.length === 0 || lines[0].trim() !== "---") return 0;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			return i + 1;
		}
	}
	// Unclosed frontmatter: treat entire file as frontmatter (skip all)
	return lines.length;
}

/**
 * Build a set of line indices that are inside fenced code blocks or HTML comments.
 * Handles fence length matching (closing fence must be >= opening length).
 * Handles fences inside blockquotes.
 * Skips YAML frontmatter region.
 * If an unclosed fence is detected, all lines after it are marked as code.
 */
function buildProtectedMask(lines: string[], startLine: number): Set<number> {
	const mask = new Set<number>();
	let insideCodeBlock = false;
	let openFenceChar = "";
	let openFenceLength = 0;
	let insideHtmlComment = false;

	for (let i = startLine; i < lines.length; i++) {
		const line = lines[i];

		// HTML comment tracking
		if (!insideCodeBlock) {
			if (line.includes("<!--")) {
				insideHtmlComment = true;
			}
			if (line.includes("-->")) {
				// Mark this line as protected, then exit comment
				if (insideHtmlComment) mask.add(i);
				insideHtmlComment = false;
				continue;
			}
			if (insideHtmlComment) {
				mask.add(i);
				continue;
			}
		}

		// Fence tracking
		const fence = parseFence(line);

		if (fence) {
			if (!insideCodeBlock) {
				insideCodeBlock = true;
				openFenceChar = fence.char;
				openFenceLength = fence.length;
				mask.add(i);
			} else if (fence.char === openFenceChar && fence.length >= openFenceLength) {
				mask.add(i);
				insideCodeBlock = false;
			} else {
				mask.add(i);
			}
		} else if (insideCodeBlock) {
			mask.add(i);
		}
	}

	return mask;
}

/**
 * Check if a line is blank or an empty blockquote line (just ">" or "> ").
 */
function isBlankOrEmptyBlockquote(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed === "") return true;
	// Empty blockquote: one or more > possibly with spaces, but no content
	return /^(>\s*)+$/.test(trimmed);
}

/**
 * Normalize line endings to LF. Returns original line ending style for restoration.
 */
function normalizeContent(content: string): { normalized: string; hasCRLF: boolean } {
	const hasCRLF = content.includes("\r\n");
	return {
		normalized: hasCRLF ? content.replace(/\r\n/g, "\n") : content,
		hasCRLF,
	};
}

/**
 * Remove blank lines between consecutive markdown table rows.
 * Skips: fenced code blocks, HTML comments, YAML frontmatter.
 * Handles blockquote tables.
 * Normalizes CRLF.
 * Returns the fixed string, or null if nothing changed.
 */
function fixBrokenTables(content: string): string | null {
	if (!content || content.length === 0) return null;

	const { normalized, hasCRLF } = normalizeContent(content);
	const lines = normalized.split("\n");

	// Skip YAML frontmatter
	const contentStart = detectFrontmatterEnd(lines);

	// Build protected regions mask (code blocks + HTML comments)
	const protectedMask = buildProtectedMask(lines, contentStart);

	// Mark frontmatter lines as protected too
	for (let i = 0; i < contentStart; i++) {
		protectedMask.add(i);
	}

	const result: string[] = [];
	let changed = false;
	let i = 0;

	while (i < lines.length) {
		result.push(lines[i]);

		// Only process table rows outside protected regions
		if (!protectedMask.has(i) && isTableRow(lines[i])) {
			let j = i + 1;
			let blankCount = 0;

			while (j < lines.length && isBlankOrEmptyBlockquote(lines[j])) {
				blankCount++;
				j++;
			}

			if (
				blankCount > 0 &&
				j < lines.length &&
				!protectedMask.has(j) &&
				isTableRow(lines[j])
			) {
				i = j;
				changed = true;
				continue;
			}
		}

		i++;
	}

	if (!changed) return null;

	const fixedContent = result.join("\n");
	return hasCRLF ? fixedContent.replace(/\n/g, "\r\n") : fixedContent;
}

/**
 * Compute a line mapping from original to fixed content.
 * For each original line index, stores the corresponding fixed line index (or -1 if removed).
 * Uses greedy matching: walks both arrays in lockstep.
 */
function buildLineMapping(original: string[], fixed: string[]): number[] {
	const mapping: number[] = new Array(original.length).fill(-1);
	let fixedIdx = 0;

	for (let origIdx = 0; origIdx < original.length; origIdx++) {
		if (fixedIdx < fixed.length && original[origIdx] === fixed[fixedIdx]) {
			mapping[origIdx] = fixedIdx;
			fixedIdx++;
		}
		// else: line was removed, mapping stays -1
	}

	return mapping;
}

/**
 * Find the best cursor position in the fixed content given original cursor line.
 * If the exact line was preserved, use its new position.
 * If it was removed, find the nearest preserved line before it.
 */
function mapCursorLine(mapping: number[], originalLine: number, fixedLineCount: number): number {
	// Clamp to valid range
	const clampedLine = Math.min(originalLine, mapping.length - 1);

	// Try exact mapping
	if (clampedLine >= 0 && mapping[clampedLine] >= 0) {
		return mapping[clampedLine];
	}

	// Search backward for nearest preserved line
	for (let i = clampedLine - 1; i >= 0; i--) {
		if (mapping[i] >= 0) {
			return Math.min(mapping[i] + 1, fixedLineCount - 1);
		}
	}

	// Fallback: search forward
	for (let i = clampedLine + 1; i < mapping.length; i++) {
		if (mapping[i] >= 0) {
			return Math.max(mapping[i] - 1, 0);
		}
	}

	return 0;
}

// ─── Diff preview ────────────────────────────────────────────────────────────

interface DiffLine {
	type: "keep" | "remove";
	lineNum: number;
	text: string;
}

function computeDiff(original: string[], fixed: string[]): DiffLine[] {
	const diff: DiffLine[] = [];
	const mapping = buildLineMapping(original, fixed);

	for (let i = 0; i < original.length; i++) {
		diff.push({
			type: mapping[i] >= 0 ? "keep" : "remove",
			lineNum: i + 1,
			text: original[i],
		});
	}

	return diff;
}

class DiffPreviewModal extends Modal {
	private diff: DiffLine[];
	private fileName: string;
	private onConfirm: () => void;

	constructor(app: App, diff: DiffLine[], fileName: string, onConfirm: () => void) {
		super(app);
		this.diff = diff;
		this.fileName = fileName;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h3", { text: `Table Doctor: ${this.fileName}` });

		const removedCount = this.diff.filter((d) => d.type === "remove").length;
		contentEl.createEl("p", {
			text: `${removedCount} blank line(s) will be removed between table rows.`,
		});

		// Diff view — only show lines near removals for context
		const container = contentEl.createDiv({ cls: "table-doctor-diff" });

		const CONTEXT = 2;
		const visibleLines = new Set<number>();

		// Mark lines near removals as visible
		for (let i = 0; i < this.diff.length; i++) {
			if (this.diff[i].type === "remove") {
				for (let j = Math.max(0, i - CONTEXT); j <= Math.min(this.diff.length - 1, i + CONTEXT); j++) {
					visibleLines.add(j);
				}
			}
		}

		let lastShown = -1;
		for (let i = 0; i < this.diff.length; i++) {
			if (!visibleLines.has(i)) continue;

			if (lastShown >= 0 && i - lastShown > 1) {
				const sep = container.createDiv({ cls: "table-doctor-diff-separator" });
				sep.textContent = "  ···";
			}

			const line = container.createDiv();
			const entry = this.diff[i];
			const numStr = String(entry.lineNum).padStart(4, " ");
			const displayText = entry.text || " ";

			if (entry.type === "remove") {
				line.addClass("table-doctor-diff-remove");
				line.textContent = `${numStr} - ${displayText}`;
			} else {
				line.addClass("table-doctor-diff-context");
				line.textContent = `${numStr}   ${displayText}`;
			}

			lastShown = i;
		}

		// Buttons
		const buttonRow = contentEl.createDiv({ cls: "table-doctor-button-row" });

		const cancelBtn = buttonRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		const applyBtn = buttonRow.createEl("button", { text: "Apply fixes", cls: "mod-cta" });
		applyBtn.addEventListener("click", () => {
			this.onConfirm();
			this.close();
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export default class TableDoctorPlugin extends Plugin {
	settings: TableDoctorSettings;

	private excludedFoldersList: string[] = [];
	private modifyTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();
	private processingFiles: Set<string> = new Set();
	private statusBarEl: HTMLElement | null = null;

	async onload() {
		await this.loadSettings();

		// ── Status bar ──
		this.statusBarEl = this.addStatusBarItem();
		this.updateStatusBar("idle");

		// ── Ribbon icon ──
		this.addRibbonIcon("stethoscope", "Table Doctor: fix current file", () => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view) {
				this.fixEditor(view.editor);
			} else {
				new Notice("Table Doctor: no active markdown file");
			}
		});

		// ── Commands ──
		this.addCommand({
			id: "fix-current-file",
			name: "Fix tables in current file",
			editorCallback: (editor: Editor) => {
				this.fixEditor(editor);
			},
		});

		this.addCommand({
			id: "fix-all-files",
			name: "Fix tables in all files",
			callback: () => this.fixAllFiles(),
		});

		this.addCommand({
			id: "dry-run-current-file",
			name: "Preview table fixes (dry run)",
			editorCallback: (editor: Editor) => {
				this.dryRunEditor(editor);
			},
		});

		// ── Event handlers (always registered, guarded by settings) ──
		this.registerModifyHandler();
		this.registerPasteHandler();
		this.registerFileOpenHandler();
		this.registerCleanupHandlers();

		// Settings tab
		this.addSettingTab(new TableDoctorSettingTab(this.app, this));
	}

	private updateStatusBar(state: "idle" | "fixing" | "fixed" | "error", detail?: string) {
		if (!this.statusBarEl) return;
		switch (state) {
			case "idle":
				this.statusBarEl.textContent = "TD: ready";
				break;
			case "fixing":
				this.statusBarEl.textContent = "TD: fixing...";
				break;
			case "fixed":
				this.statusBarEl.textContent = `TD: ${detail || "fixed"}`;
				setTimeout(() => this.updateStatusBar("idle"), 3000);
				break;
			case "error":
				this.statusBarEl.textContent = `TD: error`;
				setTimeout(() => this.updateStatusBar("idle"), 5000);
				break;
		}
	}

	/**
	 * Fix tables in the active editor using replaceRange (preserves undo).
	 * Uses proper line mapping for cursor adjustment.
	 */
	private fixEditor(editor: Editor): void {
		const content = editor.getValue();
		const fixed = fixBrokenTables(content);

		if (fixed === null) {
			if (this.settings.showNotice) {
				new Notice("Table Doctor: all tables OK");
			}
			this.updateStatusBar("fixed", "all OK");
			return;
		}

		const cursor = editor.getCursor();
		const originalLines = content.split("\n");
		const fixedLines = fixed.split("\n");
		const mapping = buildLineMapping(originalLines, fixedLines);
		const newLine = mapCursorLine(mapping, cursor.line, fixedLines.length);

		editor.replaceRange(
			fixed,
			{ line: 0, ch: 0 },
			{ line: originalLines.length, ch: 0 }
		);
		editor.setCursor({ line: newLine, ch: cursor.ch });

		const removedCount = originalLines.length - fixedLines.length;
		if (this.settings.showNotice) {
			new Notice(`Table Doctor: removed ${removedCount} blank line(s)`);
		}
		this.updateStatusBar("fixed", `${removedCount} lines removed`);
	}

	/**
	 * Dry-run: show diff preview modal without applying changes.
	 */
	private dryRunEditor(editor: Editor): void {
		const content = editor.getValue();
		const fixed = fixBrokenTables(content);

		if (fixed === null) {
			new Notice("Table Doctor: all tables OK, nothing to fix");
			return;
		}

		const originalLines = content.split("\n");
		const fixedLines = fixed.split("\n");
		const diff = computeDiff(originalLines, fixedLines);

		const activeFile = this.app.workspace.getActiveFile();
		const fileName = activeFile?.name || "current file";

		new DiffPreviewModal(this.app, diff, fileName, () => {
			this.fixEditor(editor);
		}).open();
	}

	/**
	 * Fix all files in vault. Batched processing with progress.
	 */
	private async fixAllFiles(): Promise<void> {
		const files = this.app.vault.getMarkdownFiles().filter(
			(f) => !this.isExcluded(f.path)
		);

		let fixedCount = 0;
		let errorCount = 0;
		const BATCH_SIZE = 20;

		this.updateStatusBar("fixing");

		for (let start = 0; start < files.length; start += BATCH_SIZE) {
			const batch = files.slice(start, start + BATCH_SIZE);

			await Promise.all(
				batch.map(async (file) => {
					try {
						const content = await this.app.vault.read(file);
						const fixed = fixBrokenTables(content);
						if (fixed !== null) {
							await this.app.vault.modify(file, fixed);
							fixedCount++;
						}
					} catch (e) {
						errorCount++;
						console.error(`Table Doctor: error processing ${file.path}:`, e);
					}
				})
			);

			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		let msg = fixedCount > 0
			? `Table Doctor: fixed ${fixedCount} file(s)`
			: "Table Doctor: all tables OK";
		if (errorCount > 0) {
			msg += ` (${errorCount} errors)`;
		}
		if (this.settings.showNotice) {
			new Notice(msg);
		}
		this.updateStatusBar("fixed", `${fixedCount} files`);
	}

	/**
	 * Fix on file modify (save). Per-file debounce + atomic vault.process().
	 */
	private registerModifyHandler() {
		this.registerEvent(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				if (!this.settings.fixOnSave) return;
				if (!(file instanceof TFile) || file.extension !== "md") return;
				if (this.isExcluded(file.path)) return;
				if (this.processingFiles.has(file.path)) return;

				const existingTimeout = this.modifyTimeouts.get(file.path);
				if (existingTimeout) {
					clearTimeout(existingTimeout);
				}

				const timeout = setTimeout(() => {
					void (async () => {
						this.modifyTimeouts.delete(file.path);
						if (this.processingFiles.has(file.path)) return;
						this.processingFiles.add(file.path);

						try {
							await this.app.vault.process(file, (content) => {
								try {
									const fixed = fixBrokenTables(content);
									if (fixed !== null) {
										if (this.settings.showNotice) {
											new Notice(`Table Doctor: fixed ${file.name}`);
										}
										this.updateStatusBar("fixed", file.name);
										return fixed;
									}
									return content;
								} catch (e) {
									console.error(`Table Doctor: fix failed for ${file.path}:`, e);
									return content;
								}
							});
						} catch (e) {
							console.error("Table Doctor:", e);
							this.updateStatusBar("error");
						} finally {
							setTimeout(() => {
								this.processingFiles.delete(file.path);
							}, 2000);
						}
					})();
				}, 500);

				this.modifyTimeouts.set(file.path, timeout);
			})
		);
	}

	/**
	 * Fix on paste. Intercepts clipboard, fixes broken tables before insertion.
	 */
	private registerPasteHandler() {
		this.registerEvent(
			this.app.workspace.on(
				"editor-paste",
				(evt: ClipboardEvent, editor: Editor) => {
					if (!this.settings.fixOnPaste) return;

					const clipboardText = evt.clipboardData?.getData("text/plain");
					if (!clipboardText) return;

					const fixed = fixBrokenTables(clipboardText);
					if (fixed !== null) {
						evt.preventDefault();
						editor.replaceSelection(fixed);
						if (this.settings.showNotice) {
							new Notice("Table Doctor: fixed pasted table");
						}
						this.updateStatusBar("fixed", "paste");
					}
				}
			)
		);
	}

	/**
	 * Fix on file open. Catches files from sync/git that were never processed.
	 */
	private registerFileOpenHandler() {
		this.registerEvent(
			this.app.workspace.on("file-open", (file: TFile | null) => {
				if (!this.settings.fixOnOpen) return;
				if (!file || file.extension !== "md") return;
				if (this.isExcluded(file.path)) return;
				if (this.processingFiles.has(file.path)) return;

				// Small delay to let the editor fully load
				setTimeout(() => {
					void (async () => {
						if (this.processingFiles.has(file.path)) return;
						this.processingFiles.add(file.path);

						try {
							await this.app.vault.process(file, (content) => {
								try {
									const fixed = fixBrokenTables(content);
									if (fixed !== null) {
										if (this.settings.showNotice) {
											new Notice(`Table Doctor: fixed ${file.name} on open`);
										}
										this.updateStatusBar("fixed", file.name);
										return fixed;
									}
									return content;
								} catch (e) {
									console.error(`Table Doctor: fix failed for ${file.path}:`, e);
									return content;
								}
							});
						} catch (e) {
							console.error("Table Doctor:", e);
						} finally {
							setTimeout(() => {
								this.processingFiles.delete(file.path);
							}, 2000);
						}
					})();
				}, 300);
			})
		);
	}

	/**
	 * Clean up stale entries in processingFiles and modifyTimeouts on rename/delete.
	 */
	private registerCleanupHandlers() {
		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				this.processingFiles.delete(oldPath);
				const timeout = this.modifyTimeouts.get(oldPath);
				if (timeout) {
					clearTimeout(timeout);
					this.modifyTimeouts.delete(oldPath);
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				this.processingFiles.delete(file.path);
				const timeout = this.modifyTimeouts.get(file.path);
				if (timeout) {
					clearTimeout(timeout);
					this.modifyTimeouts.delete(file.path);
				}
			})
		);
	}

	private isExcluded(filePath: string): boolean {
		if (this.excludedFoldersList.length === 0) return false;
		return this.excludedFoldersList.some((folder) => {
			const normalized = folder.replace(/^\/+|\/+$/g, "");
			return (
				filePath === normalized ||
				filePath.startsWith(normalized + "/")
			);
		});
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
		this.updateExcludedFolders();
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.updateExcludedFolders();

		if (!this.settings.fixOnSave) {
			for (const [, timeout] of this.modifyTimeouts) {
				clearTimeout(timeout);
			}
			this.modifyTimeouts.clear();
			this.processingFiles.clear();
		}
	}

	private updateExcludedFolders() {
		this.excludedFoldersList = this.settings.excludedFolders
			.split(",")
			.map((f) => f.trim())
			.filter((f) => f.length > 0);
	}

	onunload() {
		for (const [, timeout] of this.modifyTimeouts) {
			clearTimeout(timeout);
		}
		this.modifyTimeouts.clear();
	}
}

// ─── Settings Tab ────────────────────────────────────────────────────────────

class TableDoctorSettingTab extends PluginSettingTab {
	plugin: TableDoctorPlugin;

	constructor(app: App, plugin: TableDoctorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Table Doctor")
			.setDesc("Automatically removes blank lines between markdown table rows so tables render correctly.")
			.setHeading();

		new Setting(containerEl).setName("Triggers").setHeading();

		new Setting(containerEl)
			.setName("Fix on save")
			.setDesc("Automatically fix tables when a file is modified.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.fixOnSave)
					.onChange(async (value) => {
						this.plugin.settings.fixOnSave = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Fix on paste")
			.setDesc("Fix tables in pasted content before inserting.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.fixOnPaste)
					.onChange(async (value) => {
						this.plugin.settings.fixOnPaste = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Fix on file open")
			.setDesc("Fix tables when opening a file. Catches files from sync or git.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.fixOnOpen)
					.onChange(async (value) => {
						this.plugin.settings.fixOnOpen = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Behavior").setHeading();

		new Setting(containerEl)
			.setName("Show notices")
			.setDesc("Show a notification when tables are fixed.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showNotice)
					.onChange(async (value) => {
						this.plugin.settings.showNotice = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc(
				"Comma-separated folder paths to skip (e.g. Templates, Archive/old)."
			)
			.addText((text) =>
				text
					.setPlaceholder("Templates, Archive")
					.setValue(this.plugin.settings.excludedFolders)
					.onChange(async (value) => {
						this.plugin.settings.excludedFolders = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
