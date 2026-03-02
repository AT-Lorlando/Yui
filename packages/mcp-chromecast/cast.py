#!/usr/bin/env python3
"""
cast.py — Cast content to Chromecast.

Named services use DIAL (HTTP :8008) with optional content deep-link via JustWatch cache.
Direct media uses pychromecast media_controller (Cast SDK).

Usage:
  python3 cast.py <host> <port> youtube    <source>        # URL / ID / search query
  python3 cast.py <host> <port> netflix    [title]         # optional deep-link
  python3 cast.py <host> <port> crunchyroll [title]
  python3 cast.py <host> <port> disney     [title]
  python3 cast.py <host> <port> prime      [title]
  python3 cast.py <host> <port> media      <url>           # direct mp4 / m3u8 / …
  python3 cast.py <host> <port> stop
"""

import os
import sys
import time

# Ensure sibling Python modules (content_cache, dial) are importable
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import content_cache
import dial
import tv_prep

if len(sys.argv) < 4:
    print(__doc__, file=sys.stderr)
    sys.exit(1)

HOST = sys.argv[1]
PORT = int(sys.argv[2])
CMD  = sys.argv[3]

_MEDIA_TYPES = {
    'mp4': 'video/mp4', 'webm': 'video/webm', 'mkv': 'video/x-matroska',
    'mp3': 'audio/mpeg', 'aac': 'audio/aac',
    'm3u8': 'application/x-mpegURL', 'ts': 'video/mp2t',
}

_NAMED_SERVICES = {'netflix', 'crunchyroll', 'disney', 'prime'}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _connect_cast():
    import pychromecast
    cast = pychromecast.get_chromecast_from_host(
        (HOST, PORT, None, None, 'Chromecaste'),
    )
    cast.wait(timeout=10)
    return cast


# ── Command handlers ──────────────────────────────────────────────────────────

def cmd_youtube(source: str) -> str:
    vid_id, title = content_cache.resolve_youtube(source)
    if not vid_id:
        # If it looks like a direct URL, try casting as media
        if source.startswith('http'):
            return cmd_media(source)
        print(f'ERROR: could not resolve YouTube source: {source}', file=sys.stderr)
        sys.exit(1)

    from pychromecast.controllers.youtube import YouTubeController
    cast = _connect_cast()
    yt = YouTubeController()
    cast.register_handler(yt)
    yt.play_video(vid_id)
    time.sleep(3)
    return f'YouTube: {title or vid_id}'


def cmd_service(service: str, title: str | None) -> str:
    """Named service: resolve content ID via cache/JustWatch, then DIAL launch."""
    content_id, full_title = content_cache.resolve(service, title)

    if content_id:
        result = dial.launch(HOST, service, content_id)
        label = full_title or title
        return f'{result} ({label})'

    # No content ID (no title provided, or lookup failed) — just open the app
    if title:
        print(
            f'No content ID found for "{title}" on {service}, launching app only',
            file=sys.stderr,
        )
    return dial.launch(HOST, service)


def cmd_media(url: str) -> str:
    ext = url.split('?')[0].rsplit('.', 1)[-1].lower()
    content_type = _MEDIA_TYPES.get(ext, 'video/mp4')
    cast = _connect_cast()
    mc = cast.media_controller
    mc.play_media(url, content_type)
    mc.block_until_active(timeout=10)
    return f'Casting media: {url}'


def cmd_stop() -> str:
    # 1. Try DIAL: find the running app and DELETE it
    app = dial.running_app(HOST)
    if app:
        return dial.stop_app(HOST, app)

    # 2. Fallback: pychromecast quit_app()
    cast = _connect_cast()
    cast.quit_app()
    return 'Stopped Chromecast'


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    if CMD == 'stop':
        # Stop never needs TV preparation
        print(cmd_stop())
        return

    # All cast commands prepare the TV first (WoL + HDMI3)
    prep_msg = tv_prep.prepare()
    print(f'[tv] {prep_msg}')

    if CMD == 'youtube':
        source = sys.argv[4] if len(sys.argv) > 4 else ''
        print(cmd_youtube(source))

    elif CMD in _NAMED_SERVICES:
        title = sys.argv[4] if len(sys.argv) > 4 else None
        print(cmd_service(CMD, title))

    elif CMD == 'media':
        if len(sys.argv) < 5:
            print('ERROR: media requires <url>', file=sys.stderr)
            sys.exit(1)
        print(cmd_media(sys.argv[4]))

    else:
        print(f'ERROR: unknown command "{CMD}"', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
