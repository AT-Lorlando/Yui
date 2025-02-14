import * as fs from 'fs';

const entities = [
    'src/Entity/Light.ts',
    'src/Entity/Door.ts',
    'src/Entity/Tv.ts',
    'src/Entity/Speaker.ts',
];
for (const entity of entities) {
    const fileContent = fs.readFileSync(entity, 'utf-8');

    const regex = /\/\*\*([\s\S]*?)\*\/\s*async\s+(\w+)\(([\s\S]*?)\)/gm;
    let match;

    const docs = [];

    while ((match = regex.exec(fileContent)) !== null) {
        const fullComment = match[1];
        const methodName = match[2];
        const descriptionMatch = fullComment.match(/\*\s+(.*?)\r?\n/);
        const description = descriptionMatch ? descriptionMatch[1].trim() : '';

        const paramRegex = /@param\s+\{(\w+)\}\s+(\w+)\s*-\s*(.*)/g;
        let paramMatch;
        const properties = {};
        const required = [];

        while ((paramMatch = paramRegex.exec(fullComment)) !== null) {
            const paramType = paramMatch[1];
            const paramName = paramMatch[2];
            const paramDesc = paramMatch[3];
            properties[paramName] = {
                type: paramType,
                description: paramDesc,
            };
            required.push(paramName);
        }

        docs.push({
            name: methodName,
            description,
            parameters: {
                type: 'object',
                properties,
                required,
            },
        });
    }
    // Save it to a file
    fs.writeFileSync(
        entity
            .replace('src/Entity/', 'assets/prompts/docs/')
            .replace('.ts', '.json'),
        JSON.stringify(docs, null, 2),
    );
}
