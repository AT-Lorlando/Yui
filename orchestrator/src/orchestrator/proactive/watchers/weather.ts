import Logger from '../../../logger';
import type {
    CandidateEvent,
    ProactiveDeps,
    Watcher,
    WeatherWatcherConfig,
} from '../types';

interface CurrentWeather {
    city?: string;
    temperature_c?: number;
    precipitation_mm?: number;
}
interface TodayForecast {
    periods?: { temp_max_c?: number }[];
}

export async function evaluateWeather(
    deviceHandler: (
        tool: string,
        args?: Record<string, unknown>,
    ) => Promise<unknown>,
    cfg: WeatherWatcherConfig,
    now: Date,
): Promise<CandidateEvent[]> {
    const events: CandidateEvent[] = [];
    const cur = (await deviceHandler(
        'get_current_weather',
    )) as CurrentWeather | null;
    const today = (await deviceHandler(
        'get_today_forecast',
    )) as TodayForecast | null;
    const city = cur?.city ?? 'la maison';

    // anomalie de température de saison
    const normal = cfg.monthlyNormalsC[now.getMonth()];
    if (
        typeof cur?.temperature_c === 'number' &&
        typeof normal === 'number' &&
        Math.abs(cur.temperature_c - normal) >= cfg.anomalyMarginC
    ) {
        const sens = cur.temperature_c > normal ? 'au-dessus' : 'en-dessous';
        events.push({
            watcherId: 'weather',
            subject: 'temp-anomaly',
            importance: 'utile',
            facts: `Température actuelle ${cur.temperature_c}°C à ${city}, nettement ${sens} de la normale de saison (environ ${normal}°C).`,
        });
    }

    // forte chaleur → arrosage supplémentaire (action whitelist)
    const maxes = (today?.periods ?? [])
        .map((p) => p.temp_max_c)
        .filter((t): t is number => typeof t === 'number');
    const dayMax = maxes.length ? Math.max(...maxes) : cur?.temperature_c;
    if (typeof dayMax === 'number' && dayMax >= cfg.hotThresholdC) {
        events.push({
            watcherId: 'weather',
            subject: 'heat-extra-watering',
            importance: 'utile',
            facts: `Forte chaleur aujourd'hui à ${city} (jusqu'à ${dayMax}°C) : un arrosage supplémentaire des plantes est conseillé.`,
            proposedAction: { id: 'extra-watering', tag: 'irrigation' },
        });
    }

    // pluie en cours
    if (
        typeof cur?.precipitation_mm === 'number' &&
        cur.precipitation_mm >= cfg.rainThresholdMm
    ) {
        events.push({
            watcherId: 'weather',
            subject: 'rain-now',
            importance: 'info',
            facts: `Il pleut actuellement à ${city} (${cur.precipitation_mm} mm).`,
        });
    }

    return events;
}

export function createWeatherWatcher(
    cfg: WeatherWatcherConfig,
    deps: ProactiveDeps,
): Watcher {
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = async (emit: (c: CandidateEvent) => void): Promise<void> => {
        try {
            const events = await evaluateWeather(
                deps.deviceHandler,
                cfg,
                new Date(deps.now ? deps.now() : Date.now()),
            );
            Logger.info(
                `proactive[weather]: poll → ${events.length} candidat(s)` +
                    (events.length
                        ? ` (${events.map((e) => e.subject).join(', ')})`
                        : ''),
            );
            for (const e of events) emit(e);
        } catch (err) {
            Logger.warn(`proactive[weather]: ${err}`);
        }
    };
    return {
        id: 'weather',
        start(emit) {
            void tick(emit);
            timer = setInterval(
                () => void tick(emit),
                cfg.pollMinutes * 60_000,
            );
        },
        stop() {
            if (timer) clearInterval(timer);
        },
    };
}
