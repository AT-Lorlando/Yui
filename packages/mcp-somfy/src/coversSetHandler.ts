export interface CoversSetDeps {
    listCovers: () => { url: string; name: string }[];
    exec: (
        url: string,
        cmd: string,
        params: unknown[],
        label?: string,
    ) => Promise<unknown>;
}

export function buildCoversSetTool(coverNames: string[]) {
    return {
        name: 'covers_set',
        description:
            "Positionne un volet ou tous les volets (0 = ouvert, 100 = fermé). Caché du LLM — pour l'éditeur.",
        inputSchema: {
            type: 'object' as const,
            properties: {
                target: {
                    type: 'string',
                    enum: ['all', ...coverNames],
                    description: 'Cible : "all" ou un volet.',
                },
                position: {
                    type: 'number',
                    minimum: 0,
                    maximum: 100,
                    description: '0 = ouvert, 100 = fermé.',
                },
            },
            required: ['target', 'position'],
        },
    };
}

export async function handleCoversSet(
    args: Record<string, unknown>,
    deps: CoversSetDeps,
): Promise<string> {
    const target = String(args.target);
    const position = Math.round(Number(args.position));
    const covers = deps.listCovers();
    const selected =
        target === 'all'
            ? covers
            : covers.filter(
                  (c) => c.name.toLowerCase() === target.toLowerCase(),
              );
    for (const c of selected) {
        await deps.exec(
            c.url,
            'setClosure',
            [position],
            `${c.name} → ${position}%`,
        );
    }
    return `${selected.length} volet(s) → ${position}%.`;
}
