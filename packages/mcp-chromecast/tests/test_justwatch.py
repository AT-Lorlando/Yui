import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import justwatch as jw

PREF = ['crunchyroll', 'netflix', 'disney', 'prime']

EDGES_ONE_PIECE = [
    {'node': {'content': {'title': 'One Piece'}, 'offers': [
        {'standardWebURL': 'https://www.netflix.com/title/80107103',
         'package': {'technicalName': 'netflix'}},
    ]}},
    {'node': {'content': {'title': 'One Piece'}, 'offers': [
        {'standardWebURL': 'https://www.crunchyroll.com/series/GR3VWXP96/one-piece',
         'package': {'technicalName': 'crunchyroll'}},
        {'standardWebURL': 'https://www.netflix.com/title/80107103',
         'package': {'technicalName': 'netflix'}},
    ]}},
    {'node': {'content': {'title': 'Autre chose'}, 'offers': [
        {'standardWebURL': 'https://www.crunchyroll.com/series/GZZZZ/autre',
         'package': {'technicalName': 'crunchyroll'}},
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


def test_extract_id_crunchyroll_keeps_episode_kind():
    assert jw._extract_id('crunchyroll', 'https://www.crunchyroll.com/series/GR3VWXP96/one-piece') == 'GR3VWXP96'
    assert jw._extract_id('crunchyroll', 'https://www.crunchyroll.com/watch/GE00380778JAJP') == 'episode/GE00380778JAJP'
    assert jw._extract_id('crunchyroll', 'https://www.crunchyroll.com/fr/watch/GRWEW95KR/ep') == 'episode/GRWEW95KR'


def test_parse_all_lists_every_service_and_dedupes():
    edges = [
        {'node': {'objectType': 'SHOW', 'content': {'title': 'One Piece', 'originalReleaseYear': 1999}, 'offers': [
            {'standardWebURL': 'https://www.netflix.com/title/80107103', 'package': {'technicalName': 'netflix'}},
            {'standardWebURL': 'https://www.crunchyroll.com/watch/GE00380778JAJP', 'package': {'technicalName': 'crunchyroll'}},
            {'standardWebURL': 'https://www.crunchyroll.com/watch/GE00380778JAJP', 'package': {'technicalName': 'crunchyroll'}},
            {'standardWebURL': 'https://x', 'package': {'technicalName': 'amazoncrunchyroll'}},
        ]}},
        {'node': {'objectType': 'MOVIE', 'content': {'title': 'One Piece Film - Red', 'originalReleaseYear': 2022}, 'offers': [
            {'standardWebURL': 'https://www.crunchyroll.com/series/GRMG8ZQZR', 'package': {'technicalName': 'crunchyroll'}},
        ]}},
    ]
    assert jw.parse_all(edges) == [
        {'service': 'netflix', 'id': '80107103', 'title': 'One Piece', 'year': 1999, 'type': 'show'},
        {'service': 'crunchyroll', 'id': 'episode/GE00380778JAJP', 'title': 'One Piece', 'year': 1999, 'type': 'show'},
        {'service': 'crunchyroll', 'id': 'GRMG8ZQZR', 'title': 'One Piece Film - Red', 'year': 2022, 'type': 'movie'},
    ]
    assert jw.parse_all([]) == []
