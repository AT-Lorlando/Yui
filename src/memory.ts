import * as fs from 'fs';
import * as path from 'path';
import Logger from './logger';

export type MemoryPriority = 'always' | 'on-demand';

export interface MemoryNamespace {
    _priority: MemoryPriority;
    [key: string]: string;
}

export interface MemoryStore {
    [namespace: string]: MemoryNamespace;
}

const MEMORY_FILE = path.resolve(process.cwd(), 'data/memory.json');

function ensureDataDir(): void {
    const dir = path.dirname(MEMORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function loadStore(): MemoryStore {
    try {
        if (!fs.existsSync(MEMORY_FILE)) return {};
        return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8')) as MemoryStore;
    } catch {
        Logger.warn('Could not read memory.json — starting fresh');
        return {};
    }
}

function saveStore(store: MemoryStore): void {
    ensureDataDir();
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(store, null, 2));
}

export function saveMemory(
    namespace: string,
    key: string,
    value: string,
    priority: MemoryPriority = 'always',
): void {
    const store = loadStore();
    if (!store[namespace]) {
        store[namespace] = { _priority: priority };
    }
    store[namespace][key] = value;
    saveStore(store);
    Logger.debug(`Memory saved: [${namespace}] ${key} = ${value}`);
}

export function deleteMemory(namespace: string, key: string): void {
    const store = loadStore();
    if (!store[namespace]?.[key]) return;
    delete store[namespace][key];
    // Drop empty namespace
    if (
        Object.keys(store[namespace]).filter((k) => k !== '_priority')
            .length === 0
    ) {
        delete store[namespace];
    }
    saveStore(store);
}

export function readNamespace(namespace: string): string {
    const store = loadStore();
    const ns = store[namespace];
    if (!ns) return `Namespace "${namespace}" introuvable.`;
    const entries = Object.entries(ns)
        .filter(([k]) => k !== '_priority')
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
    return entries || '(namespace vide)';
}

export function listNamespaces(): string {
    const store = loadStore();
    const entries = Object.entries(store).map(([ns, data]) => {
        const count = Object.keys(data).filter((k) => k !== '_priority').length;
        return `- ${ns} [${data._priority}] : ${count} entrée${
            count > 1 ? 's' : ''
        }`;
    });
    return entries.length > 0
        ? entries.join('\n')
        : '(aucune mémoire enregistrée)';
}

export interface MemoryPromptContext {
    alwaysMemory: string;
    onDemandNamespaces: string;
}

/**
 * Builds the two-tier memory context for the system prompt:
 * - always: full content injected directly
 * - on-demand: only namespace names listed, fetched via memory_read tool
 */
export function buildMemoryContext(): MemoryPromptContext {
    const store = loadStore();
    const alwaysParts: string[] = [];
    const onDemandParts: string[] = [];

    for (const [ns, data] of Object.entries(store)) {
        const entries = Object.entries(data)
            .filter(([k]) => k !== '_priority')
            .map(([k, v]) => `  ${k}: ${v}`)
            .join('\n');

        if (!entries) continue;

        if (data._priority === 'always') {
            alwaysParts.push(`[${ns}]\n${entries}`);
        } else {
            const count = Object.keys(data).filter(
                (k) => k !== '_priority',
            ).length;
            onDemandParts.push(
                `- ${ns} (${count} entrée${count > 1 ? 's' : ''})`,
            );
        }
    }

    return {
        alwaysMemory: alwaysParts.join('\n\n'),
        onDemandNamespaces: onDemandParts.join('\n'),
    };
}
