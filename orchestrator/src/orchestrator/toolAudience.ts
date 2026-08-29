/**
 * Visibilité des tools par audience.
 *
 * Chaque tool MCP peut déclarer `x-audience` dans son inputSchema — dans le
 * package qui le possède, comme les enums (`x-widget`, `x-unit`…). C'est la
 * seule source de vérité : ni liste côté orchestrateur, ni liste côté app.
 *
 *   'llm'    → proposé au LLM dans sa liste de tools
 *   'app'    → proposé dans le picker d'actions de l'app (scènes, bindings)
 *   'system' → ni l'un ni l'autre ; appelable uniquement en direct
 *              (REST /devices, scènes existantes, orchestrateur)
 *
 * Absent = ['llm', 'app'] : un tool ordinaire est visible partout.
 * L'audience ne restreint jamais l'APPEL — uniquement l'affichage.
 */

export type ToolAudience = 'llm' | 'app' | 'system';

const DEFAULT_AUDIENCE: ToolAudience[] = ['llm', 'app'];

export function toolAudience(
    inputSchema: Record<string, unknown> | undefined,
): ToolAudience[] {
    const raw = inputSchema?.['x-audience'];
    if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_AUDIENCE;
    return raw as ToolAudience[];
}

export function isLlmVisible(
    inputSchema: Record<string, unknown> | undefined,
): boolean {
    return toolAudience(inputSchema).includes('llm');
}
