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

/** Light-affecting tools whose invocation must cancel an active floating loop. */
const LIGHT_TOOLS = new Set([
    'set_lights',
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
    timer?: NodeJS.Timeout;
    nativeRid?: string;
}

class AnimationManager {
    private floating: ActiveFloating | null = null;

    /** Play an intro once; resolves when the timeline finishes. */
    async playIntro(
        effects: AnimationEffect[],
        callTool: CallTool,
    ): Promise<void> {
        if (!effects?.length) return;
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

        await new Promise<void>((done) => {
            for (const f of frames) {
                setTimeout(() => void this.applyFrame(f, callTool), f.atMs);
            }
            setTimeout(done, totalMs);
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

    /** Start a floating loop (cancels any previous). Software engine only here. */
    async startFloating(
        cfg: FloatingConfig,
        callTool: CallTool,
    ): Promise<void> {
        await this.stopAll();

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
        const runTick = () => {
            const colors = floatingFrameColors(
                cfg,
                names,
                Date.now() - startedAt,
            );
            for (const [name, c] of Object.entries(colors)) {
                void callTool('set_lights', {
                    target: name,
                    on: true,
                    color: c.color,
                    ...(c.brightness !== undefined
                        ? { brightness: c.brightness }
                        : {}),
                    transitionMs: tick,
                }).catch(() => {});
            }
        };
        runTick();
        const timer = setInterval(runTick, tick);
        this.floating = { kind: 'software', timer };
        Logger.info(
            `[animation] floating started on ${names.length} light(s), tick ${tick}ms`,
        );
    }

    /** Cancel the active floating loop iff the incoming tool affects lights. */
    async cancelIfAffected(tool: string): Promise<void> {
        if (this.floating && shouldCancel(tool)) {
            await this.stopAll();
        }
    }

    async stopAll(): Promise<void> {
        if (!this.floating) return;
        const f = this.floating;
        this.floating = null;
        if (f.timer) clearInterval(f.timer);
        if (f.kind === 'native' && f.nativeRid) {
            const host = process.env.HUE_BRIDGE_IP;
            const key = process.env.HUE_USERNAME;
            if (host && key) await stopNativeDynamic(host, key, f.nativeRid);
        }
        Logger.info('[animation] floating stopped');
    }

    isFloating(): boolean {
        return this.floating !== null;
    }
}

/** Process-wide singleton. */
export const animationManager = new AnimationManager();
