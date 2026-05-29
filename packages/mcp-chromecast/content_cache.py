"""
content_cache.py — Local cache of streaming content IDs.

Cache file: data/chromecast-content.json (project root)

Structure:
{
  "netflix":     { "breaking bad": { "id": "70143836", "title": "Breaking Bad" } },
  "crunchyroll": { "attack on titan": { "id": "G914U3V24", "title": "Attack on Titan" } },
  "youtube":     { "lofi hip hop": { "id": "jfKfPfyJRdk", "title": "lofi hip hop radio" } }
}

On cache miss:
  - Netflix / Disney+ / Prime / Crunchyroll → JustWatch GraphQL API
  - YouTube → yt-dlp ytsearch1:
"""

import json
import os
import re
import subprocess
import sys

import requests

# ── Paths ─────────────────────────────────────────────────────────────────────

_HERE = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.abspath(os.path.join(_HERE, '..', '..'))
CACHE_FILE = os.path.join(_PROJECT_ROOT, 'data', 'chromecast-content.json')

# ── JustWatch config ──────────────────────────────────────────────────────────

_JW_API = 'https://apis.justwatch.com/graphql'

# JustWatch provider short names
_PROVIDER = {
    'netflix':     'nfx',
    'crunchyroll': 'cru',
    'disney':      'dnp',
    'prime':       'amp',
}

# Regex to extract content ID from each service's URL
_ID_PATTERN = {
    'nfx': re.compile(r'netflix\.com/(?:title|watch)/(\d+)'),
    'cru': re.compile(r'crunchyroll\.com/(?:series|watch)/([A-Z0-9]+)', re.I),
    'dnp': re.compile(r'disneyplus\.com/(?:[^/?#]+/){1,3}([^/?&#]+)'),
    'amp': re.compile(r'(?:primevideo|amazon)\.com/(?:dp|detail)/([A-Z0-9]+)', re.I),
}

_SERVICE_BY_SHORT = {'nfx': 'netflix', 'cru': 'crunchyroll', 'dnp': 'disney', 'amp': 'prime'}

# Ordre de préférence quand un titre est dispo sur plusieurs plateformes.
PROVIDER_PREFERENCE = ['crunchyroll', 'netflix', 'disney', 'prime']

# JustWatch refuse les requêtes sans User-Agent (403) et a changé son schéma
# GraphQL (popularTitles + filter, country/language en variables).
_JW_HEADERS = {
    'Content-Type': 'application/json',
    'User-Agent': (
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/120.0 Safari/537.36'
    ),
}

_JW_QUERY = '''
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


def _jw_variables(title: str) -> dict:
    return {
        'searchTitlesFilter': {'searchQuery': title},
        'country': 'FR',
        'language': 'fr',
        'first': 4,
    }

# ── YouTube URL / ID patterns ─────────────────────────────────────────────────

_YT_ID_RE  = re.compile(r'^[a-zA-Z0-9_-]{11}$')
_YT_URL_RE = re.compile(
    r'(?:youtube\.com/(?:watch\?v=|shorts/|embed/)|youtu\.be/)'
    r'([a-zA-Z0-9_-]{11})'
)

# ── Cache I/O ─────────────────────────────────────────────────────────────────

def _load() -> dict:
    try:
        with open(CACHE_FILE, encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save(cache: dict) -> None:
    os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
    with open(CACHE_FILE, 'w', encoding='utf-8') as f:
        json.dump(cache, f, indent=2, ensure_ascii=False)


def _key(title: str) -> str:
    return title.lower().strip()


def _get(service: str, title: str) -> dict | None:
    return _load().get(service, {}).get(_key(title))


def _put(service: str, title: str, content_id: str, full_title: str) -> None:
    cache = _load()
    cache.setdefault(service, {})[_key(title)] = {
        'id': content_id,
        'title': full_title or title,
    }
    _save(cache)

# ── JustWatch lookup ──────────────────────────────────────────────────────────

def _justwatch(service: str, title: str) -> tuple[str | None, str | None]:
    provider = _PROVIDER.get(service)
    if not provider:
        return None, None

    try:
        resp = requests.post(
            _JW_API,
            json={'query': _JW_QUERY, 'variables': _jw_variables(title)},
            headers=_JW_HEADERS,
            timeout=10,
        )
        resp.raise_for_status()
        edges = (
            resp.json()
            .get('data', {})
            .get('popularTitles', {})
            .get('edges', [])
        )
    except Exception as exc:
        print(f'[justwatch] API error: {exc}', file=sys.stderr)
        return None, None

    if not edges:
        return None, None

    # La recherche peut renvoyer des spin-offs/films au même titre approchant ;
    # on se limite aux edges qui portent exactement le titre du meilleur résultat.
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
            url = offer.get('standardWebURL', '')
            if pattern:
                m = pattern.search(url)
                if m:
                    return m.group(1), node_title

    return None, None


def _justwatch_any(title: str) -> tuple[str | None, str | None, str | None]:
    """
    Cherche un titre sur JustWatch sans filtre de provider.
    Renvoie (service, content_id, full_title) pour le provider supporté
    le plus prioritaire (PROVIDER_PREFERENCE), ou (None, None, None).
    """
    try:
        resp = requests.post(
            _JW_API,
            json={'query': _JW_QUERY, 'variables': _jw_variables(title)},
            headers=_JW_HEADERS,
            timeout=10,
        )
        resp.raise_for_status()
        edges = (
            resp.json().get('data', {}).get('popularTitles', {}).get('edges', [])
        )
    except Exception as exc:
        print(f'[justwatch] API error: {exc}', file=sys.stderr)
        return None, None, None

    if not edges:
        return None, None, None

    # JustWatch éclate parfois un même titre sur plusieurs edges (ex. Crunchyroll
    # sur un edge frère de l'edge Netflix). On agrège les offres de tous les edges
    # qui portent exactement le titre du meilleur résultat, puis on applique la
    # préférence de provider.
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

    for service in PROVIDER_PREFERENCE:
        if service in found:
            cid, ft = found[service]
            return service, cid, ft
    return None, None, None


def resolve_any(title: str | None) -> tuple[str | None, str | None, str | None]:
    """
    Trouve sur quelle plateforme regarder *title*, sans provider imposé.
    Cache d'abord (tous les buckets, ordre de préférence), puis JustWatch.
    Renvoie (service, content_id, full_title) ou (None, None, None).
    """
    if not title:
        return None, None, None

    cache = _load()
    for service in PROVIDER_PREFERENCE:
        entry = cache.get(service, {}).get(_key(title))
        if entry:
            print(f'[cache] any/"{title}" → {service}/{entry["id"]}')
            return service, entry['id'], entry['title']

    print(f'[justwatch] any / "{title}" ...')
    service, cid, ft = _justwatch_any(title)
    if service:
        _put(service, title, cid, ft or title)
        print(f'[cache] stored {service}/{ft} → {cid}')
        return service, cid, ft

    print(f'[justwatch] no result for any/"{title}"', file=sys.stderr)
    return None, None, None


def remember(title: str, service: str) -> dict | None:
    """
    Mémorise sur quelle plateforme se trouve *title*.
    Tente de résoudre un content id deep-link via JustWatch ; enregistre la
    plateforme dans tous les cas (id = None si non trouvé → l'app s'ouvre sans
    deep-link). Renvoie l'entrée stockée, ou None si service non supporté.
    """
    if service not in _PROVIDER:
        print(f'[remember] service non supporté : {service}', file=sys.stderr)
        return None

    content_id, full_title = _justwatch(service, title)
    _put(service, title, content_id, full_title or title)
    print(f'[remember] {service}/{title} → {content_id}')
    return {'service': service, 'id': content_id, 'title': full_title or title}

# ── Public API ────────────────────────────────────────────────────────────────

def resolve(service: str, title: str | None) -> tuple[str | None, str | None]:
    """
    Return (content_id, full_title) for *title* on *service*.
    Cache-first; falls back to JustWatch on miss.
    Returns (None, None) if title is None or lookup fails — caller launches app only.
    """
    if not title:
        return None, None

    cached = _get(service, title)
    if cached:
        print(f'[cache] {service}/{title} → {cached["id"]}')
        return cached['id'], cached['title']

    print(f'[justwatch] {service} / "{title}" ...')
    content_id, full_title = _justwatch(service, title)
    if content_id:
        _put(service, title, content_id, full_title or title)
        print(f'[cache] stored {service}/{full_title} → {content_id}')
    else:
        print(f'[justwatch] no result for {service}/"{title}"', file=sys.stderr)

    return content_id, full_title


def resolve_youtube(query: str) -> tuple[str | None, str | None]:
    """
    Return (video_id, title) for a YouTube query.
    Handles direct URLs/IDs without any API call.
    For search queries: cache-first, then yt-dlp.
    """
    # Direct URL → extract ID immediately (no cache needed)
    m = _YT_URL_RE.search(query)
    if m:
        return m.group(1), query

    # Bare 11-char video ID
    if _YT_ID_RE.match(query):
        return query, query

    # Search query — check cache first
    cached = _get('youtube', query)
    if cached:
        print(f'[cache] youtube/"{query}" → {cached["id"]}')
        return cached['id'], cached['title']

    # yt-dlp search
    print(f'[yt-dlp] searching: "{query}"')
    try:
        result = subprocess.run(
            ['yt-dlp', '--no-playlist', '--print', 'id', '--print', 'title',
             f'ytsearch1:{query}'],
            capture_output=True, text=True, timeout=20,
        )
        lines = [l.strip() for l in result.stdout.strip().splitlines() if l.strip()]
        if len(lines) >= 2:
            vid_id, vid_title = lines[0], lines[1]
            _put('youtube', query, vid_id, vid_title)
            return vid_id, vid_title
        if len(lines) == 1:
            vid_id = lines[0]
            _put('youtube', query, vid_id, query)
            return vid_id, query
    except Exception as exc:
        print(f'[yt-dlp] error: {exc}', file=sys.stderr)

    return None, None
