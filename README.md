# Mustang Micro Plus editor

A browser editor for the Fender Mustang Micro Plus. It shows your presets as a pedalboard, so you
can switch, compare, edit, reorder, save, undo, export and import them over Bluetooth. It runs on
your own computer and needs no internet connection.

This project isn't affiliated with or endorsed by Fender. "Micro Plus editor" is a working name.

## Run it

You need macOS and Python 3.11 or later. Close Fender Tone first, because the amp accepts one
connection at a time.

```sh
uv venv .venv
uv pip install --python .venv/bin/python -r server/requirements.txt
./run.sh
```

Then open http://localhost:8080. Start it from Terminal or another app with Bluetooth permission.

To try the page without an amp, run the simulator and open http://localhost:8092:

```sh
.venv/bin/python server/mmp_mock.py --port 8092
```

## Tests

```sh
.venv/bin/python -m unittest discover -s server/tests -p 'test_mmp*.py'
```

## More detail

[docs/MUSTANG_MICRO_PLUS_MACOS.md](docs/MUSTANG_MICRO_PLUS_MACOS.md) covers every feature, what
has been checked on the amp, and how the Bluetooth connection works.

## Moving to TypeScript

The editor still runs on the Python server. `src/` holds the TypeScript version of everything the
server does: the amp protocol, the session with its backups and undo, preset groups, the compare list
and a simulated amp. The page doesn't use it yet. It's tested with `pnpm test`, partly against files
that `server/export_wire_fixtures.py` writes from the Python code.
[docs/BLUETOOTH_TEST.md](docs/BLUETOOTH_TEST.md) covers what's been checked in browsers and on phones.

## Credits and licence

This project grew out of [Maneline](https://github.com/tim-littlefair/maneline) by Tim Littlefair,
whose Micro Plus experiments provided the Bluetooth startup sequence and the first connection code.
It's licensed under the GNU General Public License, version 2. See [NOTICE](NOTICE) and
[LICENSE](LICENSE).
