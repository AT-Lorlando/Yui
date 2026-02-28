export const GMAIL_TOOLS = [
    {
        name: 'list_emails',
        description: 'List recent emails in the inbox. Returns sender, subject, date, snippet and read status.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                maxResults: {
                    type: 'number',
                    description: 'Max number of emails to return (default 20, max 50)',
                },
                query: {
                    type: 'string',
                    description: 'Optional Gmail query to filter (e.g. "is:unread", "from:alice@example.com")',
                },
                labelIds: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Filter by label IDs (default: ["INBOX"])',
                },
            },
            required: [],
        },
    },
    {
        name: 'get_email',
        description: 'Get the full content of an email by its message ID, including decoded body.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                messageId: {
                    type: 'string',
                    description: 'Gmail message ID',
                },
            },
            required: ['messageId'],
        },
    },
    {
        name: 'search_emails',
        description: 'Search emails using Gmail query syntax. Examples: "from:alice subject:invoice", "is:unread after:2026/01/01".',
        inputSchema: {
            type: 'object' as const,
            properties: {
                query: {
                    type: 'string',
                    description: 'Gmail search query (same syntax as the Gmail search bar)',
                },
                maxResults: {
                    type: 'number',
                    description: 'Max results (default 20)',
                },
            },
            required: ['query'],
        },
    },
    {
        name: 'send_email',
        description: 'Send a new email.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                to: {
                    type: 'string',
                    description: 'Recipient email address(es), comma-separated',
                },
                subject: {
                    type: 'string',
                    description: 'Email subject',
                },
                body: {
                    type: 'string',
                    description: 'Email body (plain text)',
                },
                cc: {
                    type: 'string',
                    description: 'CC email address(es), comma-separated',
                },
            },
            required: ['to', 'subject', 'body'],
        },
    },
    {
        name: 'reply_email',
        description: 'Reply to an existing email thread.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                messageId: {
                    type: 'string',
                    description: 'ID of the message to reply to',
                },
                body: {
                    type: 'string',
                    description: 'Reply body (plain text)',
                },
            },
            required: ['messageId', 'body'],
        },
    },
    {
        name: 'create_draft',
        description: 'Save an email as a draft (not sent).',
        inputSchema: {
            type: 'object' as const,
            properties: {
                to: {
                    type: 'string',
                    description: 'Recipient email address(es)',
                },
                subject: {
                    type: 'string',
                    description: 'Email subject',
                },
                body: {
                    type: 'string',
                    description: 'Email body (plain text)',
                },
            },
            required: ['to', 'subject', 'body'],
        },
    },
    {
        name: 'trash_email',
        description: 'Move an email to trash.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                messageId: {
                    type: 'string',
                    description: 'Gmail message ID',
                },
            },
            required: ['messageId'],
        },
    },
    {
        name: 'archive_email',
        description: 'Archive an email (remove from INBOX, keep in All Mail).',
        inputSchema: {
            type: 'object' as const,
            properties: {
                messageId: {
                    type: 'string',
                    description: 'Gmail message ID',
                },
            },
            required: ['messageId'],
        },
    },
    {
        name: 'mark_read',
        description: 'Mark an email as read.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                messageId: {
                    type: 'string',
                    description: 'Gmail message ID',
                },
            },
            required: ['messageId'],
        },
    },
    {
        name: 'mark_unread',
        description: 'Mark an email as unread.',
        inputSchema: {
            type: 'object' as const,
            properties: {
                messageId: {
                    type: 'string',
                    description: 'Gmail message ID',
                },
            },
            required: ['messageId'],
        },
    },
    {
        name: 'list_labels',
        description: 'List all Gmail labels (inbox, sent, drafts, custom labels, etc.).',
        inputSchema: {
            type: 'object' as const,
            properties: {},
            required: [],
        },
    },
];
