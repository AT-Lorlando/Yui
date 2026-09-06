"""Tests des parseurs TMDB (purs). Lancer : python3 packages/mcp-chromecast/tests/test_tmdb.py"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import tmdb

PREF = ['crunchyroll', 'netflix', 'disney', 'prime']

# parse_search_pick : saute les personnes, prend le premier film/série
pick = tmdb.parse_search_pick([
    {'media_type': 'person', 'id': 1},
    {'media_type': 'tv', 'id': 60625, 'name': 'The Mentalist'},
])
assert pick and pick['id'] == 60625
assert tmdb.parse_search_pick([]) is None

# parse_providers : mapping des noms + ordre de préférence
fr = {'flatrate': [
    {'provider_name': 'Amazon Prime Video'},
    {'provider_name': 'Netflix'},
]}
assert tmdb.parse_providers(fr, PREF) == 'netflix'
assert tmdb.parse_providers({'ads': [{'provider_name': 'Netflix Standard with Ads'}]}, PREF) == 'netflix'
assert tmdb.parse_providers({'flatrate': [{'provider_name': 'Disney Plus'}]}, PREF) == 'disney'
assert tmdb.parse_providers({'flatrate': [{'provider_name': 'Canal+'}]}, PREF) is None
assert tmdb.parse_providers({}, PREF) is None

# Sans clé : inactif, jamais d'exception
if not os.getenv('TMDB_API_KEY'):
    assert tmdb.find_platform('Mentalist', PREF) == (None, None)

print('All tmdb tests passed')
