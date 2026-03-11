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
    """Returns True if the TV REST API responds (TV is on)."""
    try:
        r = requests.get(_REST_URL, timeout=2.5)
        return r.status_code == 200
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


def prepare() -> str:
    """
    Ensure Samsung TV is on and set to HDMI3 (Chromecast input).
    Returns a status message. Never raises.
    """
    if not _TV_IP:
        print('[tv_prep] skipped — SMARTTHINGS_TV_IP not set', file=sys.stderr)
        return 'TV preparation skipped (TV IP not configured)'

    # Already on → just switch input
    if _is_on():
        try:
            _send_key('KEY_HDMI3')
            print('[tv_prep] TV already on — switched to HDMI3')
            return 'TV already on — HDMI3'
        except Exception as exc:
            print(f'[tv_prep] HDMI3 key failed: {exc}', file=sys.stderr)
            return 'TV already on — could not switch input'

    # TV off — Wake-on-LAN
    print('[tv_prep] TV off — sending WoL ...')
    if _MAC:
        try:
            _send_wol()
        except Exception as exc:
            print(f'[tv_prep] WoL failed: {exc}', file=sys.stderr)
    else:
        print('[tv_prep] no MAC configured — cannot send WoL', file=sys.stderr)
        return 'TV off and no MAC address configured — cannot power on'

    # Poll until TV responds (up to 30 s)
    deadline = time.time() + 30
    while time.time() < deadline:
        time.sleep(3)
        if _is_on():
            time.sleep(1.5)  # let WS server start
            try:
                _send_key('KEY_HDMI3')
            except Exception as exc:
                print(f'[tv_prep] HDMI3 key after boot failed: {exc}', file=sys.stderr)
            print('[tv_prep] TV powered on — HDMI3')
            return 'TV powered on — HDMI3'

    msg = 'TV WoL sent but did not respond in time — HDMI3 may need manual switch'
    print(f'[tv_prep] {msg}', file=sys.stderr)
    return msg
