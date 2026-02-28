import * as fs from 'fs';
import * as path from 'path';
import Logger from './logger';

/** Directories never included in tree or search */
const SKIP_DIRS = new Set(['.obsidian', '.git', '.trash', 'assets', '.DS_Store']);
/** File extensions treated as notes */
const NOTE_EXT = '.md';

export class ObsidianClient {
    private root: string;

    constructor(vaultRoot: string) {
        this.root = path.resolve(vaultRoot);
        if (!fs.existsSync(this.root)) {
            throw new Error(`Obsidian vault root not found: ${this.root}`);
        }
        Logger.info(`mcp-obsidian: vault root = ${this.root}`);
    }

    // ── Path helpers ──────────────────────────────────────────────────────────

    /** Resolve a user-supplied relative path, refusing traversal outside root. */
    private resolve(rel: string): string {
        const abs = path.resolve(this.root, rel);
        if (!abs.startsWith(this.root + path.sep) && abs !== this.root) {
            throw new Error(`Path escapes vault root: ${rel}`);
        }
        return abs;
    }

    /** Convert absolute path back to vault-relative display path. */
    private rel(abs: string): string {
        return path.relative(this.root, abs);
    }

    // ── Vault list ────────────────────────────────────────────────────────────

    /** List top-level vaults (subdirectories of root). */
    listVaults(): string {
        const entries = fs.readdirSync(this.root, { withFileTypes: true });
        const vaults = entries
            .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
            .map((e) => e.name);

        if (vaults.length === 0) return 'No vaults found.';
        const lines = ['Available vaults:', ...vaults.map((v) => `  • ${v}`)];
        return lines.join('\n');
    }

    // ── Tree ──────────────────────────────────────────────────────────────────

    /** Return an indented tree of notes and folders under `folderPath`. */
    getTree(folderPath = ''): string {
        const abs = folderPath ? this.resolve(folderPath) : this.root;
        if (!fs.existsSync(abs)) throw new Error(`Path not found: ${folderPath || '/'}`);
        const stat = fs.statSync(abs);
        if (!stat.isDirectory()) throw new Error(`Not a directory: ${folderPath}`);

        const label = folderPath || '/';
        const lines: string[] = [`[dir] ${label}`];
        this._treeLines(abs, '', lines);
        return lines.join('\n');
    }

    private _treeLines(dir: string, indent: string, lines: string[]): void {
        const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => {
            // Folders first, then files
            if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        const visible = entries.filter((e) => !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'));
        visible.forEach((e, i) => {
            const isLast = i === visible.length - 1;
            const branch = isLast ? '└── ' : '├── ';
            const icon = e.isDirectory() ? '[dir] ' : '[file] ';
            lines.push(`${indent}${branch}${icon}${e.name}`);
            if (e.isDirectory()) {
                this._treeLines(
                    path.join(dir, e.name),
                    indent + (isLast ? '    ' : '│   '),
                    lines,
                );
            }
        });
    }

    // ── Read ──────────────────────────────────────────────────────────────────

    /** Read a note's markdown content. */
    readNote(notePath: string): string {
        const abs = this.resolve(notePath);
        if (!fs.existsSync(abs)) throw new Error(`Note not found: ${notePath}`);
        const content = fs.readFileSync(abs, 'utf-8');
        const stat = fs.statSync(abs);
        const modified = stat.mtime.toLocaleDateString('fr-FR', {
            day: 'numeric', month: 'long', year: 'numeric',
        });
        return [
            `Note: ${path.basename(notePath)}`,
            `Dossier: ${this.rel(path.dirname(abs))}`,
            `Modifié: ${modified}`,
            '',
            content,
        ].join('\n');
    }

    // ── Create ────────────────────────────────────────────────────────────────

    /** Create a new note. Fails if it already exists unless overwrite=true. */
    createNote(notePath: string, content = '', overwrite = false): string {
        const abs = this.resolve(notePath);
        if (fs.existsSync(abs) && !overwrite) {
            throw new Error(`Note already exists: ${notePath}. Use update_note to modify it.`);
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf-8');
        Logger.info(`Created note: ${notePath}`);
        return `Note created: ${notePath}`;
    }

    /** Create a folder (and any parents). */
    createFolder(folderPath: string): string {
        const abs = this.resolve(folderPath);
        if (fs.existsSync(abs)) {
            return `Folder already exists: ${folderPath}`;
        }
        fs.mkdirSync(abs, { recursive: true });
        Logger.info(`Created folder: ${folderPath}`);
        return `Folder created: ${folderPath}`;
    }

    // ── Update ────────────────────────────────────────────────────────────────

    /** Overwrite a note's full content. */
    updateNote(notePath: string, content: string): string {
        const abs = this.resolve(notePath);
        if (!fs.existsSync(abs)) throw new Error(`Note not found: ${notePath}`);
        fs.writeFileSync(abs, content, 'utf-8');
        Logger.info(`Updated note: ${notePath}`);
        return `Note updated: ${notePath}`;
    }

    /** Append text to an existing note. */
    appendToNote(notePath: string, text: string): string {
        const abs = this.resolve(notePath);
        if (!fs.existsSync(abs)) throw new Error(`Note not found: ${notePath}`);
        const current = fs.readFileSync(abs, 'utf-8');
        const separator = current.endsWith('\n') ? '' : '\n';
        fs.writeFileSync(abs, current + separator + text, 'utf-8');
        Logger.info(`Appended to note: ${notePath}`);
        return `Text appended to: ${notePath}`;
    }

    // ── Move / rename ─────────────────────────────────────────────────────────

    /** Move or rename a note or folder. */
    move(fromPath: string, toPath: string): string {
        const absFrom = this.resolve(fromPath);
        const absTo = this.resolve(toPath);
        if (!fs.existsSync(absFrom)) throw new Error(`Source not found: ${fromPath}`);
        if (fs.existsSync(absTo)) throw new Error(`Destination already exists: ${toPath}`);
        fs.mkdirSync(path.dirname(absTo), { recursive: true });
        fs.renameSync(absFrom, absTo);
        Logger.info(`Moved ${fromPath} → ${toPath}`);
        return `Moved: ${fromPath} → ${toPath}`;
    }

    // ── Delete ────────────────────────────────────────────────────────────────

    /** Delete a note. */
    deleteNote(notePath: string): string {
        const abs = this.resolve(notePath);
        if (!fs.existsSync(abs)) throw new Error(`Note not found: ${notePath}`);
        const stat = fs.statSync(abs);
        if (stat.isDirectory()) throw new Error(`Use delete_folder to delete a directory: ${notePath}`);
        fs.unlinkSync(abs);
        Logger.info(`Deleted note: ${notePath}`);
        return `Note deleted: ${notePath}`;
    }

    // ── Search ────────────────────────────────────────────────────────────────

    /** Search notes by title keyword and/or content keyword. */
    searchNotes(options: {
        query: string;
        vault?: string;
        searchContent?: boolean;
        limit?: number;
    }): string {
        const { query, vault, searchContent = true, limit = 20 } = options;
        const searchRoot = vault ? this.resolve(vault) : this.root;
        if (!fs.existsSync(searchRoot)) throw new Error(`Vault not found: ${vault}`);

        const queryLower = query.toLowerCase();
        const results: Array<{ path: string; matchType: string; excerpt?: string }> = [];

        this._walkNotes(searchRoot, (absPath) => {
            if (results.length >= limit) return;
            const rel = this.rel(absPath);
            const name = path.basename(absPath, NOTE_EXT).toLowerCase();

            if (name.includes(queryLower)) {
                results.push({ path: rel, matchType: 'title' });
                return;
            }

            if (searchContent) {
                const content = fs.readFileSync(absPath, 'utf-8');
                const idx = content.toLowerCase().indexOf(queryLower);
                if (idx !== -1) {
                    const start = Math.max(0, idx - 60);
                    const end = Math.min(content.length, idx + query.length + 60);
                    const excerpt = content.slice(start, end).replace(/\n/g, ' ').trim();
                    results.push({ path: rel, matchType: 'content', excerpt: `…${excerpt}…` });
                }
            }
        });

        if (results.length === 0) return `No results for "${query}"${vault ? ` in ${vault}` : ''}.`;

        const lines = [
            `${results.length} result${results.length === 1 ? '' : 's'} for "${query}"${vault ? ` in ${vault}` : ''}:`,
        ];
        for (const r of results) {
            lines.push(`\n${r.path}  [${r.matchType}]`);
            if (r.excerpt) lines.push(`   ${r.excerpt}`);
        }
        return lines.join('\n');
    }

    private _walkNotes(dir: string, cb: (absPath: string) => void): void {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
            if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) {
                this._walkNotes(abs, cb);
            } else if (e.name.endsWith(NOTE_EXT)) {
                cb(abs);
            }
        }
    }
}
