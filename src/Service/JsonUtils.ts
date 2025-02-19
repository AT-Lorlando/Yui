export function removeJsonComments(jsonString: string): string {
    // Regex to match single-line comments (//) and multi-line comments (/* */)
    // const regex = /\/\/.*|\/\*[\s\S]*?\*\//g;
    // return jsonString.replace(regex, '');
    return jsonString.replace('```json', '').replace('```', '');
}
