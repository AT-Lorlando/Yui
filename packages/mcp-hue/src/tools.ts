export const HUE_TOOLS = [
    {
        name: 'list_lights',
        description:
            'List all Philips Hue lights with their current state (on/off, brightness, color)',
        inputSchema: {
            type: 'object' as const,
            properties: {},
            required: [],
        },
    },
    {
        name: 'turn_on_light',
        description: 'Turn on a specific Hue light by its ID',
        inputSchema: {
            type: 'object' as const,
            properties: {
                lightId: {
                    type: 'number',
                    description: 'The numeric ID of the light to turn on',
                },
            },
            required: ['lightId'],
        },
    },
    {
        name: 'turn_off_light',
        description: 'Turn off a specific Hue light by its ID',
        inputSchema: {
            type: 'object' as const,
            properties: {
                lightId: {
                    type: 'number',
                    description: 'The numeric ID of the light to turn off',
                },
            },
            required: ['lightId'],
        },
    },
    {
        name: 'set_brightness',
        description:
            'Set the brightness of a specific Hue light (0-254). Also turns the light on.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                lightId: {
                    type: 'number',
                    description: 'The numeric ID of the light',
                },
                brightness: {
                    type: 'number',
                    description: 'Brightness level from 0 (min) to 254 (max)',
                    minimum: 0,
                    maximum: 254,
                },
            },
            required: ['lightId', 'brightness'],
        },
    },
    {
        name: 'set_color',
        description:
            'Set the color of a specific Hue light using a hex color string (e.g. "#FF5500")',
        inputSchema: {
            type: 'object' as const,
            properties: {
                lightId: {
                    type: 'number',
                    description: 'The numeric ID of the light',
                },
                color: {
                    type: 'string',
                    description:
                        'Hex color string, e.g. "#FF5500" or "FF5500"',
                },
            },
            required: ['lightId', 'color'],
        },
    },
    {
        name: 'refresh_lights',
        description:
            'Force re-discovery of all Hue lights from the bridge, updating the cached state and room assignments',
        inputSchema: {
            type: 'object' as const,
            properties: {},
            required: [],
        },
    },
];
