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

# service → shortName JustWatch
_PROVIDER = {
    'netflix':     'nfx',
    'crunchyroll': 'cru',
    'disney':      'dnp',
    'prime':       'amp',
}
_SERVICE_BY_SHORT = {v: k for k, v in _PROVIDER.items()}

SUPPORTED_SERVICES = list(_PROVIDER.keys())

# Extraction du content ID depuis l'URL de chaque provider.
_ID_PATTERN = {
    'nfx': re.compile(r'netflix\.com/(?:title|watch)/(\d+)'),
    'cru': re.compile(r'crunchyroll\.com/(?:series|watch)/([A-Z0-9]+)', re.I),
    'dnp': re.compile(r'disneyplus\.com/(?:[^/?#]+/){1,3}([^/?&#]+)'),
    'amp': re.compile(r'(?:primevideo|amazon)\.com/(?:dp|detail)/([A-Z0-9]+)', re.I),
}

# JustWatch refuse les requêtes sans User-Agent (403) ; schéma popularTitles + filter.
_HEADERS = {
    'Content-Type': 'application/json',
    'User-Agent': (
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/120.0 Safari/537.36'
    ),
}

_QUERY = '''
query GetSearchTitles($searchTitlesFilter: TitleFilter!, $country: Country!, $language: Language!, $first: Int!) {
  popularTitles(country: $country, filter: $searchTitlesFilter, first: $first) {
    edges {
      node {
        ... on MovieOrShow {
          objectType
          content(country: $country, language: $language) {
            title
          }
          offers(country: $country, platform: WEB) {
            standardWebURL
            package { shortName }
          }
        }
      }
    }
  }
}
'''


def _variables(title: str) -> dict:
    return {
        'searchTitlesFilter': {'searchQuery': title},
        'country': 'FR',
        'language': 'fr',
        'first': 4,
    }


def _search(title: str) -> list:
    """Interroge JustWatch et renvoie la liste d'edges, ou [] en cas d'erreur."""
    try:
        resp = requests.post(
            _API,
            json={'query': _QUERY, 'variables': _variables(title)},
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
    provider = _PROVIDER.get(service)
    if not provider or not edges:
        return None, None

    target = (edges[0].get('node', {}).get('content', {}).get('title') or title).strip().lower()
    pattern = _ID_PATTERN.get(provider)
    for edge in edges:
        node = edge.get('node', {})
        node_title = node.get('content', {}).get('title', title)
        if node_title.strip().lower() != target:
            continue
        for offer in node.get('offers', []):
            if offer.get('package', {}).get('shortName') != provider:
                continue
            m = pattern.search(offer.get('standardWebURL', '')) if pattern else None
            if m:
                return m.group(1), node_title
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
        for offer in node.get('offers', []):
            short = offer.get('package', {}).get('shortName')
            service = _SERVICE_BY_SHORT.get(short)
            if not service or service in found:
                continue
            pattern = _ID_PATTERN.get(short)
            m = pattern.search(offer.get('standardWebURL', '')) if pattern else None
            if m:
                found[service] = (m.group(1), node_title)

    for service in preference:
        if service in found:
            cid, ft = found[service]
            return service, cid, ft
    return None, None, None


def find_on_service(title: str, service: str) -> tuple[str | None, str | None]:
    return parse_for_service(_search(title), service, title)


def find_any(title: str, preference: list) -> tuple[str | None, str | None, str | None]:
    return parse_any(_search(title), preference, title)
