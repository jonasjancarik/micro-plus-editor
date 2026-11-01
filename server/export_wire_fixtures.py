#!/usr/bin/env python3
"""Writes tests/fixtures/wire.json, so the TypeScript code is tested against what the Python code produces."""
import json
import struct
from pathlib import Path

import lz4.block

from mmp_ble import Frames, KEEPALIVE, fields, packet, select_preset, varint
from mmp_protocol import (CURRENT, READ_PRESET, REPLACE_NODE, SAVE_AS, SAVE_CURRENT, SET_PARAMETER, fragments,
                          parameter_payload, parameter_value, request, save_current_payload, signal_order,
                          wire_bytes, wire_string, wire_uint, with_signal_order)

ROOT = Path(__file__).resolve().parents[1]
document = json.loads((ROOT / 'server/mmp_mock_fixture.json').read_text())['document']
raw = json.dumps(document, separators=(',', ':')).encode()
compressed = lz4.block.compress(raw, store_size=False)
payload = wire_uint(1, 99) + wire_bytes(2, compressed) + wire_uint(3, 1) + wire_string(4, 'Simulator preset')

reply = b'\x12' + varint(200) + bytes(range(200))
split = fragments(reply, 90)
frames = Frames()
assembled = [message.hex() if (message := frames.feed(part)) else None for part in split]

standard = ['stomp', 'mod', 'amp', 'delay', 'reverb']
ordered = with_signal_order(document, standard)
moved = ['reverb', 'delay', 'mod', 'amp', 'stomp']
values = [('float', 0.625), ('float', 0.1), ('float', 0.0), ('integer', 3), ('integer', -2), ('integer', 0),
          ('bool', True), ('bool', False), ('text', 'off'), ('text', 'zvuk č')]
numbers = {'float': float, 'integer': int}
replies = [b'\x1d' + struct.pack('<f', 0.625), wire_string(4, 'off'), wire_uint(5, 3), wire_uint(5, 4), wire_uint(6, 1), b'']
commands = {
    'current': (CURRENT, wire_uint(1, 1)),
    'readPreset': (READ_PRESET, wire_uint(1, 99) + wire_uint(2, 1)),
    'readParameter': (11, wire_string(1, 'amp') + wire_string(2, 'gain')),
    'setParameter': (SET_PARAMETER, parameter_payload('amp', 'gain', 0.5)),
    'replaceNode': (REPLACE_NODE, wire_string(1, 'amp') + wire_string(2, 'ACD_Deluxe65GT')),
    'saveCurrent': (SAVE_CURRENT, save_current_payload('Editor test', 100)),
}

(ROOT / 'tests/fixtures/wire.json').write_text(json.dumps({
    'keepalive': KEEPALIVE.hex(),
    'packet': packet(b'\x01\x02').hex(),
    'select': {str(slot): select_preset(slot).hex() for slot in (1, 72, 100)},
    'lz4': {'raw': raw.decode(), 'compressed': compressed.hex()},
    'saveAs': {'payload': payload.hex(), 'packets': [part.hex() for part in fragments(request(SAVE_AS, payload))]},
    'frames': {'packets': [part.hex() for part in split], 'assembled': assembled},
    'parameters': [{'kind': kind, 'value': value, 'hex': parameter_payload('amp', 'gain', numbers.get(kind, type(value))(value)).hex()}
                   for kind, value in values],
    'parameterReplies': [{'hex': reply.hex(), 'value': parameter_value(dict(fields(reply)))} for reply in replies],
    'save': {name: save_current_payload(name, slot).hex() for name, slot in (('Editor test', 100), ('Zvuk č', 1))},
    'commands': {name: [part.hex() for part in fragments(request(kind, body))] for name, (kind, body) in commands.items()},
    'order': {'standard': standard, 'found': signal_order(ordered), 'moved': moved,
              'connections': with_signal_order(document, moved)['audioGraph']['connections']},
}, indent=1) + '\n')
