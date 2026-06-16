import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';

const PROMPTS_ROOT = path.resolve(process.cwd(), 'prompts');
const MANIFEST = dataPath('prompts.json');

export interface PromptFile {
    file: string; // relative path within prompts/, e.g. "00-personality.md" or "domains/domotique.md"
    name: string; // human label
    content: string;
}

/**
 * One entry of data/prompts.json — the app-editable manifest that drives which
 * prompt files load, in what order, and whether each is enabled. The filesystem
 * holds the .md content; the manifest holds the policy. See the design spec
 * 2026-06-15-app-editable-config-design (prompts addendum).
 */
export interface PromptEntry {
    file: string; // relative to prompts/
    layer: 'core' | 'domain';
    domain?: string; // group name, for layer === 'domain'
    enabled: boolean;
    order: number;
}

// ── Filesystem listing ───────────────────────────────────────────────────────

/** All .md files under prompts/, as paths relative to prompts/. */
export function listPromptFiles(): string[] {
    const result: string[] = [];
    const walk = (dir: string, prefix = ''): void => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir)) {
            const full = path.join(dir, entry);
            if (fs.statSync(full).isDirectory())
                walk(full, `${prefix}${entry}/`);
            else if (entry.endsWith('.md')) result.push(`${prefix}${entry}`);
        }
    };
    walk(PROMPTS_ROOT);
    return result;
}

export function listPrompts(): PromptFile[] {
    return listPromptFiles().map((file) => ({
        file,
        name: path
            .basename(file)
            .replace(/^\d+-/, '')
            .replace('.md', '')
            .replace(/-/g, ' '),
        content: fs.readFileSync(path.join(PROMPTS_ROOT, file), 'utf-8'),
    }));
}

// ── Pure manifest logic ────────────────────────────────────────────────────────

function entryForNewFile(file: string, maxOrder: number): PromptEntry {
    if (file.startsWith('domains/')) {
        return {
            file,
            layer: 'domain',
            domain: path.basename(file, '.md'),
            enabled: true,
            order: 0,
        };
    }
    return { file, layer: 'core', enabled: true, order: maxOrder + 1 };
}

/**
 * Reconcile a manifest against the files actually present: preserve existing
 * entries (their enabled/order/domain), drop entries whose file is gone, and
 * append newly-found files (core enabled by default). Pure.
 */
export function reconcileManifest(
    entries: PromptEntry[],
    files: string[],
): PromptEntry[] {
    const present = new Set(files);
    const kept = entries.filter((e) => present.has(e.file));
    const known = new Set(kept.map((e) => e.file));

    let maxOrder = kept
        .filter((e) => e.layer === 'core')
        .reduce((m, e) => Math.max(m, e.order), -1);

    const out = [...kept];
    for (const file of files) {
        if (known.has(file)) continue;
        const entry = entryForNewFile(file, maxOrder);
        if (entry.layer === 'core') maxOrder = entry.order;
        out.push(entry);
    }
    return out;
}

/** Enabled core files, in manifest order. Pure. */
export function resolveCoreFiles(entries: PromptEntry[]): string[] {
    return entries
        .filter((e) => e.layer === 'core' && e.enabled)
        .sort((a, b) => a.order - b.order)
        .map((e) => e.file);
}

/** Enabled domain file matching a group name, or null. Pure. */
export function resolveDomainFile(
    entries: PromptEntry[],
    domain: string,
): string | null {
    const hit = entries.find(
        (e) => e.layer === 'domain' && e.enabled && e.domain === domain,
    );
    return hit ? hit.file : null;
}

// ── Manifest IO (seeds + reconciles on every load) ──────────────────────────────

export function loadManifest(): PromptEntry[] {
    let stored: PromptEntry[] = [];
    if (fs.existsSync(MANIFEST)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));
            if (Array.isArray(parsed)) stored = parsed;
        } catch {
            stored = [];
        }
    }
    const reconciled = reconcileManifest(stored, listPromptFiles());
    // Persist if the reconciliation changed anything (new files, removed orphans).
    if (JSON.stringify(reconciled) !== JSON.stringify(stored)) {
        saveManifest(reconciled);
    }
    return reconciled;
}

export function saveManifest(entries: PromptEntry[]): void {
    fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
    fs.writeFileSync(MANIFEST, JSON.stringify(entries, null, 2));
}

// ── Path safety + CRUD ──────────────────────────────────────────────────────────

/**
 * Resolves a caller-supplied relative path against prompts/ and verifies the
 * result stays inside prompts/ and ends in .md. Throws on any violation.
 */
export function resolvePromptPath(file: string): string {
    if (!file.endsWith('.md')) throw new Error('Only .md files are allowed');
    const resolved = path.resolve(PROMPTS_ROOT, file);
    const rel = path.relative(PROMPTS_ROOT, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error('Path escapes prompts/ directory');
    }
    return resolved;
}

/** Overwrite an existing prompt file's content. */
export function writePrompt(file: string, content: string): void {
    const resolved = resolvePromptPath(file);
    if (!fs.existsSync(resolved)) throw new Error('Prompt file does not exist');
    fs.writeFileSync(resolved, content, 'utf-8');
}

/**
 * Create a new prompt file + register it in the manifest. `layer`/`domain`
 * default from the path (domains/ → domain). Throws if it already exists.
 */
export function createPrompt(
    file: string,
    content: string,
    opts?: { layer?: 'core' | 'domain'; domain?: string; enabled?: boolean },
): PromptEntry[] {
    const resolved = resolvePromptPath(file);
    if (fs.existsSync(resolved)) throw new Error('Prompt file already exists');
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, 'utf-8');

    const entries = loadManifest(); // reconcile picks up the new file with defaults
    const entry = entries.find((e) => e.file === file);
    if (entry && opts) {
        if (opts.layer) entry.layer = opts.layer;
        if (opts.domain !== undefined) entry.domain = opts.domain;
        if (opts.enabled !== undefined) entry.enabled = opts.enabled;
        saveManifest(entries);
    }
    return entries;
}

/** Delete a prompt file and its manifest entry. */
export function deletePrompt(file: string): PromptEntry[] {
    const resolved = resolvePromptPath(file);
    if (fs.existsSync(resolved)) fs.rmSync(resolved);
    const entries = loadManifest().filter((e) => e.file !== file);
    saveManifest(entries);
    return entries;
}

/** Apply a partial patch (enabled/order/domain/layer) to one manifest entry. */
export function updatePromptEntry(
    file: string,
    patch: Partial<Omit<PromptEntry, 'file'>>,
): PromptEntry[] {
    const entries = loadManifest();
    const entry = entries.find((e) => e.file === file);
    if (!entry) throw new Error(`No manifest entry for "${file}"`);
    Object.assign(entry, patch);
    saveManifest(entries);
    return entries;
}

/**
 * Fetch a prompt from a URL and save it as `file` (created or overwritten),
 * registering it in the manifest. `fetchImpl` is injectable for tests.
 */
export async function importPromptFromUrl(
    file: string,
    url: string,
    opts?: {
        layer?: 'core' | 'domain';
        domain?: string;
        enabled?: boolean;
        fetchImpl?: typeof fetch;
    },
): Promise<PromptEntry[]> {
    const resolved = resolvePromptPath(file);
    const doFetch = opts?.fetchImpl ?? fetch;
    const res = await doFetch(url);
    if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
    const content = await res.text();
    if (!content.trim()) throw new Error('Fetched content is empty');

    const existed = fs.existsSync(resolved);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, 'utf-8');

    const entries = loadManifest();
    const entry = entries.find((e) => e.file === file);
    if (entry && opts) {
        if (opts.layer) entry.layer = opts.layer;
        if (opts.domain !== undefined) entry.domain = opts.domain;
        // Imported heavy prompts default to disabled unless told otherwise, so
        // they don't silently inflate every request.
        entry.enabled = opts.enabled ?? (existed ? entry.enabled : false);
        saveManifest(entries);
    }
    return entries;
}
