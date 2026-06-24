const STATE_ENUM = ['backlog', 'todo', 'in_progress', 'done', 'canceled'];
const PRIORITY_ENUM = ['none', 'low', 'medium', 'high', 'urgent'];

export const YOJI_TOOLS = [
    {
        name: 'list_notes',
        description: 'List all notes in the Yoji vault (path + title).',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
    },
    {
        name: 'get_note',
        description:
            'Get a note by its repo-relative path, with content, tags and backlinks.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                path: {
                    type: 'string',
                    description: 'Repo-relative .md path, e.g. inbox/idea.md',
                },
            },
            required: ['path'],
        },
    },
    {
        name: 'create_note',
        description:
            'Create a note. Path is a repo-relative .md path, not under todos/.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                path: {
                    type: 'string',
                    description: 'Repo-relative .md path, e.g. inbox/idea.md',
                },
                content: { type: 'string', description: 'Markdown content' },
            },
            required: ['path', 'content'],
        },
    },
    {
        name: 'update_note',
        description: "Overwrite a note's full content.",
        inputSchema: {
            type: 'object' as const,
            properties: {
                path: { type: 'string', description: 'Repo-relative .md path' },
                content: {
                    type: 'string',
                    description: 'New full markdown content',
                },
            },
            required: ['path', 'content'],
        },
    },
    {
        name: 'delete_note',
        description: 'Delete a note by path.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                path: { type: 'string', description: 'Repo-relative .md path' },
            },
            required: ['path'],
        },
    },
    {
        name: 'move_note',
        description: 'Rename or move a note or folder.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                from: {
                    type: 'string',
                    description: 'Current path, e.g. inbox/idea.md',
                },
                to: {
                    type: 'string',
                    description: 'New path, e.g. archive/idea.md',
                },
            },
            required: ['from', 'to'],
        },
    },
    {
        name: 'search_notes',
        description: 'Full-text search notes; returns matching path + title.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                query: { type: 'string', description: 'Search query' },
            },
            required: ['query'],
        },
    },
    {
        name: 'list_folders',
        description: 'List all folder paths in the vault.',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
    },
    {
        name: 'create_folder',
        description: 'Create a folder (repo-relative path, no leading slash).',
        inputSchema: {
            type: 'object' as const,
            properties: {
                path: {
                    type: 'string',
                    description: 'Folder path, e.g. projects/yoji',
                },
            },
            required: ['path'],
        },
    },
    {
        name: 'sync_vault',
        description:
            'Pull the remote vault and reindex. Use before reading if it may be stale.',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
    },
    {
        name: 'list_tasks',
        description: 'List tasks. Optionally filter by state or project.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                state: {
                    type: 'string',
                    enum: STATE_ENUM,
                    description: 'Filter by state',
                },
                project: {
                    type: 'string',
                    description: 'Filter by project folder, e.g. todos/Work',
                },
            },
            required: [],
        },
    },
    {
        name: 'create_task',
        description: 'Create a task.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                title: { type: 'string', description: 'Task title' },
                state: {
                    type: 'string',
                    enum: STATE_ENUM,
                    description: 'Initial state',
                },
                project: {
                    type: 'string',
                    description: 'Project folder under todos/, e.g. todos/Work',
                },
                parent: {
                    type: 'string',
                    description: 'Parent task id (root task only)',
                },
                description: {
                    type: 'string',
                    description: 'Task description',
                },
                priority: {
                    type: 'string',
                    enum: PRIORITY_ENUM,
                    description: 'Priority',
                },
            },
            required: ['title'],
        },
    },
    {
        name: 'update_task',
        description: "Update a task's title, state, description or priority.",
        inputSchema: {
            type: 'object' as const,
            properties: {
                id: { type: 'string', description: 'Task id' },
                title: { type: 'string', description: 'New title' },
                state: {
                    type: 'string',
                    enum: STATE_ENUM,
                    description: 'New state',
                },
                description: { type: 'string', description: 'New description' },
                priority: {
                    type: 'string',
                    enum: PRIORITY_ENUM,
                    description: 'New priority',
                },
            },
            required: ['id'],
        },
    },
    {
        name: 'delete_task',
        description: 'Delete a task (its subtasks are detached, not deleted).',
        inputSchema: {
            type: 'object' as const,
            properties: {
                id: { type: 'string', description: 'Task id' },
            },
            required: ['id'],
        },
    },
    {
        name: 'list_todo_projects',
        description: 'List all todo projects.',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
    },
    {
        name: 'create_todo_project',
        description: 'Create a todo project.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                name: {
                    type: 'string',
                    description: 'Project name, e.g. Work',
                },
                description: {
                    type: 'string',
                    description: 'Project description',
                },
            },
            required: ['name'],
        },
    },
    {
        name: 'delete_todo_project',
        description: 'Delete an empty project by its folder path.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                path: {
                    type: 'string',
                    description: 'Project folder path, e.g. todos/Work',
                },
            },
            required: ['path'],
        },
    },
];
