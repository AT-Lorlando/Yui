export const BROWSER_TOOLS = [
    {
        name: 'open_browser',
        description: 'Open a Chromium browser window and navigate to a URL',
        inputSchema: {
            type: 'object' as const,
            properties: {
                url: {
                    type: 'string',
                    description: 'The URL to navigate to after opening the browser',
                },
            },
            required: ['url'],
        },
    },
    {
        name: 'get_page_content',
        description: 'Get the text content of the current browser page',
        inputSchema: {
            type: 'object' as const,
            properties: {},
            required: [],
        },
    },
    {
        name: 'click_element',
        description: 'Click on an element in the current page by CSS selector',
        inputSchema: {
            type: 'object' as const,
            properties: {
                selector: {
                    type: 'string',
                    description: 'CSS selector of the element to click',
                },
            },
            required: ['selector'],
        },
    },
    {
        name: 'fill_input',
        description:
            'Fill an input field with a value and submit it (press Enter)',
        inputSchema: {
            type: 'object' as const,
            properties: {
                selector: {
                    type: 'string',
                    description: 'CSS selector of the input field',
                },
                value: {
                    type: 'string',
                    description: 'The value to fill into the input',
                },
            },
            required: ['selector', 'value'],
        },
    },
    {
        name: 'close_browser',
        description: 'Close the browser window',
        inputSchema: {
            type: 'object' as const,
            properties: {},
            required: [],
        },
    },
];
