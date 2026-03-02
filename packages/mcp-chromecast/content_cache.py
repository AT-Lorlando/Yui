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
_PROJECT_ROOT = os.path.abspath(os.path.join(_HERE, '..', '..', '..'))
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

_JW_QUERY = '''
query SearchTitles($searchInput: SearchTitlesInput!) {
  searchTitles(searchInput: $searchInput, country: "FR", language: "fr") {
    edges {
      node {
        content { title objectType }
        offers(country: "FR", platform: WEB) {
          standardWebURL
          package { shortName }
        }
      }
    }
  }
}
'''

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
            json={
                'query': _JW_QUERY,
                'variables': {'searchInput': {'query': title}},
            },
            headers={'Content-Type': 'application/json'},
            timeout=10,
        )
        resp.raise_for_status()
        edges = (
            resp.json()
            .get('data', {})
            .get('searchTitles', {})
            .get('edges', [])
        )
    except Exception as exc:
        print(f'[justwatch] API error: {exc}', file=sys.stderr)
        return None, None

    pattern = _ID_PATTERN.get(provider)
    for edge in edges:
        node      = edge.get('node', {})
        full_title = node.get('content', {}).get('title', title)
        for offer in node.get('offers', []):
            if offer.get('package', {}).get('shortName') != provider:
                continue
            url = offer.get('standardWebURL', '')
            if pattern:
                m = pattern.search(url)
                if m:
                    return m.group(1), full_title

    return None, None

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
