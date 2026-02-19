export const SAMSUNG_TOOLS = [
    {
        name: 'tv_get_status',
        description: 'Get the current Samsung TV status: power state, volume, mute, and input source.',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
    },
    {
        name: 'tv_power',
        description: 'Turn the Samsung TV on or off.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                state: { type: 'string', enum: ['on', 'off'], description: 'Desired power state' },
            },
            required: ['state'],
        },
    },
    {
        name: 'tv_set_volume',
        description: 'Set the Samsung TV volume (0–100).',
        inputSchema: {
            type: 'object' as const,
            properties: {
                level: { type: 'number', minimum: 0, maximum: 100, description: 'Volume level 0–100' },
            },
            required: ['level'],
        },
    },
    {
        name: 'tv_mute',
        description: 'Mute or unmute the Samsung TV.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                mute: { type: 'boolean', description: 'true to mute, false to unmute' },
            },
            required: ['mute'],
        },
    },
    {
        name: 'tv_set_input',
        description: 'Switch the Samsung TV input source. Use tv_get_status to see available inputs (id field).',
        inputSchema: {
            type: 'object' as const,
            properties: {
                source: { type: 'string', description: 'Input source id from tv_get_status (e.g. HDMI3, dtv)' },
            },
            required: ['source'],
        },
    },
    {
        name: 'tv_prepare_chromecast',
        description:
            'ALWAYS call this before playing anything on the Chromecast. ' +
            'Powers on the TV via Wake-on-LAN, waits for it to boot, then switches to the Chromecast input (HDMI3). ' +
            'Takes ~10–15s when TV is off. Instant if TV is already on.',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
    },
    {
        name: 'tv_launch_app',
        description: 'Launch an app on the Samsung TV by app ID (e.g. Netflix: 11101200001, YouTube: 111299001912, Prime Video: 3201910019365, Disney+: 3201901017640).',
        inputSchema: {
            type: 'object' as const,
            properties: {
                appId: { type: 'string', description: 'Samsung TV app ID' },
                appName: { type: 'string', description: 'Human-readable app name (for confirmation message)' },
            },
            required: ['appId'],
        },
    },
];
