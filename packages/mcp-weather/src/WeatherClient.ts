const TIMEZONE = 'Europe/Paris';

// ── WMO weather code → French label + emoji ───────────────────────────────────

const WMO: Record<number, { label: string; emoji: string }> = {
    0: { label: 'Ciel dégagé', emoji: '☀️' },
    1: { label: 'Peu nuageux', emoji: '🌤️' },
    2: { label: 'Partiellement nuageux', emoji: '⛅' },
    3: { label: 'Couvert', emoji: '☁️' },
    45: { label: 'Brouillard', emoji: '🌫️' },
    48: { label: 'Brouillard givrant', emoji: '🌫️' },
    51: { label: 'Bruine légère', emoji: '🌦️' },
    53: { label: 'Bruine modérée', emoji: '🌦️' },
    55: { label: 'Bruine dense', emoji: '🌧️' },
    61: { label: 'Pluie légère', emoji: '🌧️' },
    63: { label: 'Pluie modérée', emoji: '🌧️' },
    65: { label: 'Pluie forte', emoji: '🌧️' },
    71: { label: 'Neige légère', emoji: '🌨️' },
    73: { label: 'Neige modérée', emoji: '❄️' },
    75: { label: 'Neige forte', emoji: '❄️' },
    77: { label: 'Grains de neige', emoji: '🌨️' },
    80: { label: 'Averses légères', emoji: '🌦️' },
    81: { label: 'Averses modérées', emoji: '🌧️' },
    82: { label: 'Averses violentes', emoji: '⛈️' },
    85: { label: 'Averses de neige légères', emoji: '🌨️' },
    86: { label: 'Averses de neige fortes', emoji: '❄️' },
    95: { label: 'Orage', emoji: '⛈️' },
    96: { label: 'Orage avec grêle', emoji: '⛈️' },
    99: { label: 'Orage violent avec grêle', emoji: '⛈️' },
};

function wmo(code: number): { label: string; emoji: string } {
    return WMO[code] ?? { label: `Code météo ${code}`, emoji: '🌡️' };
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function windDir(deg: number): string {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
    return dirs[Math.round(deg / 45) % 8];
}

function uvLabel(uv: number): string {
    if (uv < 3) return 'Faible';
    if (uv < 6) return 'Modéré';
    if (uv < 8) return 'Élevé';
    if (uv < 11) return 'Très élevé';
    return 'Extrême';
}

function formatTime(iso: string): string {
    return new Intl.DateTimeFormat('fr-FR', {
        timeZone: TIMEZONE,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(new Date(iso));
}

function formatDate(isoDate: string): string {
    // isoDate is YYYY-MM-DD
    return new Intl.DateTimeFormat('fr-FR', {
        timeZone: TIMEZONE,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
    }).format(new Date(`${isoDate}T12:00:00`));
}

function formatShortDate(isoDate: string): string {
    return new Intl.DateTimeFormat('fr-FR', {
        timeZone: TIMEZONE,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
    }).format(new Date(`${isoDate}T12:00:00`));
}

// ── Open-Meteo API types ──────────────────────────────────────────────────────

interface OpenMeteoResponse {
    current: {
        time: string;
        temperature_2m: number;
        relative_humidity_2m: number;
        apparent_temperature: number;
        precipitation: number;
        weather_code: number;
        cloud_cover: number;
        wind_speed_10m: number;
        wind_direction_10m: number;
        wind_gusts_10m: number;
        uv_index: number;
    };
    daily: {
        time: string[];
        temperature_2m_max: number[];
        temperature_2m_min: number[];
        precipitation_sum: number[];
        precipitation_probability_max: number[];
        weather_code: number[];
        wind_speed_10m_max: number[];
        sunrise: string[];
        sunset: string[];
        uv_index_max: number[];
    };
    hourly: {
        time: string[];
        temperature_2m: number[];
        apparent_temperature: number[];
        precipitation_probability: number[];
        precipitation: number[];
        weather_code: number[];
        wind_speed_10m: number[];
    };
}

// ── Geocoding ─────────────────────────────────────────────────────────────────

interface GeoResult {
    name: string;
    latitude: number;
    longitude: number;
    country?: string;
}

/**
 * Resolve a city name to coordinates using Open-Meteo's free geocoding API.
 * Returns null if the city is not found.
 */
export async function geocodeCity(
    city: string,
): Promise<{ lat: number; lon: number; name: string } | null> {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=fr&format=json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Geocoding API error: ${res.status}`);
    const data = (await res.json()) as { results?: GeoResult[] };
    if (!data.results?.length) return null;
    const r = data.results[0];
    return { lat: r.latitude, lon: r.longitude, name: r.name };
}

// ── WeatherClient ─────────────────────────────────────────────────────────────

export class WeatherClient {
    private lat: number;
    private lon: number;
    private city: string;

    constructor(lat: number, lon: number, city: string) {
        this.lat = lat;
        this.lon = lon;
        this.city = city;
    }

    // ── API call ───────────────────────────────────────────────────────────────

    private async fetchAll(forecastDays = 14): Promise<OpenMeteoResponse> {
        const params = new URLSearchParams({
            latitude: this.lat.toString(),
            longitude: this.lon.toString(),
            timezone: TIMEZONE,
            forecast_days: forecastDays.toString(),
            current: [
                'temperature_2m',
                'relative_humidity_2m',
                'apparent_temperature',
                'precipitation',
                'weather_code',
                'cloud_cover',
                'wind_speed_10m',
                'wind_direction_10m',
                'wind_gusts_10m',
                'uv_index',
            ].join(','),
            daily: [
                'temperature_2m_max',
                'temperature_2m_min',
                'precipitation_sum',
                'precipitation_probability_max',
                'weather_code',
                'wind_speed_10m_max',
                'sunrise',
                'sunset',
                'uv_index_max',
            ].join(','),
            hourly: [
                'temperature_2m',
                'apparent_temperature',
                'precipitation_probability',
                'precipitation',
                'weather_code',
                'wind_speed_10m',
            ].join(','),
        });

        const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
        if (!res.ok) {
            throw new Error(`Open-Meteo API error: ${res.status} ${res.statusText}`);
        }
        return res.json() as Promise<OpenMeteoResponse>;
    }

    // ── Current weather ────────────────────────────────────────────────────────

    async getCurrentWeather(): Promise<string> {
        const data = await this.fetchAll(1);
        const c = data.current;
        const w = wmo(c.weather_code);

        const now = new Intl.DateTimeFormat('fr-FR', {
            timeZone: TIMEZONE,
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        }).format(new Date(c.time));

        // Also grab today's sunrise/sunset
        const sunrise = data.daily.sunrise[0] ? formatTime(data.daily.sunrise[0]) : '—';
        const sunset = data.daily.sunset[0] ? formatTime(data.daily.sunset[0]) : '—';

        const lines = [
            `${this.city} — ${now}`,
            `${w.label}`,
            `Température : ${Math.round(c.temperature_2m)}°C (ressenti ${Math.round(c.apparent_temperature)}°C)`,
            `Humidité : ${c.relative_humidity_2m}%`,
            `Vent : ${Math.round(c.wind_speed_10m)} km/h ${windDir(c.wind_direction_10m)} (rafales ${Math.round(c.wind_gusts_10m)} km/h)`,
        ];

        if (c.precipitation > 0) {
            lines.push(`Précipitations en cours : ${c.precipitation} mm`);
        }

        lines.push(
            `Nébulosité : ${c.cloud_cover}%`,
            `Indice UV : ${Math.round(c.uv_index)} (${uvLabel(c.uv_index)})`,
            `Lever ${sunrise} — Coucher ${sunset}`,
        );

        return lines.join('\n');
    }

    // ── Today's hourly forecast ────────────────────────────────────────────────

    async getTodayForecast(): Promise<string> {
        const data = await this.fetchAll(2);
        const todayStr = new Date().toLocaleDateString('fr-CA', { timeZone: TIMEZONE });

        // Filter today's hourly data
        const indices: number[] = [];
        for (let i = 0; i < data.hourly.time.length; i++) {
            if (data.hourly.time[i].startsWith(todayStr)) indices.push(i);
        }

        if (indices.length === 0) return 'Données horaires indisponibles pour aujourd\'hui.';

        const lines = [`Prévisions heure par heure — ${formatDate(todayStr)}\n`];

        // Group into 4 time blocks
        const blocks: Array<{ label: string; hours: number[] }> = [
            { label: 'Nuit (0h–5h)', hours: [0, 1, 2, 3, 4, 5] },
            { label: 'Matin (6h–11h)', hours: [6, 7, 8, 9, 10, 11] },
            { label: 'Après-midi (12h–17h)', hours: [12, 13, 14, 15, 16, 17] },
            { label: 'Soir (18h–23h)', hours: [18, 19, 20, 21, 22, 23] },
        ];

        for (const block of blocks) {
            const blockIndices = indices.filter((i) => {
                const h = new Date(data.hourly.time[i]).getHours();
                return block.hours.includes(h);
            });
            if (blockIndices.length === 0) continue;

            // Pick representative hour (middle of block or first available)
            const peakIdx = blockIndices[Math.floor(blockIndices.length / 2)];

            const temps = blockIndices.map((i) => data.hourly.temperature_2m[i]);
            const minT = Math.round(Math.min(...temps));
            const maxT = Math.round(Math.max(...temps));
            const maxPrecipProb = Math.max(
                ...blockIndices.map((i) => data.hourly.precipitation_probability[i]),
            );
            const totalPrecip = blockIndices
                .map((i) => data.hourly.precipitation[i])
                .reduce((a, b) => a + b, 0);
            const w = wmo(data.hourly.weather_code[peakIdx]);
            const wind = Math.round(data.hourly.wind_speed_10m[peakIdx]);

            const precipStr =
                maxPrecipProb > 15
                    ? ` pluie ${maxPrecipProb}%${totalPrecip > 0.1 ? ` (${totalPrecip.toFixed(1)}mm)` : ''}`
                    : '';
            const windStr = wind > 20 ? ` vent ${wind}km/h` : '';

            lines.push(
                `${block.label}\n  ${w.label} · ${minT === maxT ? `${minT}°C` : `${minT}–${maxT}°C`}${precipStr}${windStr}`,
            );
        }

        return lines.join('\n');
    }

    // ── Daily forecast ────────────────────────────────────────────────────────

    async getForecast(days = 7): Promise<string> {
        const cappedDays = Math.min(days, 14);
        const data = await this.fetchAll(cappedDays);
        const d = data.daily;

        const lines = [`Prévisions ${cappedDays} jours — ${this.city}\n`];

        for (let i = 0; i < d.time.length; i++) {
            const w = wmo(d.weather_code[i]);
            const max = Math.round(d.temperature_2m_max[i]);
            const min = Math.round(d.temperature_2m_min[i]);
            const precipProb = d.precipitation_probability_max[i];
            const precipSum = d.precipitation_sum[i];
            const wind = Math.round(d.wind_speed_10m_max[i]);
            const dateLabel = formatShortDate(d.time[i]);

            const precipStr =
                precipProb > 15
                    ? ` pluie ${precipProb}%${precipSum > 0.1 ? ` (${precipSum.toFixed(1)}mm)` : ''}`
                    : '';
            const windStr = wind > 25 ? ` vent ${wind}km/h` : '';

            lines.push(
                `• ${dateLabel} ${w.label} · ${min}°/${max}°${precipStr}${windStr}`,
            );
        }

        return lines.join('\n');
    }

    // ── Weather for a specific date ────────────────────────────────────────────

    async getWeatherForDate(dateStr: string): Promise<string> {
        // Validate: only future dates up to 14 days are supported
        const today = new Date().toLocaleDateString('fr-CA', { timeZone: TIMEZONE });
        if (dateStr < today) {
            return `Les données météo historiques ne sont pas disponibles. Seules les prévisions futures (jusqu'à 14 jours) sont supportées.`;
        }

        const daysFromNow =
            Math.ceil(
                (new Date(`${dateStr}T12:00:00`).getTime() - Date.now()) / 86400000,
            ) + 1;

        if (daysFromNow > 14) {
            return `Les prévisions sont disponibles jusqu'à 14 jours. La date ${formatDate(dateStr)} est hors de portée.`;
        }

        const data = await this.fetchAll(Math.min(daysFromNow + 1, 14));
        const d = data.daily;
        const dayIdx = d.time.indexOf(dateStr);

        if (dayIdx === -1) {
            return `Aucune donnée météo trouvée pour le ${formatDate(dateStr)}.`;
        }

        const w = wmo(d.weather_code[dayIdx]);
        const max = Math.round(d.temperature_2m_max[dayIdx]);
        const min = Math.round(d.temperature_2m_min[dayIdx]);
        const precipProb = d.precipitation_probability_max[dayIdx];
        const precipSum = d.precipitation_sum[dayIdx];
        const wind = Math.round(d.wind_speed_10m_max[dayIdx]);
        const uv = Math.round(d.uv_index_max[dayIdx]);
        const sunrise = d.sunrise[dayIdx] ? formatTime(d.sunrise[dayIdx]) : '—';
        const sunset = d.sunset[dayIdx] ? formatTime(d.sunset[dayIdx]) : '—';

        const lines = [
            `Météo du ${formatDate(dateStr)} — ${this.city}`,
            `${w.label}`,
            `Température : ${min}°C / ${max}°C`,
        ];

        if (precipProb > 15) {
            lines.push(
                `Précipitations : ${precipProb}% de chances${precipSum > 0.1 ? ` (${precipSum.toFixed(1)} mm)` : ''}`,
            );
        } else {
            lines.push('Pas de précipitations significatives prévues');
        }

        lines.push(
            `Vent max : ${wind} km/h`,
            `UV max : ${uv} (${uvLabel(uv)})`,
            `Lever ${sunrise} — Coucher ${sunset}`,
        );

        // Add hourly blocks for that day
        const dayIndices: number[] = [];
        for (let i = 0; i < data.hourly.time.length; i++) {
            if (data.hourly.time[i].startsWith(dateStr)) dayIndices.push(i);
        }

        if (dayIndices.length > 0) {
            lines.push('\nDétail par période :');
            const periods = [
                { label: 'Matin (8h–12h)', hours: [8, 9, 10, 11] },
                { label: 'Après-midi (13h–18h)', hours: [13, 14, 15, 16, 17, 18] },
                { label: 'Soirée (19h–22h)', hours: [19, 20, 21, 22] },
            ];

            for (const period of periods) {
                const pIdx = dayIndices.filter((i) => {
                    const h = new Date(data.hourly.time[i]).getHours();
                    return period.hours.includes(h);
                });
                if (pIdx.length === 0) continue;

                const peakIdx = pIdx[Math.floor(pIdx.length / 2)];
                const avgTemp = Math.round(
                    pIdx.map((i) => data.hourly.temperature_2m[i]).reduce((a, b) => a + b, 0) /
                        pIdx.length,
                );
                const maxProb = Math.max(...pIdx.map((i) => data.hourly.precipitation_probability[i]));
                const pw = wmo(data.hourly.weather_code[peakIdx]);
                const pWind = Math.round(data.hourly.wind_speed_10m[peakIdx]);

                const precipStr = maxProb > 15 ? ` · pluie ${maxProb}%` : '';
                const windStr = pWind > 25 ? ` · vent ${pWind}km/h` : '';

                lines.push(`  • ${period.label} : ${pw.label} ${avgTemp}°C${precipStr}${windStr}`);
            }
        }

        return lines.join('\n');
    }
}
