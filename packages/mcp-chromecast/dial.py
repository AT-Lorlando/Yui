"""
dial.py — DIAL protocol client (port 8008 on Chromecast).

DIAL is a simple REST API:
  POST   /apps/<AppName>          body: v=<contentId>   → launch (with optional deep-link)
  DELETE /apps/<AppName>/run                            → stop
  GET    /apps/<AppName>                                → status XML

The `v=` parameter is a common convention from the Netflix/YouTube DIAL origins.
Deep-link support varies per app and Chromecast firmware.
"""

import sys
import requests

_TIMEOUT = 10

# Chromecast DIAL app names (case-sensitive as registered on the device)
DIAL_APP = {
    'netflix':     'Netflix',
    'crunchyroll': 'Crunchyroll',
    'disney':      'Disney',
    'prime':       'AmazonInstantVideo',
    'youtube':     'YouTube',
    'spotify':     'Spotify',
}


def launch(host: str, service: str, content_id: str | None = None) -> str:
    """
    Launch a Chromecast app via DIAL.
    If content_id is provided, sends it as `v=<id>` for deep-linking.
    """
    app_name = DIAL_APP.get(service, service)
    url = f'http://{host}:8008/apps/{app_name}'

    try:
        if content_id:
            resp = requests.post(
                url,
                data=f'v={content_id}',
                headers={'Content-Type': 'application/x-www-form-urlencoded'},
                timeout=_TIMEOUT,
            )
        else:
            resp = requests.post(url, timeout=_TIMEOUT)

        if resp.status_code in (200, 201):
            if content_id:
                return f'Launched {app_name} → content {content_id}'
            return f'Launched {app_name} on Chromecast'

        return f'DIAL {app_name}: HTTP {resp.status_code} — {resp.text[:120]}'

    except Exception as exc:
        return f'DIAL launch failed for {app_name}: {exc}'


def stop_app(host: str, app_name: str) -> str:
    """Stop a specific app by its DIAL name."""
    url = f'http://{host}:8008/apps/{app_name}/run'
    try:
        resp = requests.delete(url, timeout=_TIMEOUT)
        if resp.status_code in (200, 204):
            return f'Stopped {app_name}'
        return f'DIAL stop {app_name}: HTTP {resp.status_code}'
    except Exception as exc:
        return f'DIAL stop failed for {app_name}: {exc}'


def running_app(host: str) -> str | None:
    """
    Return the DIAL app name that is currently running, or None.
    Queries each known app in parallel-ish (sequential with short timeout).
    """
    for app_name in DIAL_APP.values():
        try:
            resp = requests.get(
                f'http://{host}:8008/apps/{app_name}',
                timeout=2,
            )
            if resp.status_code == 200 and '<state>running</state>' in resp.text:
                return app_name
        except Exception:
            continue
    return None
