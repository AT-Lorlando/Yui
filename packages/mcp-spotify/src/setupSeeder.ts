// `npm run setup:seeder` (racine ou package) — OAuth librespot en deux temps :
//   1. sans argument : affiche l'URL à ouvrir (depuis n'importe quel appareil
//      connecté au compte Spotify) et garde le verifier PKCE dans un fichier
//      temporaire ;
//   2. `-- --code '<URL de retour collée>'` : échange le code, écrit
//      data/shared/librespot/seeder-token.json.
// Un serveur local sur 127.0.0.1:5588 est aussi ouvert à l'étape 1 : si le
// navigateur tourne sur cette machine, le retour est capté automatiquement.
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import http from 'http';
import { resolve } from 'path';
import {
    buildAuthUrl,
    codeFromInput,
    exchangeCode,
    pkcePair,
    saveSeederToken,
    seederTokenFile,
} from './seederAuth';

// `npm run … -w` donne un cwd = package : on ancre .env et data/ sur la
// racine du dépôt (sinon le token atterrit dans packages/mcp-spotify/data/,
// invisible pour le serveur — vécu le 24/09 sur prod).
const PROJECT_ROOT = resolve(__dirname, '../../..');
dotenv.config({ path: resolve(PROJECT_ROOT, '.env') });
process.env.YUI_DATA_DIR ??= resolve(PROJECT_ROOT, 'data');

const PENDING = path.join(os.tmpdir(), 'yui-seeder-pkce.json');
const out = (s: string) => process.stdout.write(s + '\n');

async function finish(codeInput: string, verifier: string): Promise<void> {
    const code = codeFromInput(codeInput);
    const token = await exchangeCode(code, verifier);
    saveSeederToken(token);
    try {
        fs.unlinkSync(PENDING);
    } catch {
        /* déjà absent */
    }
    out(`✓ Token librespot enregistré : ${seederTokenFile()}`);
    out(
        '  Le streamer (Google Home & co) démarre désormais avec un token frais.',
    );
}

async function main(): Promise<void> {
    const i = process.argv.indexOf('--code');
    if (i >= 0) {
        const codeInput = process.argv[i + 1];
        if (!codeInput)
            throw new Error('--code attend l’URL de retour (ou le code)');
        const pending = JSON.parse(fs.readFileSync(PENDING, 'utf8'));
        await finish(codeInput, pending.verifier);
        return;
    }

    const { verifier, challenge } = pkcePair();
    const state = pkcePair().verifier.slice(0, 16);
    fs.writeFileSync(PENDING, JSON.stringify({ verifier, state }), {
        mode: 0o600,
    });
    const url = buildAuthUrl(challenge, state);
    out(
        'Ouvre cette URL (n’importe quel appareil connecté au compte Spotify) :\n',
    );
    out(url + '\n');
    out('Puis colle ici l’URL sur laquelle tu atterris (elle commence par');
    out(`http://127.0.0.1:5588/login?code=…) :`);
    out("  npm run setup:seeder -- --code '<URL collée>'\n");

    // Capture automatique si le navigateur est sur cette machine.
    const server = http.createServer(async (req, res) => {
        const u = new URL(req.url ?? '/', 'http://127.0.0.1:5588');
        const code = u.searchParams.get('code');
        if (u.pathname !== '/login' || !code) {
            res.writeHead(404).end();
            return;
        }
        try {
            await finish(code, verifier);
            res.writeHead(200, { 'Content-Type': 'text/plain' }).end(
                'Yui : seeder autorisé, tu peux fermer cet onglet.',
            );
        } catch (e) {
            res.writeHead(500).end(String(e));
        } finally {
            server.close();
            process.exit(0);
        }
    });
    server.on('error', () => {
        /* port pris ou indisponible : le collage manuel reste possible */
    });
    server.listen(5588, '127.0.0.1');
    out(
        '(en attente du retour sur 127.0.0.1:5588 — Ctrl+C pour coller plus tard)',
    );
}

main().catch((e) => {
    process.stderr.write(
        `setup:seeder — ${e instanceof Error ? e.message : e}\n`,
    );
    process.exit(1);
});
