import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    McpError,
    ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { resolve } from 'path';
import dotenv from 'dotenv';
import { GoogleAuth } from './GoogleAuth';
import { CalendarClient } from './CalendarClient';
import { CALENDAR_TOOLS } from './tools';
import Logger from './logger';

dotenv.config({ path: resolve(__dirname, '../../../.env') });

let calendar: CalendarClient;

const server = new Server(
    { name: 'mcp-calendar', version: '1.0.0' },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: CALENDAR_TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    try {
        let text: string;

        switch (name) {
            case 'list_calendars':
                text = await calendar.listCalendars();
                break;

            case 'get_today':
                text = await calendar.getToday();
                break;

            case 'get_week':
                text = await calendar.getWeek();
                break;

            case 'get_schedule':
                text = await calendar.getSchedule({
                    startDate: a.startDate as string | undefined,
                    endDate: a.endDate as string | undefined,
                    calendarIds: a.calendarIds as string[] | undefined,
                    maxResults: a.maxResults as number | undefined,
                });
                break;

            case 'get_event':
                text = await calendar.getEvent(
                    (a.calendarId as string | undefined) ?? 'primary',
                    a.eventId as string,
                );
                break;

            case 'create_event':
                text = await calendar.createEvent({
                    calendarId: a.calendarId as string | undefined,
                    title: a.title as string,
                    startDateTime: a.startDateTime as string | undefined,
                    endDateTime: a.endDateTime as string | undefined,
                    startDate: a.startDate as string | undefined,
                    endDate: a.endDate as string | undefined,
                    location: a.location as string | undefined,
                    description: a.description as string | undefined,
                    attendeeEmails: a.attendeeEmails as string[] | undefined,
                    recurrence: a.recurrence as string | undefined,
                });
                break;

            case 'update_event':
                text = await calendar.updateEvent({
                    calendarId: a.calendarId as string | undefined,
                    eventId: a.eventId as string,
                    title: a.title as string | undefined,
                    startDateTime: a.startDateTime as string | undefined,
                    endDateTime: a.endDateTime as string | undefined,
                    startDate: a.startDate as string | undefined,
                    endDate: a.endDate as string | undefined,
                    location: a.location as string | undefined,
                    description: a.description as string | undefined,
                    attendeeEmails: a.attendeeEmails as string[] | undefined,
                });
                break;

            case 'delete_event':
                text = await calendar.deleteEvent(
                    (a.calendarId as string | undefined) ?? 'primary',
                    a.eventId as string,
                );
                break;

            case 'search_events':
                text = await calendar.searchEvents({
                    query: a.query as string,
                    calendarId: a.calendarId as string | undefined,
                    maxResults: a.maxResults as number | undefined,
                });
                break;

            case 'find_free_slots':
                text = await calendar.findFreeSlots({
                    date: a.date as string,
                    durationMinutes: a.durationMinutes as number,
                    calendarIds: a.calendarIds as string[] | undefined,
                    workdayStart: a.workdayStart as number | undefined,
                    workdayEnd: a.workdayEnd as number | undefined,
                });
                break;

            case 'quick_add_event':
                text = await calendar.quickAdd(
                    a.text as string,
                    (a.calendarId as string | undefined) ?? 'primary',
                );
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
    Logger.info('Authenticating with Google Calendar...');
    const auth = await GoogleAuth.connect();
    calendar = new CalendarClient(auth);
    Logger.info('Google Calendar authenticated.');

    const transport = new StdioServerTransport();
    await server.connect(transport);
    Logger.info('mcp-calendar server running on stdio');
}

main().catch((error) => {
    Logger.error(`Fatal error: ${error}`);
    process.exit(1);
});
