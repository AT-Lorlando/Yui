export const NUKI_TOOLS = [
    {
        name: 'list_doors',
        description:
            'List all Nuki smart locks with their current state (locked/unlocked, battery level)',
        inputSchema: {
            type: 'object' as const,
            properties: {},
            required: [],
        },
    },
    {
        name: 'lock_door',
        description: 'Lock a specific Nuki smart lock by its ID',
        inputSchema: {
            type: 'object' as const,
            properties: {
                nukiId: {
                    type: 'number',
                    description: 'The numeric ID of the Nuki smart lock',
                },
                deviceType: {
                    type: 'number',
                    description:
                        'Device type: 0=Smart Lock, 2=Opener, 4=Smart Lock 3.0 (default: 0)',
                },
            },
            required: ['nukiId'],
        },
    },
    {
        name: 'unlock_door',
        description: 'Unlock a specific Nuki smart lock by its ID',
        inputSchema: {
            type: 'object' as const,
            properties: {
                nukiId: {
                    type: 'number',
                    description: 'The numeric ID of the Nuki smart lock',
                },
                deviceType: {
                    type: 'number',
                    description:
                        'Device type: 0=Smart Lock, 2=Opener, 4=Smart Lock 3.0 (default: 0)',
                },
            },
            required: ['nukiId'],
        },
    },
    {
        name: 'get_door_state',
        description:
            'Get the detailed state of a specific Nuki smart lock (locked/unlocked, battery, door sensor)',
        inputSchema: {
            type: 'object' as const,
            properties: {
                nukiId: {
                    type: 'number',
                    description: 'The numeric ID of the Nuki smart lock',
                },
                deviceType: {
                    type: 'number',
                    description:
                        'Device type: 0=Smart Lock, 2=Opener, 4=Smart Lock 3.0 (default: 0)',
                },
            },
            required: ['nukiId'],
        },
    },
    {
        name: 'refresh_doors',
        description:
            'Force re-discovery of all Nuki smart locks from the bridge, updating the cached state',
        inputSchema: {
            type: 'object' as const,
            properties: {},
            required: [],
        },
    },
];
