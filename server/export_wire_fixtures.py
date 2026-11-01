#!/usr/bin/env python3
"""Writes tests/fixtures/wire.json, so the TypeScript code is tested against what the Python code produces."""
import json
from pathlib import Path

import lz4.block

from mmp_ble import Frames, KEEPALIVE, packet, select_preset, varint
from mmp_protocol import SAVE_AS, fragments, request, wire_bytes, wire_string, wire_uint

ROOT = Path(__file__).resolve().parents[1]
document = json.loads((ROOT / 'server/mmp_mock_fixture.json').read_text())['document']
raw = json.dumps(document, separators=(',', ':')).encode()
compressed = lz4.block.compress(raw, store_size=False)
payload = wire_uint(1, 99) + wire_bytes(2, compressed) + wire_uint(3, 1) + wire_string(4, 'Simulator preset')

reply = b'\x12' + varint(200) + bytes(range(200))
split = fragments(reply, 90)
frames = Frames()
assembled = [message.hex() if (message := frames.feed(part)) else None for part in split]

(ROOT / 'tests/fixtures/wire.json').write_text(json.dumps({
    'keepalive': KEEPALIVE.hex(),
    'packet': packet(b'\x01\x02').hex(),
    'select': {str(slot): select_preset(slot).hex() for slot in (1, 72, 100)},
    'lz4': {'raw': raw.decode(), 'compressed': compressed.hex()},
    'saveAs': {'payload': payload.hex(), 'packets': [part.hex() for part in fragments(request(SAVE_AS, payload))]},
    'frames': {'packets': [part.hex() for part in split], 'assembled': assembled},
}, indent=1) + '\n')
