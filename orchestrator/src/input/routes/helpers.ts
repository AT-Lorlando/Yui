// orchestrator/src/input/routes/helpers.ts
//
// L'auth Bearer était copiée-collée dans ~25 routes de HttpSource — une seule
// implémentation, utilisée en middleware de router ou de route.

export type AuthCheck = (bearer: string | undefined, ip: string) => boolean;

/** Middleware express : 401 si le Bearer n'est pas le bon. */
export function makeRequireAuth(check: AuthCheck) {
    return (req: any, res: any, next: any) => {
        const bearer = req.headers['authorization']?.split(' ')[1];
        if (!check(bearer, req.ip)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
    };
}

export type RequireAuth = ReturnType<typeof makeRequireAuth>;
