import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const IRRIGATION_TOOLS: Tool[] = [
    {
        name: 'irrigation_status',
        description: 'Get the current state of both irrigation pumps (active, remaining time).',
        inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
        name: 'irrigation_start',
        description: 'Start one or both irrigation pumps for a given duration.',
        inputSchema: {
            type: 'object',
            properties: {
                pump: {
                    type: 'string',
                    enum: ['A', 'B', 'both'],
                    description: 'Which pump to start. "both" starts A and B simultaneously.',
                },
                duration_seconds: {
                    type: 'number',
                    description: 'How long to water, in seconds. E.g. 600 = 10 minutes.',
                    minimum: 1,
                    maximum: 86400,
                },
            },
            required: ['pump', 'duration_seconds'],
        },
    },
    {
        name: 'irrigation_stop',
        description: 'Stop one or both irrigation pumps immediately.',
        inputSchema: {
            type: 'object',
            properties: {
                pump: {
                    type: 'string',
                    enum: ['A', 'B', 'both'],
                    description: 'Which pump to stop. Defaults to "both" if omitted.',
                },
            },
            required: [],
        },
    },
    {
        name: 'irrigation_discover_dps',
        description: 'Dump all raw Tuya DPS values from the device — used during setup to identify which DPS controls which pump/timer.',
        inputSchema: { type: 'object', properties: {}, required: [] },
    },
];
