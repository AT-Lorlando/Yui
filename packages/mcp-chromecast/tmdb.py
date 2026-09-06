"""
tmdb.py — Repli TMDB (API officielle, stable) quand JustWatch casse.

TMDB ne fournit PAS les content ids des plateformes (pas de deep-link),
mais son endpoint watch/providers dit de façon fiable OÙ un titre est
regardable. Quand JustWatch (API non documentée, déjà cassée une fois en
août 2026) ne répond plus, on retombe ici : l'app de la bonne plateforme
s'ouvre, sans deep-link — dégradé mais jamais muet.

Nécessite TMDB_API_KEY (gratuite, themoviedb.org → Settings → API).
Sans clé, le module est inactif.

Découpage testable : parse_* purs, _get (HTTP) isolé.
"""
import os
import sys

import requests

_API = 'https://api.themoviedb.org/3'
_KEY = os.getenv('TMDB_API_KEY', '')

# provider_name TMDB (minuscule, contient) → service Yui.
_PROVIDER_NAMES = [
    ('crunchyroll', 'crunchyroll'),
    ('netflix', 'netflix'),
    ('disney', 'disney'),
    ('amazon prime', 'prime'),
]


def parse_search_pick(results: list) -> dict | None:
    """Premier résultat film/série d'une recherche multi. Pur."""
    for r in results or []:
        if r.get('media_type') in ('tv', 'movie'):
            return r
    return None


def parse_providers(fr_block: dict, preference: list) -> str | None:
    """Bloc FR de watch/providers → service Yui préféré. Pur."""
    names: list[str] = []
    for kind in ('flatrate', 'ads'):
        for p in fr_block.get(kind) or []:
            names.append((p.get('provider_name') or '').lower())
    found: set[str] = set()
    for needle, service in _PROVIDER_NAMES:
        if any(needle in n for n in names):
            found.add(service)
    for service in preference:
        if service in found:
            return service
    return None


def _get(path: str, params: dict) -> dict:
    resp = requests.get(
        f'{_API}{path}',
        params={'api_key': _KEY, **params},
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()


def find_platform(title: str, preference: list) -> tuple[str | None, str | None]:
    """(service, full_title) pour *title*, ou (None, None).

    Plateforme seulement — pas de content id (l'app s'ouvrira sans deep-link).
    """
    if not _KEY:
        return None, None
    try:
        results = _get(
            '/search/multi', {'query': title, 'language': 'fr-FR'}
        ).get('results', [])
        pick = parse_search_pick(results)
        if not pick:
            return None, None
        media, mid = pick['media_type'], pick['id']
        full_title = pick.get('name') or pick.get('title') or title
        fr = (
            _get(f'/{media}/{mid}/watch/providers', {})
            .get('results', {})
            .get('FR', {})
        )
        service = parse_providers(fr, preference)
        return (service, full_title) if service else (None, None)
    except Exception as exc:
        print(f'[tmdb] error: {exc}', file=sys.stderr)
        return None, None
