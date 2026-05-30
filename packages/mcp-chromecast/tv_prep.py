"""
tv_prep.py — Prepare Samsung TV for Chromecast.

Uses the Samsung TV local WebSocket API (port 8001) — no SmartThings needed.

Reads from environment:
  SMARTTHINGS_TV_MAC  — TV MAC address for Wake-on-LAN
  SMARTTHINGS_TV_IP   — TV local IP (also used to derive WoL broadcast)
"""

import base64
import json
import os
import socket
import sys
import time

import requests
import websocket  # websocket-client

_MAC   = os.environ.get('SMARTTHINGS_TV_MAC', '')
_TV_IP = os.environ.get('SMARTTHINGS_TV_IP', '')

_APP_NAME = base64.b64encode(b'Yui').decode()
_WS_URL   = f'ws://{_TV_IP}:8001/api/v2/channels/samsung.remote.control?name={_APP_NAME}'
_REST_URL = f'http://{_TV_IP}:8001/api/v2/'


def _is_on() -> bool:
    """Returns True if the TV PowerState is 'on' (not standby)."""
    try:
        r = requests.get(_REST_URL, timeout=2.5)
        if r.status_code != 200:
            return False
        state = r.json().get('device', {}).get('PowerState', 'on')
        return state == 'on'
    except Exception:
        return False


def _send_wol() -> None:
    hex_mac   = _MAC.replace(':', '').replace('-', '')
    mac_bytes = bytes.fromhex(hex_mac)
    magic     = b'\xff' * 6 + mac_bytes * 16
    broadcast = _TV_IP.rsplit('.', 1)[0] + '.255'
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        s.sendto(magic, (broadcast, 9))


def _send_key(key: str) -> None:
    ws = websocket.create_connection(_WS_URL, timeout=5)
    try:
        ws.send(json.dumps({
            'method': 'ms.remote.control',
            'params': {'Cmd': 'Click', 'DataOfCmd': key, 'TypeOfRemote': 'SendRemoteKey'},
        }))
        time.sleep(0.5)
    finally:
        ws.close()


def _ws_alive() -> bool:
    """Real liveness check : open the remote-control WebSocket. Standby refuses."""
    try:
        ws = websocket.create_connection(_WS_URL, timeout=2)
        ws.close()
        return True
    except Exception:
        return False


def prepare() -> str:
    """
    Ensure Samsung TV is on and set to HDMI3 (Chromecast input).
    Returns a status message. Never raises.

    Note: the REST endpoint `_is_on()` lies (returns PowerState='on' in standby too).
    We use WebSocket reachability as ground truth, and always send WoL first as it's
    a no-op when the TV is awake.
    """
    if not _TV_IP:
        print('[tv_prep] skipped — SMARTTHINGS_TV_IP not set', file=sys.stderr)
        return 'TV preparation skipped (TV IP not configured)'

    # Always send WoL first (idempotent — no-op if TV awake)
    if _MAC:
        try:
            _send_wol()
            print('[tv_prep] WoL sent')
        except Exception as exc:
            print(f'[tv_prep] WoL failed: {exc}', file=sys.stderr)

    # If WebSocket is already up, TV was awake → just switch input
    if _ws_alive():
        try:
            _send_key('KEY_HDMI3')
            print('[tv_prep] TV awake — switched to HDMI3')
            return 'TV awake — HDMI3'
        except Exception as exc:
            print(f'[tv_prep] HDMI3 key failed: {exc}', file=sys.stderr)
            return 'TV awake — could not switch input'

    if not _MAC:
        print('[tv_prep] no MAC configured — cannot wake TV', file=sys.stderr)
        return 'TV off and no MAC address configured — cannot power on'

    # Poll until TV's WS server responds (up to 30 s)
    deadline = time.time() + 30
    while time.time() < deadline:
        time.sleep(2)
        if _ws_alive():
            time.sleep(1.5)  # let WS server stabilise
            try:
                _send_key('KEY_HDMI3')
            except Exception as exc:
                print(f'[tv_prep] HDMI3 key after boot failed: {exc}', file=sys.stderr)
            print('[tv_prep] TV powered on — HDMI3')
            return 'TV powered on — HDMI3'

    msg = 'TV WoL sent but did not respond in time — HDMI3 may need manual switch'
    print(f'[tv_prep] {msg}', file=sys.stderr)
    return msg
