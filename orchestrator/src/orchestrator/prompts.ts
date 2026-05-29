import * as fs from 'fs';
import * as path from 'path';

const PROMPTS_ROOT = path.resolve(process.cwd(), 'prompts');

export interface PromptFile {
    file: string;    // relative path within prompts/, e.g. "00-personality.md" or "sub/01-x.md"
    name: string;    // human label
    content: string;
}

export function listPrompts(): PromptFile[] {
    const result: PromptFile[] = [];
    const readDir = (dir: string, prefix = ''): void => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir)) {
            const fullPath = path.join(dir, entry);
            if (fs.statSync(fullPath).isDirectory()) {
                readDir(fullPath, `${prefix}${entry}/`);
            } else if (entry.endsWith('.md')) {
                result.push({
                    file: `${prefix}${entry}`,
                    name: entry.replace(/^\d+-/, '').replace('.md', '').replace(/-/g, ' '),
                    content: fs.readFileSync(fullPath, 'utf-8'),
                });
            }
        }
    };
    readDir(PROMPTS_ROOT);
    return result;
}

/**
 * Resolves a caller-supplied relative path against prompts/ and verifies the
 * result stays inside prompts/ and ends in .md. Throws on any violation.
 */
export function resolvePromptPath(file: string): string {
    if (!file.endsWith('.md')) {
        throw new Error('Only .md files are allowed');
    }
    const resolved = path.resolve(PROMPTS_ROOT, file);
    const rel = path.relative(PROMPTS_ROOT, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error('Path escapes prompts/ directory');
    }
    return resolved;
}

export function writePrompt(file: string, content: string): void {
    const resolved = resolvePromptPath(file);
    if (!fs.existsSync(resolved)) {
        throw new Error('Prompt file does not exist');
    }
    fs.writeFileSync(resolved, content, 'utf-8');
}
