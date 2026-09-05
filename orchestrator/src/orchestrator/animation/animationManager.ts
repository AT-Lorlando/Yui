// orchestrator/src/orchestrator/animation/animationManager.ts
import Logger from '../../logger';
import type { AnimationEffect, FloatingConfig, Keyframe } from './types';
import { expandIntro } from './effects';
import { sampleGradient } from './gradient';
import { stopNativeDynamic } from './dynamicScene';

export type CallTool = (
    tool: string,
    args: Record<string, unknown>,
) => Promise<unknown>;

const MAX_CMD_PER_SEC = 8;
const MIN_TICK_MS = 800;
// Cap on how long stopAll() waits for in-flight tick commands to settle, so a
// hung bridge request can never block the off/colour command that follows.
const DRAIN_TIMEOUT_MS = 1500;

/** Light-affecting tools whose invocation must cancel an active animation. */
const LIGHT_TOOLS = new Set([
    'set_lights',
    'set_lights_bulk',
    'set_room_palette',
    'set_color',
    'set_brightness',
    'turn_on_light',
    'turn_off_light',
    'turn_on_all_lights',
    'turn_off_all_lights',
    'house_off',
]);

export function shouldCancel(tool: string): boolean {
    if (LIGHT_TOOLS.has(tool)) return true;
    if (tool.startsWith('_lights_')) return true;
    if (tool === '_house_off') return true;
    return false;
}

/** Tick interval (ms) honouring the bridge command budget. */
export function computeTickInterval(
    lightCount: number,
    maxPerSec: number,
    minMs: number,
): number {
    const needed = Math.ceil((lightCount / maxPerSec) * 1000);
    return Math.max(minMs, needed);
}

/** Deterministic per-light speed jitter in [1-j, 1+j]. */
function jitterFactor(index: number, jitter: number): number {
    if (!jitter) return 1;
    const pseudo = Math.abs(Math.sin((index + 1) * 12.9898) * 43758.5453) % 1; // 0..1
    return 1 + jitter * (pseudo * 2 - 1);
}

/** Pure: colour (+ brightness) for each light at a given elapsed time. */
export function floatingFrameColors(
    cfg: FloatingConfig,
    lightNames: string[],
    elapsedMs: number,
): Record<string, { color: string; brightness?: number }> {
    const out: Record<string, { color: string; brightness?: number }> = {};
    const stagger = cfg.staggerSec ?? 0;
    lightNames.forEach((name, i) => {
        const override = cfg.perLight?.[name];
        const palette = override?.palette ?? cfg.palette;
        const speedSec =
            (override?.speedSec ?? cfg.speedSec) *
            jitterFactor(i, cfg.speedJitter ?? 0);
        const phaseSec = elapsedMs / 1000 + i * stagger;
        const t = (phaseSec / speedSec) % 1;
        out[name] = {
            color: sampleGradient(palette, t),
            brightness: cfg.brightness,
        };
    });
    return out;
}

interface ActiveFloating {
    kind: 'software' | 'native';
    /** Génération à laquelle la boucle appartient. */
    epoch: number;
    timer?: NodeJS.Timeout;
    nativeRid?: string;
    /** The latest tick's in-flight set_lights promises (fire-and-forget). */
    inflight?: Promise<unknown>[];
}

/**
 * Pilote les animations lumineuses (intro ponctuelle + boucle « couleurs
 * flottantes »).
 *
 * Tout ce qui écrit sur les lampes ici est différé (setInterval / setTimeout).
 * Le risque, c'est qu'une écriture survive à l'arrêt : elle rallume alors ce
 * que l'utilisateur vient d'éteindre, et comme plus rien ne référence son
 * timer, seule une relance du processus y met fin. Deux garanties couvrent ça :
 *
 * 1. **Génération (`epoch`)** — incrémentée à chaque démarrage ou arrêt. Chaque
 *    écriture différée capture la sienne et ne fait rien si elle a changé. Un
 *    timer qui aurait échappé au ménage n'écrit donc rien, et se désarme à son
 *    premier réveil.
 * 2. **Sérialisation** — démarrages et arrêts passent par une file. Sans elle,
 *    deux scènes déclenchées coup sur coup posaient chacune leur boucle
 *    pendant que l'autre attendait `list_lights`, et `this.floating` n'en
 *    référençait qu'une : l'autre devenait orpheline.
 *
 * Les timers d'intro sont suivis explicitement, pour la même raison.
 */
class AnimationManager {
    private floating: ActiveFloating | null = null;
    private introTimers = new Set<NodeJS.Timeout>();
    /** Résolveurs des playIntro en cours — appelés pour les débloquer à l'arrêt. */
    private introWaiters = new Set<() => void>();
    private epoch = 0;
    private lifecycle: Promise<unknown> = Promise.resolve();

    /** File d'attente des opérations de cycle de vie (start/stop). */
    private serialize<T>(fn: () => Promise<T>): Promise<T> {
        const next = this.lifecycle.then(fn, fn);
        // La file ne doit jamais rester en échec, sinon tout se bloque derrière.
        this.lifecycle = next.then(
            () => undefined,
            () => undefined,
        );
        return next;
    }

    /**
     * Génération courante — un lancement de scène la capture après son
     * stopAll initial et la repasse à playIntro/startFloating : si elle a
     * bougé entre-temps (extinction, autre scène), l'animation d'une scène
     * périmée ne démarre jamais.
     */
    currentEpoch(): number {
        return this.epoch;
    }

    /**
     * Joue une intro. Se termine à la fin de la timeline, ou immédiatement si
     * un arrêt survient entre-temps (l'appelant enchaîne sur l'état de la
     * scène, il ne doit pas attendre une intro annulée). `token` : génération
     * capturée au lancement de la scène — si elle est révolue, rien ne joue.
     */
    async playIntro(
        effects: AnimationEffect[],
        callTool: CallTool,
        token?: number,
    ): Promise<void> {
        if (!effects?.length) return;
        if (token !== undefined && token !== this.epoch) {
            Logger.info('[animation] intro d’une scène périmée — ignorée');
            return;
        }
        const lights = (await callTool('list_lights', {})) as Array<{
            name: string;
            room?: string;
        }>;
        const resolve = (target: string): string[] => {
            const t = target.toLowerCase();
            const byRoom = lights
                .filter((l) => (l.room ?? '').toLowerCase() === t)
                .map((l) => l.name);
            if (byRoom.length) return byRoom;
            const one = lights.find((l) => l.name.toLowerCase() === t);
            return one ? [one.name] : [];
        };
        const { frames, totalMs } = expandIntro(effects, resolve);
        const epoch = this.epoch;

        await new Promise<void>((done) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                this.introWaiters.delete(finish);
                done();
            };
            this.introWaiters.add(finish);

            for (const f of frames) {
                const timer = setTimeout(() => {
                    this.introTimers.delete(timer);
                    if (epoch !== this.epoch) return;
                    this.applyFrame(f, callTool);
                }, f.atMs);
                this.introTimers.add(timer);
            }
            const end = setTimeout(() => {
                this.introTimers.delete(end);
                finish();
            }, totalMs);
            this.introTimers.add(end);
        });
    }

    private applyFrame(f: Keyframe, callTool: CallTool): void {
        const args: Record<string, unknown> = {
            target: f.lightName,
            on: true,
            transitionMs: f.transitionMs,
        };
        if (f.color !== undefined) args.color = f.color;
        if (f.brightness !== undefined) args.brightness = f.brightness;
        void callTool('set_lights', args).catch(() => {});
    }

    /**
     * Start a floating loop (cancels any previous). Software engine only here.
     * `token` : génération capturée au lancement de la scène — une scène dont
     * l'exécution a été doublée (extinction, autre scène) ne démarre pas sa
     * boucle. C'était LE bug « j'éteins et les couleurs reviennent » : le
     * startFloating différé en fin de scène rallumait tout.
     */
    async startFloating(
        cfg: FloatingConfig,
        callTool: CallTool,
        token?: number,
    ): Promise<void> {
        return this.serialize(() => {
            if (token !== undefined && token !== this.epoch) {
                Logger.info(
                    '[animation] boucle flottante d’une scène périmée — ignorée',
                );
                return Promise.resolve();
            }
            return this.startFloatingInner(cfg, callTool);
        });
    }

    private async startFloatingInner(
        cfg: FloatingConfig,
        callTool: CallTool,
    ): Promise<void> {
        await this.stopAllInner();

        if (cfg.engine === 'native') {
            Logger.warn(
                '[animation] native floating must be started with rids — software loop skipped',
            );
            return;
        }

        const lights = (await callTool('list_lights', {})) as Array<{
            name: string;
            room?: string;
        }>;
        const t = cfg.target.toLowerCase();
        const names = lights
            .filter(
                (l) =>
                    (l.room ?? '').toLowerCase() === t ||
                    l.name.toLowerCase() === t,
            )
            .map((l) => l.name);
        if (!names.length) {
            Logger.warn(
                `[animation] floating target "${cfg.target}" matched no lights`,
            );
            return;
        }

        const tick = computeTickInterval(
            names.length,
            MAX_CMD_PER_SEC,
            MIN_TICK_MS,
        );
        const startedAt = Date.now();
        const epoch = this.epoch;
        // Register the loop before the first tick so its commands are tracked
        // as in-flight and can be drained by stopAll().
        const loop: ActiveFloating = { kind: 'software', epoch };
        this.floating = loop;
        const runTick = () => {
            // Boucle d'une génération révolue : elle n'écrit plus et se désarme.
            if (epoch !== this.epoch) {
                if (loop.timer) clearInterval(loop.timer);
                return;
            }
            const colors = floatingFrameColors(
                cfg,
                names,
                Date.now() - startedAt,
            );
            // Écritures SÉQUENTIELLES, époque revérifiée entre chaque : sur un
            // vrai bridge, un tick de N lampes en parallèle mettait plusieurs
            // secondes à retomber — plus que le plafond de drain — et les
            // retardataires rallumaient la pièce APRÈS l'ordre d'extinction
            // (constaté en live le 05/09, 9 lampes sur 11). En séquentiel, un
            // arrêt n'a au pire qu'UNE écriture en vol, et le reste du tick
            // est abandonné sur-le-champ.
            const chain = (async () => {
                for (const [name, c] of Object.entries(colors)) {
                    if (epoch !== this.epoch) return;
                    await callTool('set_lights', {
                        target: name,
                        on: true,
                        color: c.color,
                        ...(c.brightness !== undefined
                            ? { brightness: c.brightness }
                            : {}),
                        transitionMs: tick,
                    }).catch(() => {});
                }
            })();
            loop.inflight = [chain];
        };
        runTick();
        loop.timer = setInterval(runTick, tick);
        Logger.info(
            `[animation] floating started on ${names.length} light(s), tick ${tick}ms`,
        );
    }

    /** Cancel any running animation iff the incoming tool affects lights. */
    async cancelIfAffected(tool: string): Promise<void> {
        if (!shouldCancel(tool)) return;
        // Même sans animation active, la génération avance : une scène en
        // cours d'exécution (dont la flottante n'a pas encore démarré) voit
        // son jeton périmé et n'allumera rien après cette commande.
        if (!this.floating && this.introTimers.size === 0) {
            this.epoch++;
            return;
        }
        await this.stopAll();
    }

    async stopAll(): Promise<void> {
        return this.serialize(() => this.stopAllInner());
    }

    private async stopAllInner(): Promise<void> {
        const hadIntro = this.introTimers.size > 0;
        const f = this.floating;
        // Invalide tout ce qui est déjà programmé, y compris ce qu'on n'aurait
        // pas réussi à référencer.
        this.epoch++;
        this.floating = null;

        for (const timer of this.introTimers) clearTimeout(timer);
        this.introTimers.clear();
        for (const waiter of [...this.introWaiters]) waiter();

        if (f?.timer) clearInterval(f.timer);
        // Drain the last tick's in-flight commands so a following off/colour
        // command reaches the bridge last — otherwise late-arriving "on" frames
        // re-light the room. Capped so a hung request can't block the caller.
        if (f?.inflight?.length) {
            await Promise.race([
                Promise.allSettled(f.inflight),
                new Promise((r) => {
                    const t = setTimeout(r, DRAIN_TIMEOUT_MS);
                    t.unref?.();
                }),
            ]);
        }
        if (f?.kind === 'native' && f.nativeRid) {
            const host = process.env.HUE_BRIDGE_IP;
            const key = process.env.HUE_USERNAME;
            if (host && key) await stopNativeDynamic(host, key, f.nativeRid);
        }
        if (f || hadIntro) Logger.info('[animation] animations stopped');
    }

    isFloating(): boolean {
        return this.floating !== null;
    }

    /** Une intro est-elle en cours ? (diagnostic / tests) */
    isIntroPlaying(): boolean {
        return this.introTimers.size > 0;
    }
}

/** Process-wide singleton. */
export const animationManager = new AnimationManager();
