export const WEATHER_TOOLS = [
    {
        name: 'get_current_weather',
        description:
            'Get current weather conditions: temperature, feels-like, humidity, wind speed and direction, precipitation, cloud cover, UV index, sunrise/sunset. Use this for "what is the weather right now" questions.',
        inputSchema: {
            type: 'object' as const,
            properties: {},
            required: [],
        },
    },
    {
        name: 'get_today_forecast',
        description:
            "Get today's weather broken down into 4 time blocks (night, morning, afternoon, evening) with temperature range, precipitation probability, and wind for each block. Use this for planning the day or answering 'will it rain today?'",
        inputSchema: {
            type: 'object' as const,
            properties: {},
            required: [],
        },
    },
    {
        name: 'get_forecast',
        description:
            "Get the daily weather forecast for the next N days (default 7, max 14). Each day shows: weather condition, min/max temperature, precipitation probability and amount, max wind speed. Ideal for combining with get_week (calendar) for a full weekly briefing.",
        inputSchema: {
            type: 'object' as const,
            properties: {
                days: {
                    type: 'number',
                    description: 'Number of days to forecast (default 7, max 14).',
                },
            },
            required: [],
        },
    },
    {
        name: 'get_weather_for_date',
        description:
            "Get the detailed weather forecast for a specific date (up to 14 days ahead). Returns full-day summary plus morning/afternoon/evening breakdown. Combine with get_schedule or get_event to answer 'what will the weather be like for my meeting on Thursday?'",
        inputSchema: {
            type: 'object' as const,
            properties: {
                date: {
                    type: 'string',
                    description:
                        'Date to forecast in YYYY-MM-DD format. Must be today or in the next 14 days.',
                },
            },
            required: ['date'],
        },
    },
];
