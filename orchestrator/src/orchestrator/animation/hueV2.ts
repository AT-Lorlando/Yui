// orchestrator/src/orchestrator/animation/hueV2.ts
import https from 'https';

/** Single Hue v2 REST call (self-signed cert tolerated). key = HUE_USERNAME. */
export function hueRequest(
    host: string,
    key: string,
    path: string,
    method: 'GET' | 'PUT' | 'POST' = 'GET',
    body?: unknown,
): Promise<any> {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : undefined;
        const req = https.request(
            {
                host,
                path,
                method,
                rejectUnauthorized: false,
                headers: {
                    'hue-application-key': key,
                    Accept: 'application/json',
                    ...(data && {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(data),
                    }),
                },
            },
            (res) => {
                let buf = '';
                res.on('data', (c) => (buf += c));
                res.on('end', () => {
                    try {
                        resolve(buf ? JSON.parse(buf) : {});
                    } catch (e) {
                        reject(e);
                    }
                });
            },
        );
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}
