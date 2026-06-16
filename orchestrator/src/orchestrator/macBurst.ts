import Logger from '../logger';

export type BurstDecision = 'join' | 'continue' | 'stop';

/** Décision pure d'un tick de burst. `present`: true=vu, false=absent, null=routeur KO. */
export function burstStep(
    present: boolean | null,
    elapsedMs: number,
    windowMs: number,
): BurstDecision {
    if (present === true) return 'join';
    if (elapsedMs >= windowMs) return 'stop';
    return 'continue';
}

export interface MacBurstDeps {
    intervalMs: number;
    windowMs: number;
    /** true=MAC vu, false=absent, null=routeur injoignable */
    poll: () => Promise<boolean | null>;
    onJoin: () => void;
    now?: () => number;
}

export interface MacBurst {
    start(): void;
    cancel(): void;
    readonly active: boolean;
}

/** Loop de burst : poll toutes intervalMs, join au 1er hit, stop à windowMs. */
export function createMacBurst(deps: MacBurstDeps): MacBurst {
    const now = deps.now ?? Date.now;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let startedAt = 0;
    let running = false;

    function stop(): void {
        running = false;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    }

    async function tick(): Promise<void> {
        if (!running) return;
        let present: boolean | null = null;
        try {
            present = await deps.poll();
        } catch {
            present = null;
        }
        if (!running) return;
        const decision = burstStep(present, now() - startedAt, deps.windowMs);
        if (decision === 'join') {
            Logger.info('[presence] MAC burst → phone joined network');
            stop();
            deps.onJoin();
            return;
        }
        if (decision === 'stop') {
            Logger.info('[presence] MAC burst window elapsed, giving up');
            stop();
            return;
        }
        timer = setTimeout(() => void tick(), deps.intervalMs);
    }

    return {
        start(): void {
            if (running) this.cancel();
            running = true;
            startedAt = now();
            Logger.info(
                `[presence] MAC burst armed (interval=${deps.intervalMs}ms, window=${deps.windowMs}ms)`,
            );
            void tick();
        },
        cancel(): void {
            if (running) Logger.debug('[presence] MAC burst cancelled');
            stop();
        },
        get active(): boolean {
            return running;
        },
    };
}
