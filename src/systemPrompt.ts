import * as fs from 'fs';
import * as path from 'path';
import Logger from './logger';

export interface SystemPromptContext {
    alwaysMemory: string;
    onDemandNamespaces: string;
    storySummaries: string;
}

function formatDatetime(): string {
    const now = new Date();
    const days = [
        'dimanche',
        'lundi',
        'mardi',
        'mercredi',
        'jeudi',
        'vendredi',
        'samedi',
    ];
    const months = [
        'janvier',
        'février',
        'mars',
        'avril',
        'mai',
        'juin',
        'juillet',
        'août',
        'septembre',
        'octobre',
        'novembre',
        'décembre',
    ];
    const day = days[now.getDay()];
    const date = now.getDate();
    const month = months[now.getMonth()];
    const year = now.getFullYear();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    return `${day} ${date} ${month} ${year}, ${hours}h${minutes}`;
}

/**
 * Reads all .md files from the prompts/ directory in alphabetical order.
 * Re-reads on every call — no caching — so edits take effect immediately
 * without restarting the orchestrator.
 */
function loadPromptDocs(): string {
    const promptsDir = path.resolve(process.cwd(), 'prompts');

    if (!fs.existsSync(promptsDir)) {
        Logger.warn('prompts/ directory not found — using empty base prompt');
        return '';
    }

    const files = fs
        .readdirSync(promptsDir)
        .filter((f) => f.endsWith('.md'))
        .sort();

    if (files.length === 0) {
        Logger.warn('No .md files found in prompts/');
        return '';
    }

    const parts: string[] = [];
    for (const file of files) {
        try {
            const content = fs
                .readFileSync(path.join(promptsDir, file), 'utf-8')
                .trim();
            if (content) parts.push(content);
        } catch (err) {
            Logger.warn(`Could not read prompt file "${file}": ${err}`);
        }
    }

    Logger.debug(`Loaded ${files.length} prompt doc(s): ${files.join(', ')}`);
    return parts.join('\n\n---\n\n');
}

export function buildSystemPrompt(ctx: SystemPromptContext): string {
    const docs = loadPromptDocs();
    const datetime = formatDatetime();

    const sections: string[] = [];

    if (docs) sections.push(docs);

    sections.push(`## Contexte actuel\n\nNous sommes le ${datetime}.`);

    if (ctx.alwaysMemory || ctx.onDemandNamespaces) {
        let mem = '## Mémoire';
        if (ctx.alwaysMemory) {
            mem += '\n\n### Données permanentes\n\n' + ctx.alwaysMemory;
        }
        if (ctx.onDemandNamespaces) {
            mem +=
                '\n\n### Données disponibles sur demande\n\n' +
                'Appelle `memory_read(namespace)` pour accéder à :\n' +
                ctx.onDemandNamespaces;
        }
        sections.push(mem);
    }

    if (ctx.storySummaries) {
        sections.push(
            '## Discussions passées pertinentes\n\n' +
                "Si tu manques de contexte pour cette demande, ces discussions passées pourraient t'aider :\n\n" +
                ctx.storySummaries +
                '\n\nAppelle `get_story_detail(id)` pour lire le transcript complet.',
        );
    }

    return sections.join('\n\n---\n\n');
}
