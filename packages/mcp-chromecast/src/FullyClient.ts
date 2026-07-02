import Logger from './logger';

/**
 * FullyClient — pilote Fully Kiosk Browser via son Remote Admin REST API (port 2323).
 *
 * Sert à afficher le tableau de bord (dashboard) sur la TV : Fully Kiosk tourne
 * sur le Chromecast Google TV 4K et sait, lui, rendre une page web interactive
 * (ce que le Default Media Receiver d'un Chromecast ne peut pas faire).
 *
 * Config (env) :
 *   FULLY_IP        — IP LAN de l'appareil sous Fully Kiosk (obligatoire)
 *   FULLY_PORT      — port Remote Admin (défaut 2323)
 *   FULLY_PASSWORD  — Remote Admin Password configuré dans Fully
 *   DASHBOARD_URL   — URL du dashboard (défaut http://<HOST>:3000/dashboard)
 */

const FULLY_IP = process.env.FULLY_IP ?? '';
const FULLY_PORT = process.env.FULLY_PORT ?? '2323';
const FULLY_PASSWORD = process.env.FULLY_PASSWORD ?? '';

const DASHBOARD_URL =
    process.env.DASHBOARD_URL ??
    `http://${process.env.HOST ?? 'localhost'}:3000/dashboard`;

const REQUEST_TIMEOUT_MS = 8000;

/**
 * Construit l'URL d'une commande Fully Remote Admin.
 * Forme : http://<ip>:<port>/?cmd=<cmd>&<params…>&type=json&password=<pwd>
 * Pure et déterministe → testable sans réseau.
 */
export function buildFullyUrl(
    ip: string,
    port: string,
    cmd: string,
    password: string,
    params: Record<string, string> = {},
): string {
    const u = new URL(`http://${ip}:${port}/`);
    u.searchParams.set('cmd', cmd);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set('type', 'json');
    if (password) u.searchParams.set('password', password);
    return u.toString();
}

type FetchFn = (
    url: string,
    init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export class FullyClient {
    constructor(
        private ip: string = FULLY_IP,
        private port: string = FULLY_PORT,
        private password: string = FULLY_PASSWORD,
        private fetchFn: FetchFn = fetch as unknown as FetchFn,
    ) {}

    /** Envoie une commande Remote Admin et renvoie la réponse parsée (ou texte brut). */
    private async cmd(
        cmd: string,
        params: Record<string, string> = {},
    ): Promise<unknown> {
        if (!this.ip) {
            throw new Error(
                "FULLY_IP non configuré — renseigne l'IP LAN du Chromecast Google TV sous Fully Kiosk.",
            );
        }
        const url = buildFullyUrl(
            this.ip,
            this.port,
            cmd,
            this.password,
            params,
        );

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const resp = await this.fetchFn(url, { signal: controller.signal });
            const body = await resp.text();
            if (!resp.ok) {
                throw new Error(`Fully ${cmd}: HTTP ${resp.status}`);
            }
            let data: unknown = body;
            try {
                data = JSON.parse(body);
            } catch {
                /* certaines réponses ne sont pas du JSON — on garde le texte */
            }
            // type=json : une erreur (ex. mauvais mot de passe) renvoie
            // { status: "Error", statustext: "…" } avec un HTTP 200.
            if (
                data &&
                typeof data === 'object' &&
                (data as Record<string, unknown>).status === 'Error'
            ) {
                const st =
                    (data as Record<string, unknown>).statustext ??
                    'erreur Fully';
                throw new Error(`Fully ${cmd}: ${st}`);
            }
            return data;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Affiche le dashboard sur l'écran Fully Kiosk :
     * réveille l'écran → met Fully au premier plan → charge l'URL.
     */
    async castDashboard(url: string = DASHBOARD_URL): Promise<string> {
        Logger.info(`Fully: cast dashboard → ${url}`);
        await this.cmd('screenOn');
        await this.cmd('toForeground');
        await this.cmd('loadURL', { url });
        return `Tableau de bord affiché sur Fully Kiosk (${url}).`;
    }
}
