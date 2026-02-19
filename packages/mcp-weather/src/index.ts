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
import { WeatherClient } from './WeatherClient';
import { WEATHER_TOOLS } from './tools';
import Logger from './logger';

// Location config — defaults to Paris, override in .env
const lat = parseFloat(process.env.WEATHER_LAT ?? '48.8566');
const lon = parseFloat(process.env.WEATHER_LON ?? '2.3522');
const city = process.env.WEATHER_CITY ?? 'Paris';

const weather = new WeatherClient(lat, lon, city);

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

        switch (name) {
            case 'get_current_weather':
                text = await weather.getCurrentWeather();
                break;

            case 'get_today_forecast':
                text = await weather.getTodayForecast();
                break;

            case 'get_forecast':
                text = await weather.getForecast(
                    a.days !== undefined ? Number(a.days) : 7,
                );
                break;

            case 'get_weather_for_date':
                text = await weather.getWeatherForDate(a.date as string);
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
    Logger.info(`mcp-weather server running on stdio (${city} ${lat},${lon})`);
}

main().catch((error) => {
    Logger.error(`Fatal error: ${error}`);
    process.exit(1);
});
