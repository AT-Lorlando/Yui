"""
tv_prep.py — Prepare Samsung TV for Chromecast.

Reads from environment (inherited from the Node process that spawned cast.py):
  SMARTTHINGS_TOKEN         — SmartThings Personal Access Token
  SMARTTHINGS_TV_DEVICE_ID  — TV device ID in SmartThings
  SMARTTHINGS_TV_MAC        — TV MAC address for Wake-on-LAN
  SMARTTHINGS_TV_IP         — TV local IP (used to derive subnet broadcast)

Called automatically by cast.py before every cast command.
Falls back gracefully if credentials are missing.
"""

import os
import socket
import sys
import time

import requests

_TOKEN     = os.environ.get('SMARTTHINGS_TOKEN', '')
_DEVICE_ID = os.environ.get('SMARTTHINGS_TV_DEVICE_ID', '')
_MAC       = os.environ.get('SMARTTHINGS_TV_MAC', '')
_TV_IP     = os.environ.get('SMARTTHINGS_TV_IP', '')

_BASE    = 'https://api.smartthings.com/v1'
_HEADERS = {'Authorization': f'Bearer {_TOKEN}', 'Content-Type': 'application/json'}
_TIMEOUT = 10


def _command(capability: str, command: str, args: list | None = None) -> None:
    cmd = {'component': 'main', 'capability': capability, 'command': command}
    if args:
        cmd['arguments'] = args
    requests.post(
        f'{_BASE}/devices/{_DEVICE_ID}/commands',
        json={'commands': [cmd]},
        headers=_HEADERS,
        timeout=_TIMEOUT,
    )


def _send_wol() -> None:
    hex_mac = _MAC.replace(':', '').replace('-', '')
    mac_bytes = bytes.fromhex(hex_mac)
    magic = b'\xff' * 6 + mac_bytes * 16
    broadcast = _TV_IP.rsplit('.', 1)[0] + '.255'
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        s.sendto(magic, (broadcast, 9))


def _is_on() -> bool:
    """Probe TV via SmartThings refresh — returns True if reachable (on)."""
    try:
        probe = requests.post(
            f'{_BASE}/devices/{_DEVICE_ID}/commands',
            json={'commands': [{'component': 'main', 'capability': 'refresh', 'command': 'refresh'}]},
            headers=_HEADERS,
            timeout=_TIMEOUT,
        )
        results = probe.json().get('results') or []
        return any(r.get('status') != 'FAILED' for r in results)
    except Exception:
        return False


def _switch_hdmi3() -> None:
    _command('samsungvd.mediaInputSource', 'setInputSource', ['HDMI3'])


def prepare() -> str:
    """
    Ensure Samsung TV is on and set to HDMI3 (Chromecast input).
    Returns a status message. Never raises.
    """
    if not _TOKEN or not _DEVICE_ID:
        print('[tv_prep] skipped — SMARTTHINGS_TOKEN or DEVICE_ID not set', file=sys.stderr)
        return 'TV preparation skipped (SmartThings not configured)'

    # Already on → just switch input
    if _is_on():
        _switch_hdmi3()
        print('[tv_prep] TV already on — switched to HDMI3')
        return 'TV already on — HDMI3'

    # TV off — Wake-on-LAN
    print('[tv_prep] TV off — sending WoL ...')
    if _MAC and _TV_IP:
        try:
            _send_wol()
        except Exception as exc:
            print(f'[tv_prep] WoL failed: {exc}', file=sys.stderr)
    else:
        # No WoL config — try SmartThings switch.on (works from standby)
        try:
            _command('switch', 'on')
        except Exception:
            pass

    # Poll until TV responds (up to 25 s)
    deadline = time.time() + 25
    while time.time() < deadline:
        time.sleep(3)
        if _is_on():
            _switch_hdmi3()
            print('[tv_prep] TV powered on — HDMI3')
            return 'TV powered on — HDMI3'

    msg = 'TV WoL sent but did not respond in time — HDMI3 may need manual switch'
    print(f'[tv_prep] {msg}', file=sys.stderr)
    return msg
