"""
justwatch.py — Encapsule l'accès à l'API JustWatch (non documentée).

Expose :
  find_on_service(title, service) -> (content_id|None, full_title|None)
  find_any(title, preference)     -> (service|None, content_id|None, full_title|None)

Découpage testable : _search (HTTP) + parse_for_service / parse_any (purs).
"""

import re
import sys

import requests

_API = 'https://apis.justwatch.com/graphql'

# service → technicalName(s) JustWatch (les variantes "withads" comptent aussi).
_PROVIDER_TECH = {
    'netflix':     {'netflix', 'netflixbasicwithads'},
    'crunchyroll': {'crunchyroll'},
    'disney':      {'disneyplus'},
    'prime':       {'amazonprimevideo', 'amazonprimevideowithads'},
}
_SERVICE_BY_TECH = {
    tech: svc for svc, techs in _PROVIDER_TECH.items() for tech in techs
}

SUPPORTED_SERVICES = list(_PROVIDER_TECH.keys())

# Extraction du content ID depuis standardWebURL.
_NETFLIX_ID = re.compile(r'netflix\.com/(?:title|watch)/(\d+)')
_CRUNCHY_ID = re.compile(r'crunchyroll\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?(series|watch)/([A-Z0-9]+)', re.I)
_DISNEY_ID = re.compile(r'disneyplus\.com/(?:[^/?#]+/){1,3}([^/?&#]+)')


def _extract_id(service: str, url: str) -> str | None:
    """Content id utilisable par le lanceur du service.

    Netflix/Crunchyroll/Disney : id court (deep-link DIAL `v=<id>`).
    Prime : l'URL complète — la Google TV n'expose pas Prime en DIAL, on lance
    le deep-link tel quel via Android TV Remote (app link).
    """
    if not url:
        return None
    if service == 'netflix':
        m = _NETFLIX_ID.search(url)
        return m.group(1) if m else None
    if service == 'crunchyroll':
        # JustWatch rend tantôt la série (/series/<id>), tantôt un épisode
        # (/watch/<id>). L'app Android TV les ouvre par des routes
        # différentes : on garde la nature (`episode/<id>`), le cast DIAL ne
        # prend que l'id (cf. cast.py).
        m = _CRUNCHY_ID.search(url)
        if not m:
            return None
        kind, cid = m.group(1).lower(), m.group(2)
        return cid if kind == 'series' else f'episode/{cid}'
    if service == 'disney':
        m = _DISNEY_ID.search(url)
        return m.group(1) if m else None
    if service == 'prime':
        return url
    return None

# JustWatch refuse les requêtes sans User-Agent (403) ; schéma popularTitles + filter.
_HEADERS = {
    'Content-Type': 'application/json',
    'User-Agent': (
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/120.0 Safari/537.36'
    ),
}

# Sans le filtre monetizationTypes, JustWatch renvoie désormais offers: [] —
# c'est ce qui avait cassé tous les deep-links (schéma changé ~août 2026).
_QUERY = '''
query GetSearchTitles($searchTitlesFilter: TitleFilter!, $country: Country!, $language: Language!, $first: Int!) {
  popularTitles(country: $country, filter: $searchTitlesFilter, first: $first) {
    edges {
      node {
        ... on MovieOrShow {
          objectType
          content(country: $country, language: $language) {
            title
            originalReleaseYear
          }
          offers(country: $country, platform: WEB, filter: { monetizationTypes: [FLATRATE] }) {
            standardWebURL
            package { technicalName }
          }
        }
      }
    }
  }
}
'''


def _variables(title: str, first: int = 4) -> dict:
    return {
        'searchTitlesFilter': {'searchQuery': title},
        'country': 'FR',
        'language': 'fr',
        'first': first,
    }


def _search(title: str, first: int = 4) -> list:
    """Interroge JustWatch et renvoie la liste d'edges, ou [] en cas d'erreur."""
    try:
        resp = requests.post(
            _API,
            json={'query': _QUERY, 'variables': _variables(title, first)},
            headers=_HEADERS,
            timeout=10,
        )
        resp.raise_for_status()
        return (
            resp.json().get('data', {}).get('popularTitles', {}).get('edges', [])
        )
    except Exception as exc:
        print(f'[justwatch] API error: {exc}', file=sys.stderr)
        return []


def parse_for_service(edges: list, service: str, title: str) -> tuple[str | None, str | None]:
    """(content_id, full_title) pour *service*, ou (None, None). Pur."""
    techs = _PROVIDER_TECH.get(service)
    if not techs or not edges:
        return None, None

    target = (edges[0].get('node', {}).get('content', {}).get('title') or title).strip().lower()
    for edge in edges:
        node = edge.get('node', {})
        node_title = node.get('content', {}).get('title', title)
        if node_title.strip().lower() != target:
            continue
        for offer in node.get('offers', []) or []:
            if offer.get('package', {}).get('technicalName') not in techs:
                continue
            cid = _extract_id(service, offer.get('standardWebURL', ''))
            if cid:
                return cid, node_title
    return None, None


def parse_any(edges: list, preference: list, title: str) -> tuple[str | None, str | None, str | None]:
    """(service, content_id, full_title) pour le provider le plus prioritaire. Pur."""
    if not edges:
        return None, None, None

    target = (edges[0].get('node', {}).get('content', {}).get('title') or title).strip().lower()
    found: dict[str, tuple[str, str]] = {}  # service -> (id, full_title)
    for edge in edges:
        node = edge.get('node', {})
        node_title = node.get('content', {}).get('title', title)
        if node_title.strip().lower() != target:
            continue
        for offer in node.get('offers', []) or []:
            tech = offer.get('package', {}).get('technicalName')
            service = _SERVICE_BY_TECH.get(tech)
            if not service or service in found:
                continue
            cid = _extract_id(service, offer.get('standardWebURL', ''))
            if cid:
                found[service] = (cid, node_title)

    for service in preference:
        if service in found:
            cid, ft = found[service]
            return service, cid, ft
    return None, None, None


def parse_all(edges: list) -> list[dict]:
    """Tous les couples (titre, plateforme) exploitables, pour un choix dans
    l'app : [{service, id, title, year, type}], dédoublonnés par (service, id),
    dans l'ordre de pertinence JustWatch. Pur."""
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for edge in edges or []:
        node = edge.get('node', {}) or {}
        content = node.get('content', {}) or {}
        node_title = (content.get('title') or '').strip()
        if not node_title:
            continue
        year = content.get('originalReleaseYear')
        kind = 'movie' if node.get('objectType') == 'MOVIE' else 'show'
        for offer in node.get('offers', []) or []:
            tech = (offer.get('package', {}) or {}).get('technicalName')
            service = _SERVICE_BY_TECH.get(tech)
            if not service:
                continue
            cid = _extract_id(service, offer.get('standardWebURL', ''))
            if not cid or (service, cid) in seen:
                continue
            seen.add((service, cid))
            out.append({
                'service': service,
                'id': cid,
                'title': node_title,
                'year': year,
                'type': kind,
            })
    return out


def search_all(title: str, first: int = 8) -> list[dict]:
    return parse_all(_search(title, first))


def find_on_service(title: str, service: str) -> tuple[str | None, str | None]:
    return parse_for_service(_search(title), service, title)


def find_any(title: str, preference: list) -> tuple[str | None, str | None, str | None]:
    return parse_any(_search(title), preference, title)
