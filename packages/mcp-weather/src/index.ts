import dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(__dirname, '../../../.env') });

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ErrorCode,
    McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { WeatherClient, geocodeCity } from './WeatherClient';
import { WEATHER_TOOLS } from './tools';
import Logger from './logger';

// Default location — override in .env (WEATHER_LAT, WEATHER_LON, WEATHER_CITY)
const defaultLat = parseFloat(process.env.WEATHER_LAT ?? '43.6047');
const defaultLon = parseFloat(process.env.WEATHER_LON ?? '1.4442');
const defaultCity = process.env.WEATHER_CITY ?? 'Toulouse';

const defaultWeather = new WeatherClient(defaultLat, defaultLon, defaultCity);

/**
 * Returns a WeatherClient for the given location string (geocoded on the fly),
 * or the default client if no location is provided.
 */
async function resolveClient(location?: string): Promise<WeatherClient> {
    if (!location) return defaultWeather;
    const geo = await geocodeCity(location);
    if (!geo) {
        Logger.warn(`Geocoding failed for "${location}" — falling back to default`);
        return defaultWeather;
    }
    Logger.debug(`Geocoded "${location}" → ${geo.name} (${geo.lat}, ${geo.lon})`);
    return new WeatherClient(geo.lat, geo.lon, geo.name);
}

const server = new Server(
    { name: 'mcp-weather', version: '1.0.0' },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: WEATHER_TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    try {
        let text: string;
        const location = a.location ? String(a.location) : undefined;
        const client = await resolveClient(location);

        switch (name) {
            case 'get_current_weather':
                text = await client.getCurrentWeather();
                break;

            case 'get_today_forecast':
                text = await client.getTodayForecast();
                break;

            case 'get_forecast':
                text = await client.getForecast(
                    a.days !== undefined ? Number(a.days) : 7,
                );
                break;

            case 'get_weather_for_date':
                text = await client.getWeatherForDate(a.date as string);
                break;

            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }

        return { content: [{ type: 'text', text }] };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        Logger.error(`Tool "${name}" error: ${message}`);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    Logger.info(`mcp-weather server running on stdio (default: ${defaultCity} ${defaultLat},${defaultLon})`);
}

main().catch((error) => {
    Logger.error(`Fatal error: ${error}`);
    process.exit(1);
});
