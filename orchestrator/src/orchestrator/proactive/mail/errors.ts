/** Id inconnu : les routes la traduisent en 404 (le reste des erreurs inattendues = 500). */
export class NotFoundError extends Error {}
/** Entrée refusée : les routes la traduisent en 400. */
export class BadRequestError extends Error {}
