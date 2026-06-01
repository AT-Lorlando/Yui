// orchestrator/src/orchestrator/animation/dynamicScene.ts
import { hueRequest } from './hueV2';
import { hexToRgb } from './gradient';
import Logger from '../../logger';

/** Convert hex → CIE xy (Wide RGB D65, the Hue v2 colour model). */
export function hexToXy(hex: string): { x: number; y: number } {
    let [r, g, b] = hexToRgb(hex).map((v) => v / 255);
    const gamma = (c: number) =>
        c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92;
    r = gamma(r);
    g = gamma(g);
    b = gamma(b);
    const X = r * 0.4124 + g * 0.3576 + b * 0.1805;
    const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const Z = r * 0.0193 + g * 0.1192 + b * 0.9505;
    const sum = X + Y + Z;
    if (sum === 0) return { x: 0, y: 0 };
    return {
        x: Math.round((X / sum) * 10000) / 10000,
        y: Math.round((Y / sum) * 10000) / 10000,
    };
}

export interface DynamicSceneSpec {
    name: string;
    groupRid: string;
    lightRids: string[];
    palette: string[];
    /** 0–1, drift speed. */
    speed: number;
}

/** Pure: build the POST body for a Hue v2 dynamic scene. */
export function buildDynamicSceneBody(spec: DynamicSceneSpec): any {
    return {
        type: 'scene',
        metadata: { name: spec.name },
        group: { rid: spec.groupRid, rtype: 'room' },
        actions: spec.lightRids.map((rid, i) => ({
            target: { rid, rtype: 'light' },
            action: {
                on: { on: true },
                color: { xy: hexToXy(spec.palette[i % spec.palette.length]) },
            },
        })),
        palette: {
            color: spec.palette.map((hex) => ({
                color: { xy: hexToXy(hex) },
                dimming: { brightness: 80 },
            })),
            dimming: [{ brightness: 80 }],
            color_temperature: [],
            effects: [],
        },
        speed: spec.speed,
    };
}

/** Create the scene, recall it in dynamic mode. Returns the scene rid. */
export async function startNativeDynamic(
    host: string,
    key: string,
    spec: DynamicSceneSpec,
): Promise<string | null> {
    try {
        const created = await hueRequest(
            host,
            key,
            '/clip/v2/resource/scene',
            'POST',
            buildDynamicSceneBody(spec),
        );
        const rid = created?.data?.[0]?.rid;
        if (!rid) {
            Logger.warn(
                `[dynamic-scene] no rid returned: ${JSON.stringify(created)}`,
            );
            return null;
        }
        await hueRequest(host, key, `/clip/v2/resource/scene/${rid}`, 'PUT', {
            recall: { action: 'dynamic_palette' },
        });
        Logger.info(`[dynamic-scene] started "${spec.name}" (${rid})`);
        return rid;
    } catch (e) {
        Logger.warn(`[dynamic-scene] start failed: ${e}`);
        return null;
    }
}

/** Stop drift (recall static). */
export async function stopNativeDynamic(
    host: string,
    key: string,
    rid: string,
): Promise<void> {
    try {
        await hueRequest(host, key, `/clip/v2/resource/scene/${rid}`, 'PUT', {
            recall: { action: 'static' },
        });
    } catch (e) {
        Logger.warn(`[dynamic-scene] stop failed: ${e}`);
    }
}
