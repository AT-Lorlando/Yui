export const OBSIDIAN_TOOLS = [
    {
        name: 'list_vaults',
        description: 'List all available Obsidian vaults (top-level folders in the vault root). Returns vault names you can use as the vault parameter in other tools.',
        inputSchema: {
            type: 'object' as const,
            properties: {},
            required: [],
        },
    },
    {
        name: 'get_tree',
        description: 'Get the folder/file tree of the vault or a subfolder. Useful to explore what notes and folders exist before reading or creating files. Paths are relative to the vault root (e.g. "Personal/Housing" or "Projects/Yui Homelab").',
        inputSchema: {
            type: 'object' as const,
            properties: {
                path: {
                    type: 'string',
                    description: 'Relative path to show (e.g. "Personal" or "Projects/Yui Homelab"). Omit to show the full vault root tree.',
                },
            },
            required: [],
        },
    },
    {
        name: 'read_note',
        description: 'Read the full markdown content of a note. Path is relative to vault root, e.g. "Personal/Housing/Loan.md" or "Projects/ParadiseIA/ParadiseIA.md".',
        inputSchema: {
            type: 'object' as const,
            properties: {
                path: {
                    type: 'string',
                    description: 'Relative path to the note (e.g. "Personal/Housing/Loan.md")',
                },
            },
            required: ['path'],
        },
    },
    {
        name: 'create_note',
        description: 'Create a new markdown note with optional initial content. Creates intermediate folders automatically. Fails if the note already exists (use update_note to overwrite).',
        inputSchema: {
            type: 'object' as const,
            properties: {
                path: {
                    type: 'string',
                    description: 'Relative path for the new note (e.g. "Personal/Ideas/My idea.md")',
                },
                content: {
                    type: 'string',
                    description: 'Initial markdown content for the note (default: empty)',
                },
            },
            required: ['path'],
        },
    },
    {
        name: 'update_note',
        description: 'Overwrite the full content of an existing note. Use this to rewrite a note from scratch. For adding content at the end, prefer append_to_note.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                path: {
                    type: 'string',
                    description: 'Relative path to the note',
                },
                content: {
                    type: 'string',
                    description: 'New full markdown content (replaces existing content)',
                },
            },
            required: ['path', 'content'],
        },
    },
    {
        name: 'append_to_note',
        description: 'Append text to the end of an existing note without overwriting it. Useful for adding daily log entries, tasks, or notes incrementally.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                path: {
                    type: 'string',
                    description: 'Relative path to the note',
                },
                text: {
                    type: 'string',
                    description: 'Text to append (markdown supported)',
                },
            },
            required: ['path', 'text'],
        },
    },
    {
        name: 'create_folder',
        description: 'Create a new folder (and any missing parent folders) in the vault.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                path: {
                    type: 'string',
                    description: 'Relative folder path to create (e.g. "Personal/2026/January")',
                },
            },
            required: ['path'],
        },
    },
    {
        name: 'move_note',
        description: 'Move or rename a note or folder. Can be used to rename ("Personal/Old name.md" → "Personal/New name.md") or to reorganise ("Personal/note.md" → "Projects/note.md").',
        inputSchema: {
            type: 'object' as const,
            properties: {
                from: {
                    type: 'string',
                    description: 'Current relative path of the note or folder',
                },
                to: {
                    type: 'string',
                    description: 'New relative path (destination must not already exist)',
                },
            },
            required: ['from', 'to'],
        },
    },
    {
        name: 'delete_note',
        description: 'Permanently delete a note file. Cannot be undone. Does not delete folders — only individual .md files.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                path: {
                    type: 'string',
                    description: 'Relative path to the note to delete',
                },
            },
            required: ['path'],
        },
    },
    {
        name: 'search_notes',
        description: 'Search notes by keyword. By default searches both note titles and their content. Optionally restrict to a specific vault.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                query: {
                    type: 'string',
                    description: 'Keyword or phrase to search for',
                },
                vault: {
                    type: 'string',
                    description: 'Restrict search to a specific vault (e.g. "Personal", "Projects"). Omit to search all vaults.',
                },
                search_content: {
                    type: 'boolean',
                    description: 'Whether to search note content in addition to titles (default: true)',
                },
                limit: {
                    type: 'number',
                    description: 'Max number of results (default: 20)',
                },
            },
            required: ['query'],
        },
    },
];
