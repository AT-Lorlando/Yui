import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import content_cache as cc


def _setup_cache(data):
    fd, path = tempfile.mkstemp(suffix='.json')
    with os.fdopen(fd, 'w') as f:
        json.dump(data, f)
    cc.CACHE_FILE = path
    return path


def test_resolve_any_cache_hit_prefers_crunchyroll():
    _setup_cache({
        'netflix': {'naruto': {'id': 'NFX1', 'title': 'Naruto'}},
        'crunchyroll': {'naruto': {'id': 'CRU1', 'title': 'Naruto'}},
    })
    service, cid, title = cc.resolve_any('Naruto')
    assert service == 'crunchyroll', service
    assert cid == 'CRU1', cid


def test_resolve_any_justwatch_fallback_caches():
    _setup_cache({})
    cc._justwatch_any = lambda title: ('crunchyroll', 'GXYZ', 'Naruto')
    service, cid, title = cc.resolve_any('Naruto')
    assert service == 'crunchyroll', service
    assert cid == 'GXYZ', cid
    with open(cc.CACHE_FILE) as f:
        cache = json.load(f)
    assert cache['crunchyroll']['naruto']['id'] == 'GXYZ'


def test_resolve_any_miss_returns_none():
    _setup_cache({})
    cc._justwatch_any = lambda title: (None, None, None)
    assert cc.resolve_any('Inconnu') == (None, None, None)


def test_remember_stores_platform_with_id():
    _setup_cache({})
    cc._justwatch = lambda service, title: ('CRU9', 'Naruto')
    res = cc.remember('Naruto', 'crunchyroll')
    assert res['service'] == 'crunchyroll', res
    assert res['id'] == 'CRU9', res
    with open(cc.CACHE_FILE) as f:
        cache = json.load(f)
    assert cache['crunchyroll']['naruto']['id'] == 'CRU9'


def test_remember_stores_platform_without_id():
    _setup_cache({})
    cc._justwatch = lambda service, title: (None, None)
    res = cc.remember('Naruto', 'crunchyroll')
    assert res['service'] == 'crunchyroll', res
    with open(cc.CACHE_FILE) as f:
        cache = json.load(f)
    assert 'naruto' in cache['crunchyroll']


def test_remember_rejects_unknown_service():
    _setup_cache({})
    assert cc.remember('Naruto', 'hbo') is None


if __name__ == '__main__':
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            try:
                fn()
                print(f'PASS {name}')
            except AssertionError as exc:
                failures += 1
                print(f'FAIL {name}: {exc}')
    if failures:
        sys.exit(1)
    print('All tests passed')
