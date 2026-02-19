export const LINEAR_TOOLS = [
    {
        name: 'list_issues',
        description: 'List issues in the Koya team. Optionally filter by status or project.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                status: { type: 'string', description: 'Filter by status: backlog, todo, in progress, done, canceled' },
                projectId: { type: 'string', description: 'Filter by project ID' },
                limit: { type: 'number', description: 'Max results (default 50)' },
            },
            required: [],
        },
    },
    {
        name: 'get_issue',
        description: 'Get full details of an issue including comments. Use identifier like KOY-42 or internal ID.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                id: { type: 'string', description: 'Issue identifier (e.g. KOY-42) or internal ID' },
            },
            required: ['id'],
        },
    },
    {
        name: 'create_issue',
        description: 'Create a new issue in the Koya team.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                title: { type: 'string', description: 'Issue title' },
                description: { type: 'string', description: 'Issue description (markdown supported)' },
                status: { type: 'string', description: 'Initial status: backlog, todo, in progress, done, canceled' },
                projectId: { type: 'string', description: 'Project ID to assign the issue to' },
            },
            required: ['title'],
        },
    },
    {
        name: 'update_issue',
        description: 'Update an issue title, description, or status.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                id: { type: 'string', description: 'Issue identifier (e.g. KOY-42) or internal ID' },
                title: { type: 'string', description: 'New title' },
                description: { type: 'string', description: 'New description' },
                status: { type: 'string', description: 'New status: backlog, todo, in progress, done, canceled' },
            },
            required: ['id'],
        },
    },
    {
        name: 'add_comment',
        description: 'Add a comment to an issue.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                id: { type: 'string', description: 'Issue identifier (e.g. KOY-42) or internal ID' },
                body: { type: 'string', description: 'Comment text (markdown supported)' },
            },
            required: ['id', 'body'],
        },
    },
    {
        name: 'list_projects',
        description: 'List all projects in the Koya team.',
        inputSchema: {
            type: 'object' as const,
            properties: {},
            required: [],
        },
    },
    {
        name: 'create_project',
        description: 'Create a new project in the Koya team.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                name: { type: 'string', description: 'Project name' },
                description: { type: 'string', description: 'Project description' },
            },
            required: ['name'],
        },
    },
    {
        name: 'search_issues',
        description: 'Search issues by keyword in the Koya team.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                query: { type: 'string', description: 'Search query' },
                limit: { type: 'number', description: 'Max results (default 20)' },
            },
            required: ['query'],
        },
    },
];
