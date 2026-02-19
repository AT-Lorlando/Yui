export const CALENDAR_TOOLS = [
    {
        name: 'list_calendars',
        description:
            "List all Google Calendar calendars available to the user, with their ID, name, and access role. Use this when the user asks what calendars they have, or when you need a calendar ID for another tool.",
        inputSchema: {
            type: 'object' as const,
            properties: {},
            required: [],
        },
    },
    {
        name: 'get_today',
        description:
            "Get all of today's events across every calendar, grouped by day and formatted with times, durations, locations, attendees, and Google Meet links. Use this when the user asks what's on today, their agenda for today, or what they have planned.",
        inputSchema: {
            type: 'object' as const,
            properties: {},
            required: [],
        },
    },
    {
        name: 'get_week',
        description:
            "Get all events for the current week (Monday to Sunday) across every calendar. Use this for weekly planning questions.",
        inputSchema: {
            type: 'object' as const,
            properties: {},
            required: [],
        },
    },
    {
        name: 'get_schedule',
        description:
            "Get events for a specific date or date range across all (or specific) calendars. Results are grouped by day with full event details. Use this for any date-range query not covered by get_today or get_week.",
        inputSchema: {
            type: 'object' as const,
            properties: {
                startDate: {
                    type: 'string',
                    description: 'Start date (YYYY-MM-DD). Defaults to today.',
                },
                endDate: {
                    type: 'string',
                    description:
                        'End date (YYYY-MM-DD). Defaults to startDate (single day).',
                },
                calendarIds: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Optional: restrict to these calendar IDs. Omit for all calendars.',
                },
                maxResults: {
                    type: 'number',
                    description: 'Max events per calendar (default 50).',
                },
            },
            required: [],
        },
    },
    {
        name: 'get_event',
        description:
            "Get full details for a specific event by its ID — title, time, location, attendees with RSVP status, Google Meet link, description, recurrence info.",
        inputSchema: {
            type: 'object' as const,
            properties: {
                calendarId: {
                    type: 'string',
                    description: 'Calendar ID. Use "primary" for the main calendar.',
                },
                eventId: {
                    type: 'string',
                    description: 'Event ID (from list_calendars or get_schedule output).',
                },
            },
            required: ['calendarId', 'eventId'],
        },
    },
    {
        name: 'create_event',
        description:
            "Create a new calendar event. Supports timed events, all-day events, recurring events (RRULE), and inviting attendees (invitation emails are sent automatically).",
        inputSchema: {
            type: 'object' as const,
            properties: {
                title: {
                    type: 'string',
                    description: 'Event title / summary.',
                },
                calendarId: {
                    type: 'string',
                    description: 'Calendar ID (default: "primary").',
                },
                startDateTime: {
                    type: 'string',
                    description:
                        'Start as ISO 8601 datetime, e.g. "2026-02-20T14:00:00". Use for timed events.',
                },
                endDateTime: {
                    type: 'string',
                    description:
                        'End as ISO 8601 datetime. Required when startDateTime is set.',
                },
                startDate: {
                    type: 'string',
                    description: 'Start as YYYY-MM-DD for an all-day event.',
                },
                endDate: {
                    type: 'string',
                    description:
                        'End as YYYY-MM-DD for a multi-day all-day event (defaults to startDate).',
                },
                location: {
                    type: 'string',
                    description: 'Physical address or virtual meeting URL.',
                },
                description: {
                    type: 'string',
                    description: 'Event notes or agenda.',
                },
                attendeeEmails: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Attendee email addresses. Google Calendar will send invitation emails.',
                },
                recurrence: {
                    type: 'string',
                    description:
                        'RFC 5545 RRULE for recurring events. Examples: "RRULE:FREQ=WEEKLY" (weekly), "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR" (MWF), "RRULE:FREQ=MONTHLY;BYDAY=1MO" (first Monday of month).',
                },
            },
            required: ['title'],
        },
    },
    {
        name: 'update_event',
        description:
            "Update an existing event. Only provide the fields you want to change — all others are kept as-is.",
        inputSchema: {
            type: 'object' as const,
            properties: {
                eventId: {
                    type: 'string',
                    description: 'Event ID to update.',
                },
                calendarId: {
                    type: 'string',
                    description: 'Calendar ID (default: "primary").',
                },
                title: { type: 'string', description: 'New title.' },
                startDateTime: {
                    type: 'string',
                    description: 'New start (ISO 8601 datetime).',
                },
                endDateTime: {
                    type: 'string',
                    description: 'New end (ISO 8601 datetime).',
                },
                startDate: {
                    type: 'string',
                    description: 'New start (YYYY-MM-DD, all-day).',
                },
                endDate: {
                    type: 'string',
                    description: 'New end (YYYY-MM-DD, all-day).',
                },
                location: { type: 'string' },
                description: { type: 'string' },
                attendeeEmails: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'New attendee list — replaces the existing one.',
                },
            },
            required: ['eventId'],
        },
    },
    {
        name: 'delete_event',
        description:
            "Delete a calendar event. Cancellation emails are automatically sent to attendees.",
        inputSchema: {
            type: 'object' as const,
            properties: {
                eventId: {
                    type: 'string',
                    description: 'Event ID to delete.',
                },
                calendarId: {
                    type: 'string',
                    description: 'Calendar ID (default: "primary").',
                },
            },
            required: ['eventId'],
        },
    },
    {
        name: 'search_events',
        description:
            "Full-text search for events by title, description, location, or attendee name/email. Searches upcoming events by default. Omit calendarId to search all calendars.",
        inputSchema: {
            type: 'object' as const,
            properties: {
                query: {
                    type: 'string',
                    description: 'Search terms.',
                },
                calendarId: {
                    type: 'string',
                    description:
                        'Calendar ID to search. Omit to search all calendars.',
                },
                maxResults: {
                    type: 'number',
                    description: 'Max results per calendar (default 20).',
                },
            },
            required: ['query'],
        },
    },
    {
        name: 'find_free_slots',
        description:
            "Find available time slots in a day — useful for scheduling a meeting. Uses the Google Calendar freebusy API to check all calendars at once.",
        inputSchema: {
            type: 'object' as const,
            properties: {
                date: {
                    type: 'string',
                    description: 'Date to check (YYYY-MM-DD).',
                },
                durationMinutes: {
                    type: 'number',
                    description: 'Minimum slot length in minutes.',
                },
                workdayStart: {
                    type: 'number',
                    description: 'Workday start hour (0-23, default 9).',
                },
                workdayEnd: {
                    type: 'number',
                    description: 'Workday end hour (0-23, default 19).',
                },
                calendarIds: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Calendars to check for conflicts. Defaults to all calendars.',
                },
            },
            required: ['date', 'durationMinutes'],
        },
    },
    {
        name: 'quick_add_event',
        description:
            'Create an event from a natural language description. Google parses the text to extract date, time, and title automatically. Examples: "Réunion avec Alice vendredi 17h", "Dentist appointment March 5 at 2pm".',
        inputSchema: {
            type: 'object' as const,
            properties: {
                text: {
                    type: 'string',
                    description: 'Natural language event description.',
                },
                calendarId: {
                    type: 'string',
                    description: 'Calendar ID (default: "primary").',
                },
            },
            required: ['text'],
        },
    },
];
