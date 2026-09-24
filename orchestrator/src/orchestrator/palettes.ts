// Ambiances (palettes de couleurs d'une pièce) — `data/config/palettes.json`,
// config d'instance non versionnée. Créées/éditées depuis le tiroir de pièce
// de l'app, appliquées par `set_room_palette` (une teinte par lampe,
// distribution cyclique). Les six palettes historiques de l'app sont
// semées à la première lecture pour que rien ne disparaisse.
import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '@yui/shared';

export interface Palette {
    id: string;
    name: string;
    colors: string[];
    /** 1-100. */
    brightness: number;
    builtIn?: boolean;
}

export const DEFAULT_PALETTES: Palette[] = [
    {
        id: 'chaleureux',
        name: 'Chaleureux',
        colors: ['#FF8C42', '#FFB347', '#FF6B35', '#FFA05C'],
        brightness: 55,
        builtIn: true,
    },
    {
        id: 'tokyo',
        name: 'Tokyo',
        colors: ['#FF2D95', '#00E5FF', '#7C4DFF', '#FF6EC7'],
        brightness: 45,
        builtIn: true,
    },
    {
        id: 'foret',
        name: 'Forêt',
        colors: ['#1DB954', '#0B6E4F', '#2E8B57', '#145A32'],
        brightness: 40,
        builtIn: true,
    },
    {
        id: 'ocean',
        name: 'Océan',
        colors: ['#0077BE', '#00C2D1', '#005F73', '#48CAE4'],
        brightness: 45,
        builtIn: true,
    },
    {
        id: 'sunset',
        name: 'Sunset',
        colors: ['#FF5E5B', '#FFB400', '#FF7847', '#D62246'],
        brightness: 50,
        builtIn: true,
    },
    {
        id: 'blanc-doux',
        name: 'Blanc doux',
        colors: ['#FFE4C4', '#FFF3E0'],
        brightness: 80,
        builtIn: true,
    },
];

const FILE = () => dataPath('palettes.json');
const HEX = /^#[0-9a-f]{6}$/i;
export const MAX_COLORS = 8;

export function slugify(name: string): string {
    return name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
}

/**
 * Valide et normalise une palette entrante. `existing` sert à garder le
 * flag builtIn d'une palette semée qu'on modifie et à éviter les collisions
 * d'id à la création. Pur, testé.
 */
export function normalizePalette(
    input: Partial<Palette>,
    existing: Palette[],
): Palette {
    const name = String(input.name ?? '').trim();
    if (!name) throw new Error('nom requis');
    const colors = (Array.isArray(input.colors) ? input.colors : [])
        .map((c) => String(c).trim())
        .filter(Boolean);
    if (!colors.length) throw new Error('au moins une couleur');
    if (colors.length > MAX_COLORS)
        throw new Error(`${MAX_COLORS} couleurs maximum`);
    for (const c of colors) {
        if (!HEX.test(c)) throw new Error(`couleur invalide : ${c}`);
    }
    const brightness = Math.round(Number(input.brightness ?? 50));
    if (!Number.isFinite(brightness) || brightness < 1 || brightness > 100) {
        throw new Error('luminosité entre 1 et 100');
    }
    let id = typeof input.id === 'string' ? input.id.trim() : '';
    const current = id ? existing.find((p) => p.id === id) : undefined;
    if (!id) {
        const base = slugify(name) || 'ambiance';
        id = base;
        for (let n = 2; existing.some((p) => p.id === id); n++)
            id = `${base}-${n}`;
    }
    return {
        id,
        name,
        colors: colors.map((c) => c.toUpperCase()),
        brightness,
        ...(current?.builtIn ? { builtIn: true } : {}),
    };
}

function readFile(): Palette[] | null {
    try {
        const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
        return Array.isArray(raw) ? raw : null;
    } catch {
        return null;
    }
}

function writeFile(list: Palette[]): void {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(list, null, 2));
}

export function listPalettes(): Palette[] {
    const stored = readFile();
    if (stored) return stored;
    writeFile(DEFAULT_PALETTES);
    return [...DEFAULT_PALETTES];
}

export function upsertPalette(input: Partial<Palette>): Palette {
    const list = listPalettes();
    const next = normalizePalette(input, list);
    const i = list.findIndex((p) => p.id === next.id);
    if (i >= 0) list[i] = next;
    else list.push(next);
    writeFile(list);
    return next;
}

export function deletePalette(id: string): boolean {
    const list = listPalettes();
    const kept = list.filter((p) => p.id !== id);
    if (kept.length === list.length) return false;
    writeFile(kept);
    return true;
}
