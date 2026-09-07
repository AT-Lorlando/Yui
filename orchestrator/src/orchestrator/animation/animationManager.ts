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
// Attente max de L'ÉCRITURE en vol au moment d'un arrêt (il n'y en a jamais
// plus d'une, cf. écritures séquentielles) : assez pour qu'une commande
// d'extinction qui suit atteigne le bridge en dernier, assez court pour être
// imperceptible. Un bridge accroché ne bloque jamais l'appelant.
const DRAIN_TIMEOUT_MS = Number(process.env.FLOATING_DRAIN_MS ?? 400);

// Durée de vie max d'une boucle flottante. Vécu (07/09) : l'ambiance de la
// scène Musique a tourné 4 h 36 sans que personne ne touche aux lumières —
// charge continue + logs noyés (21 Mo/jour) + l'agenda LLM du dashboard à la
// traîne. Passé ce plafond, la boucle s'éteint d'elle-même (les lampes
// gardent leur dernière couleur, rien ne s'éteint).
const FLOATING_MAX_MS = Number(process.env.FLOATING_MAX_MIN ?? 240) * 60_000;

// Marge d'auto-écho SSE : un événement `light` du bridge qui suit de moins
// que (transition du tick + cette marge) notre propre écriture sur la même
// lampe est présumé être son écho. Mesuré sur le vrai bridge (07/09) : un PUT
// avec transition de 1,4 s produit des événements à l'application (~300-900 ms)
// PUIS à la fin de la transition (~1,4-1,9 s) — la fenêtre doit couvrir les
// deux, sinon la boucle prend ses propres échos pour des changements externes
// et se tue. Conséquence assumée : un simple changement de couleur externe
// pendant la boucle n'est pas détectable au timing — les signaux fiables sont
// le off (on n'éteint jamais) et le grouped_light (on n'écrit jamais en
// groupe), qui couvrent interrupteurs, app Hue pièce et molette.
export const SELF_ECHO_MARGIN_MS = Number(
    process.env.FLOATING_SELF_ECHO_MS ?? 1500,
);

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

/** Outils lumière qui touchent TOUT l'appartement, sans notion de cible. */
const GLOBAL_LIGHT_TOOLS = new Set([
    'turn_on_all_lights',
    'turn_off_all_lights',
    'house_off',
    '_house_off',
    '_lights_all_on',
    '_lights_all_off',
    '_lights_all_brightness',
    '_lights_all_color',
    '_lights_palette',
]);

export function shouldCancel(tool: string): boolean {
    if (LIGHT_TOOLS.has(tool)) return true;
    if (tool.startsWith('_lights_')) return true;
    if (tool === '_house_off') return true;
    return false;
}

/** Ce que la boucle active sait de ses propres lampes. */
export interface LoopTargets {
    /** Cible configurée (nom de pièce ou de lampe). */
    target: string;
    /** Noms des lampes effectivement animées. */
    names: string[];
    /** Pièces couvertes par ces lampes. */
    rooms: string[];
    /** Ids des lampes (pour les outils adressés par lightId). */
    ids: Array<string | number>;
}

const norm = (v: unknown): string =>
    String(v ?? '')
        .trim()
        .toLowerCase();

/** La cible `raw` désigne-t-elle (au moins en partie) la boucle ? */
function matchesLoop(info: LoopTargets, raw: unknown): boolean {
    const t = norm(raw);
    // Cible absente ou globale → prudence : on considère que ça nous touche.
    if (!t || t === 'all' || t === 'appartement') return true;
    if (t === norm(info.target)) return true;
    return (
        info.names.some((n) => norm(n) === t) ||
        info.rooms.some((r) => norm(r) === t)
    );
}

/**
 * Une commande lumière explicite touche-t-elle les lampes de la boucle ?
 * Cœur de l'annulation CIBLÉE : allumer la cuisine ne tue plus une ambiance
 * dans la chambre, mais tout ce qui vise une lampe animée (ou dont la cible
 * est inconnue — prudence) l'arrête. Pur, testé.
 */
export function toolTouchesLoop(
    tool: string,
    args: Record<string, unknown> | undefined,
    info: LoopTargets,
): boolean {
    if (!shouldCancel(tool)) return false;
    if (GLOBAL_LIGHT_TOOLS.has(tool)) return true;
    const a = (args ?? {}) as Record<string, unknown>;
    switch (tool) {
        case 'set_lights':
        case '_lights_toggle':
            return matchesLoop(info, a.target);
        case 'set_room_palette':
            return matchesLoop(info, a.room);
        case 'set_lights_bulk': {
            if (a.othersOff) return true;
            const states = Array.isArray(a.states)
                ? (a.states as Array<{ target?: unknown }>)
                : null;
            if (!states) return true;
            return states.some((s) => matchesLoop(info, s?.target));
        }
        case 'set_color':
        case 'set_brightness':
        case 'turn_on_light':
        case 'turn_off_light': {
            const id = a.lightId;
            if (id === undefined || info.ids.length === 0) return true;
            return info.ids.some((known) => String(known) === String(id));
        }
        default:
            // Outil lumière qu'on ne sait pas cibler → prudence.
            return true;
    }
}

/** Événement lumière poussé par le bridge (flux SSE, via hueRemotes). */
export interface ExternalLightEvent {
    /** Nom de la lampe (events `light`). */
    name?: string;
    /** Nom de la pièce (events `grouped_light`). */
    room?: string;
    /** L'événement vient d'un grouped_light (contrôle de pièce). */
    grouped?: boolean;
    /** L'événement rapporte on:false. */
    off?: boolean;
}

export type ExternalVerdict =
    | 'stop-off' // extinction externe d'une lampe animée (on n'écrit jamais off)
    | 'stop-grouped' // contrôle de pièce (app Hue, autre app — on n'écrit jamais en groupe)
    | 'stop-external' // changement de lampe hors fenêtre d'écho → externe
    | 'ignore-own' // écho probable de notre propre écriture
    | 'ignore-unrelated'; // lampe/pièce hors boucle

/**
 * Verdict d'un événement SSE pendant qu'une boucle tourne. Pur, testé.
 * `lastWrite` : nom normalisé → timestamp de notre dernière écriture.
 */
export function externalEventVerdict(
    info: LoopTargets,
    lastWrite: Map<string, number>,
    evt: ExternalLightEvent,
    now: number,
    selfEchoMs: number = SELF_ECHO_MARGIN_MS,
): ExternalVerdict {
    if (evt.grouped) {
        // La boucle écrit lampe par lampe, jamais en groupe : un événement
        // grouped_light sur une de nos pièces est forcément externe.
        return evt.room && matchesLoop(info, evt.room)
            ? 'stop-grouped'
            : 'ignore-unrelated';
    }
    const name = norm(evt.name);
    if (!name || !info.names.some((n) => norm(n) === name)) {
        return 'ignore-unrelated';
    }
    // La boucle n'éteint jamais rien : un off est toujours externe.
    if (evt.off) return 'stop-off';
    const last = lastWrite.get(name);
    if (last !== undefined && now - last <= selfEchoMs) return 'ignore-own';
    return 'stop-external';
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
    /** Lampes/pièces de la boucle — base de l'annulation ciblée. */
    targets: LoopTargets;
    /** Nom normalisé → timestamp de notre dernière écriture (écho SSE). */
    lastWrite: Map<string, number>;
    /** L'UNIQUE écriture bridge en vol (écritures séquentielles). */
    currentWrite?: Promise<unknown>;
    /** Un tick est-il encore en train d'écrire ? (skip, pas de backlog) */
    busy: boolean;
    skipped: number;
    /** Fenêtre d'auto-écho SSE de CETTE boucle (transition du tick + marge). */
    echoMs: number;
}

/**
 * Pilote les animations lumineuses (intro ponctuelle + boucle « couleurs
 * flottantes »).
 *
 * Tout ce qui écrit sur les lampes ici est différé (setInterval / setTimeout).
 * Le risque, c'est qu'une écriture survive à l'arrêt : elle rallume alors ce
 * que l'utilisateur vient d'éteindre, et comme plus rien ne référence son
 * timer, seule une relance du processus y met fin. Garanties (chacune née
 * d'un bug réel — ne pas les retirer) :
 *
 * 1. **Génération (`epoch`)** — incrémentée à chaque démarrage ou arrêt. Chaque
 *    écriture différée capture la sienne et ne fait rien si elle a changé. Un
 *    timer qui aurait échappé au ménage n'écrit donc rien, et se désarme à son
 *    premier réveil.
 * 2. **Arrêt SYNCHRONE** (`interruptNow`) — l'annulation ne passe PAS par la
 *    file : époque bumpée et timers coupés dans le tour d'événement de
 *    l'appelant. Une extinction utilisateur n'attend jamais un `list_lights`
 *    de démarrage en cours — au pire elle draine l'unique écriture en vol
 *    (plafonné à DRAIN_TIMEOUT_MS).
 * 3. **Sérialisation des démarrages** — sans elle, deux scènes déclenchées
 *    coup sur coup posaient chacune leur boucle pendant que l'autre attendait
 *    `list_lights`, et `this.floating` n'en référençait qu'une : l'autre
 *    devenait orpheline. Les démarrages re-vérifient l'époque après chaque
 *    await : un arrêt survenu pendant `list_lights` avorte le démarrage.
 * 4. **Écritures séquentielles** — les lampes d'un tick sont écrites une par
 *    une, époque revérifiée entre chaque : en parallèle, un tick de 11 lampes
 *    sur le vrai bridge retombait APRÈS l'ordre d'extinction et rallumait la
 *    pièce (constaté live le 05/09, 9/11 lampes). Un arrêt n'a au pire
 *    qu'UNE écriture en vol. Si le bridge est lent au point qu'un tick n'a
 *    pas fini quand le suivant sonne, le suivant est SAUTÉ (pas de backlog).
 * 5. **Annulation ciblée** — une commande lumière n'arrête la boucle que si
 *    elle touche ses lampes (`toolTouchesLoop`) ; et les changements venus
 *    d'ailleurs (app Hue, interrupteur, molette) l'arrêtent aussi, via le
 *    flux SSE (`onLightEvent`) et le hook molette (`interruptIfRoomTouched`).
 */
class AnimationManager {
    private floating: ActiveFloating | null = null;
    private introTimers = new Set<NodeJS.Timeout>();
    /** Résolveurs des playIntro en cours — appelés pour les débloquer à l'arrêt. */
    private introWaiters = new Set<() => void>();
    private epoch = 0;
    private starts: Promise<unknown> = Promise.resolve();

    /** File d'attente des démarrages (les arrêts, eux, sont synchrones). */
    private serialize<T>(fn: () => Promise<T>): Promise<T> {
        const next = this.starts.then(fn, fn);
        // La file ne doit jamais rester en échec, sinon tout se bloque derrière.
        this.starts = next.then(
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
     * Interruption SYNCHRONE : à son retour, plus rien de programmé n'écrira
     * (au pire une écriture déjà partie vers le bridge — cf. drainWrite).
     * C'est le seul chemin d'arrêt : tout le reste s'appuie dessus.
     */
    private interruptNow(reason: string): ActiveFloating | null {
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
        if (f?.kind === 'native' && f.nativeRid) {
            const host = process.env.HUE_BRIDGE_IP;
            const key = process.env.HUE_USERNAME;
            if (host && key) {
                void stopNativeDynamic(host, key, f.nativeRid).catch(() => {});
            }
        }
        if (f || hadIntro) {
            Logger.info(`[animation] animations stoppées (${reason})`);
        }
        return f;
    }

    /**
     * Draine l'unique écriture en vol, plafonné : une commande lumière qui
     * suit l'arrêt atteint ainsi le bridge en dernier, sans qu'un bridge
     * accroché puisse bloquer l'appelant.
     */
    private async drainWrite(f: ActiveFloating | null): Promise<void> {
        const write = f?.currentWrite;
        if (!write) return;
        await Promise.race([
            write.catch(() => {}),
            new Promise((r) => {
                const t = setTimeout(r, DRAIN_TIMEOUT_MS);
                t.unref?.();
            }),
        ]);
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
        // Époque capturée AVANT le premier await : un arrêt survenu pendant
        // list_lights périme les frames avant même leur programmation.
        const epoch = this.epoch;
        const lights = (await callTool('list_lights', {})) as Array<{
            name: string;
            room?: string;
        }>;
        if (epoch !== this.epoch) {
            Logger.info('[animation] intro doublée pendant list_lights — stop');
            return;
        }
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
        await this.drainWrite(this.interruptNow('nouvelle boucle'));

        if (cfg.engine === 'native') {
            Logger.warn(
                '[animation] native floating must be started with rids — software loop skipped',
            );
            return;
        }

        // Époque de CE démarrage : un arrêt pendant list_lights la périme et
        // le démarrage avorte (les arrêts ne passent plus par la file — ils
        // ne peuvent plus attendre derrière nous, ils nous doublent).
        const epoch = this.epoch;
        const lights = (await callTool('list_lights', {})) as Array<{
            id?: string | number;
            name: string;
            room?: string;
        }>;
        if (epoch !== this.epoch) {
            Logger.info(
                '[animation] boucle doublée pendant list_lights — abandon',
            );
            return;
        }
        const t = cfg.target.toLowerCase();
        const matched = lights.filter(
            (l) =>
                (l.room ?? '').toLowerCase() === t ||
                l.name.toLowerCase() === t,
        );
        const names = matched.map((l) => l.name);
        if (!names.length) {
            Logger.warn(
                `[animation] floating target "${cfg.target}" matched no lights`,
            );
            return;
        }
        const targets: LoopTargets = {
            target: cfg.target,
            names,
            rooms: [
                ...new Set(
                    matched
                        .map((l) => l.room ?? '')
                        .filter((r): r is string => !!r),
                ),
            ],
            ids: matched
                .map((l) => l.id)
                .filter((id): id is string | number => id !== undefined),
        };

        const tick = computeTickInterval(
            names.length,
            MAX_CMD_PER_SEC,
            MIN_TICK_MS,
        );
        const startedAt = Date.now();
        // Register the loop before the first tick so its commands are tracked
        // as in-flight and can be drained on stop.
        const loop: ActiveFloating = {
            kind: 'software',
            epoch,
            targets,
            lastWrite: new Map(),
            busy: false,
            skipped: 0,
            echoMs: tick + SELF_ECHO_MARGIN_MS,
        };
        this.floating = loop;
        const runTick = () => {
            // Boucle d'une génération révolue : elle n'écrit plus et se désarme.
            if (epoch !== this.epoch) {
                if (loop.timer) clearInterval(loop.timer);
                return;
            }
            if (Date.now() - startedAt > FLOATING_MAX_MS) {
                Logger.info(
                    `[animation] boucle flottante arrêtée après ${Math.round(
                        FLOATING_MAX_MS / 60_000,
                    )} min (plafond FLOATING_MAX_MIN)`,
                );
                void this.stopAll();
                return;
            }
            // Le tick précédent écrit encore (bridge lent) → on saute celui-ci
            // plutôt que d'empiler des écritures en retard.
            if (loop.busy) {
                loop.skipped++;
                if (loop.skipped === 1) {
                    Logger.debug(
                        '[animation] tick sauté (bridge lent) — pas de backlog',
                    );
                }
                return;
            }
            loop.busy = true;
            const colors = floatingFrameColors(
                cfg,
                names,
                Date.now() - startedAt,
            );
            // Écritures SÉQUENTIELLES, époque revérifiée entre chaque (cf.
            // garantie n°4 du en-tête de classe).
            void (async () => {
                try {
                    for (const [name, c] of Object.entries(colors)) {
                        if (epoch !== this.epoch) return;
                        // Timestamp posé avant ET après : la fenêtre d'écho
                        // SSE couvre la durée de l'écriture même si le bridge
                        // met plus de SELF_ECHO_MS à répondre.
                        loop.lastWrite.set(norm(name), Date.now());
                        const write = callTool('set_lights', {
                            target: name,
                            on: true,
                            color: c.color,
                            ...(c.brightness !== undefined
                                ? { brightness: c.brightness }
                                : {}),
                            transitionMs: tick,
                        }).catch(() => {});
                        loop.currentWrite = write;
                        await write;
                        loop.lastWrite.set(norm(name), Date.now());
                    }
                } finally {
                    loop.busy = false;
                }
            })();
        };
        runTick();
        loop.timer = setInterval(runTick, tick);
        Logger.info(
            `[animation] floating started on ${names.length} light(s), tick ${tick}ms`,
        );
    }

    /**
     * Annule l'animation en cours si la commande la concerne. Synchrone dans
     * son cœur (rien ne peut la bloquer) ; l'await ne couvre que le drain de
     * l'unique écriture en vol, plafonné, pour que la commande de l'appelant
     * atteigne le bridge en dernier.
     */
    async cancelIfAffected(
        tool: string,
        args: Record<string, unknown> = {},
    ): Promise<void> {
        if (!shouldCancel(tool)) return;
        const f = this.floating;
        if (!f && this.introTimers.size === 0) {
            // Même sans animation active, la génération avance : une scène en
            // cours d'exécution (dont la flottante n'a pas encore démarré)
            // voit son jeton périmé et n'allumera rien après cette commande.
            this.epoch++;
            return;
        }
        // Boucle active mais commande sans rapport (autre pièce, autre lampe)
        // → elle continue de vivre. Les intros, courtes, gardent l'annulation
        // large : pas d'ambiguïté pendant qu'une scène s'installe.
        if (
            f &&
            this.introTimers.size === 0 &&
            !toolTouchesLoop(tool, args, f.targets)
        ) {
            Logger.debug(
                `[animation] ${tool} ne touche pas la boucle (${f.targets.target}) — elle continue`,
            );
            return;
        }
        await this.drainWrite(this.interruptNow(`commande lumière ${tool}`));
    }

    /**
     * Événement lumière poussé par le bridge (SSE). Si une lampe de la boucle
     * a changé par un autre chemin (app Hue, interrupteur, scène du bridge),
     * la boucle s'efface immédiatement — l'utilisateur a repris la main.
     * Synchrone, jamais bloquant.
     */
    onLightEvent(evt: ExternalLightEvent): void {
        const f = this.floating;
        if (!f || f.kind !== 'software') return;
        const verdict = externalEventVerdict(
            f.targets,
            f.lastWrite,
            evt,
            Date.now(),
            f.echoMs,
        );
        if (!verdict.startsWith('stop')) return;
        Logger.info(
            `[animation] changement externe sur ${
                evt.name ?? evt.room ?? '?'
            } (${verdict}) → boucle stoppée`,
        );
        void this.drainWrite(this.interruptNow('changement externe'));
    }

    /**
     * Écriture directe imminente sur une pièce (molette des télécommandes,
     * PUT grouped_light sans MCP) : coupe la boucle si la pièce est la
     * sienne, en drainant l'écriture en vol pour que le PUT arrive dernier.
     */
    async interruptIfRoomTouched(room: string): Promise<boolean> {
        const f = this.floating;
        if (!f || !matchesLoop(f.targets, room)) return false;
        await this.drainWrite(this.interruptNow(`écriture directe (${room})`));
        return true;
    }

    async stopAll(): Promise<void> {
        await this.drainWrite(this.interruptNow('stopAll'));
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
