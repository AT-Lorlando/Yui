// Compteur glissant par source — la barrière anti-flood déterministe du bus
// (spec §5.3.4) : au-delà de `maxPerHour`, un événement est retenu sans
// jamais consulter le LLM. En mémoire : un redémarrage remet à zéro, c'est
// acceptable (le budget du juge reste le dernier rempart).
export class RateWindow {
    private hits = new Map<string, number[]>();

    constructor(private windowMs = 3600_000) {}

    private prune(source: string, now: number): number[] {
        const list = (this.hits.get(source) ?? []).filter(
            (t) => now - t <= this.windowMs,
        );
        this.hits.set(source, list);
        return list;
    }

    count(source: string, now: number): number {
        return this.prune(source, now).length;
    }

    /** Enregistre un passage et renvoie le compte dans la fenêtre (lui compris). */
    hit(source: string, now: number): number {
        const list = this.prune(source, now);
        list.push(now);
        return list.length;
    }
}
