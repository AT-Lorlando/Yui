import assert from 'assert';
import { evaluateWeather } from './weather';
import type { WeatherWatcherConfig } from '../types';

const cfg: WeatherWatcherConfig = {
    pollMinutes: 30,
    monthlyNormalsC: [8, 10, 14, 17, 21, 25, 28, 28, 24, 18, 12, 9], // mai = index 4 = 21
    anomalyMarginC: 8,
    hotThresholdC: 30,
    rainThresholdMm: 0.5,
};

async function run(): Promise<void> {
    const may = new Date('2026-05-29T14:00:00'); // mois index 4 → normale 21°C

    // canicule + anomalie + pas de pluie
    {
        const handler = async (tool: string) => {
            if (tool === 'get_current_weather')
                return {
                    city: 'Toulouse',
                    temperature_c: 34,
                    precipitation_mm: 0,
                };
            return {
                city: 'Toulouse',
                date: '2026-05-29',
                periods: [{ temp_max_c: 34, precipitation_prob: 0 }],
            };
        };
        const events = await evaluateWeather(handler, cfg, may);
        const subjects = events.map((e) => e.subject).sort();
        assert.deepStrictEqual(subjects, [
            'heat-extra-watering',
            'temp-anomaly',
        ]);
        const heat = events.find((e) => e.subject === 'heat-extra-watering');
        assert.deepStrictEqual(heat?.proposedAction, {
            id: 'extra-watering',
            tag: 'irrigation',
        });
    }

    // température normale + pluie en cours
    {
        const handler = async (tool: string) => {
            if (tool === 'get_current_weather')
                return {
                    city: 'Toulouse',
                    temperature_c: 20,
                    precipitation_mm: 1.2,
                };
            return {
                city: 'Toulouse',
                date: '2026-05-29',
                periods: [{ temp_max_c: 22, precipitation_prob: 80 }],
            };
        };
        const events = await evaluateWeather(handler, cfg, may);
        assert.deepStrictEqual(
            events.map((e) => e.subject),
            ['rain-now'],
        );
    }

    console.log('All weather tests passed');
}

run();
