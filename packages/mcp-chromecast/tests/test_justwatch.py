import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import justwatch as jw

PREF = ['crunchyroll', 'netflix', 'disney', 'prime']

EDGES_ONE_PIECE = [
    {'node': {'content': {'title': 'One Piece'}, 'offers': [
        {'standardWebURL': 'https://www.netflix.com/title/80107103',
         'package': {'shortName': 'nfx'}},
    ]}},
    {'node': {'content': {'title': 'One Piece'}, 'offers': [
        {'standardWebURL': 'https://www.crunchyroll.com/series/GR3VWXP96/one-piece',
         'package': {'shortName': 'cru'}},
        {'standardWebURL': 'https://www.netflix.com/title/80107103',
         'package': {'shortName': 'nfx'}},
    ]}},
    {'node': {'content': {'title': 'Autre chose'}, 'offers': [
        {'standardWebURL': 'https://www.crunchyroll.com/series/GZZZZ/autre',
         'package': {'shortName': 'cru'}},
    ]}},
]


def test_parse_any_prefers_crunchyroll_across_sibling_edges():
    assert jw.parse_any(EDGES_ONE_PIECE, PREF, 'One Piece') == (
        'crunchyroll', 'GR3VWXP96', 'One Piece')


def test_parse_for_service_netflix():
    assert jw.parse_for_service(EDGES_ONE_PIECE, 'netflix', 'One Piece') == (
        '80107103', 'One Piece')


def test_parse_for_service_crunchyroll():
    assert jw.parse_for_service(EDGES_ONE_PIECE, 'crunchyroll', 'One Piece') == (
        'GR3VWXP96', 'One Piece')


def test_parse_for_service_unsupported():
    assert jw.parse_for_service(EDGES_ONE_PIECE, 'hbo', 'One Piece') == (None, None)


def test_parse_empty_edges():
    assert jw.parse_any([], PREF, 'x') == (None, None, None)
    assert jw.parse_for_service([], 'netflix', 'x') == (None, None)


def test_supported_services():
    assert set(jw.SUPPORTED_SERVICES) == {'netflix', 'crunchyroll', 'disney', 'prime'}


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
    print('All justwatch tests passed')
