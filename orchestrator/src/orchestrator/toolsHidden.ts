export interface ToolEntry {
    serverName: string;
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

export function annotateHidden<T extends ToolEntry>(
    tools: T[],
    hidden: Set<string>,
): (T & { hidden: boolean })[] {
    return tools.map((t) => ({ ...t, hidden: hidden.has(t.name) }));
}
