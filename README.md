# Mustang Micro Plus editor

A browser editor for the Fender Mustang Micro Plus. It shows your presets as a pedalboard, so you
can switch, compare, edit, reorder, save, undo, export and import them over Bluetooth. It runs on
your own computer and needs no internet connection.

This project isn't affiliated with or endorsed by Fender. "Micro Plus editor" is a working name.

## Run it

You need [pnpm](https://pnpm.io) and Chrome. Close Fender Tone first, because the amp accepts one
connection at a time.

```sh
pnpm install
pnpm dev
```

Then open http://localhost:5175 in Chrome and click **Connect to your amp**. To try the page without
an amp, open http://localhost:5175/?simulator=1 instead.

The TypeScript version hasn't controlled the real amp yet.
[docs/REAL_AMP_CHECK.md](docs/REAL_AMP_CHECK.md) lists what to check and what comes after it. Until
that's done, the Python server stays as the proven way to use the amp. It needs macOS, Python 3.11
or later and a built page:

```sh
pnpm build
uv venv .venv
uv pip install --python .venv/bin/python -r server/requirements.txt
./run.sh
```

Then open http://localhost:8080. Start it from Terminal or another app with Bluetooth permission.

## Phone apps

`pnpm app` builds the page and copies it into the `android/` and `ios/` projects. Open those in
Android Studio or Xcode to install them.
[docs/REAL_AMP_CHECK.md](docs/REAL_AMP_CHECK.md) has the steps for an iPad and an Android phone.

## Tests

```sh
pnpm typecheck
pnpm test
pnpm test:e2e
.venv/bin/python -m unittest discover -s server/tests -p 'test_mmp*.py'
```

`pnpm test` covers the amp protocol, sessions, backups, undo and groups, partly against files that
`server/export_wire_fixtures.py` writes from the Python code. `pnpm test:e2e` drives the page in
Chrome against the simulated amp. To check the phone apps' file storage on a device, point the app at
`web/native-check.html` on the dev server.

## More detail

- [docs/MUSTANG_MICRO_PLUS_MACOS.md](docs/MUSTANG_MICRO_PLUS_MACOS.md) covers every feature and how
  the Bluetooth connection works. It was written for the Python version.
- [docs/BLUETOOTH_TEST.md](docs/BLUETOOTH_TEST.md) covers what's been checked in browsers and on
  phones.

## Credits and licence

This project grew out of [Maneline](https://github.com/tim-littlefair/maneline) by Tim Littlefair,
whose Micro Plus experiments provided the Bluetooth startup sequence and the first connection code.
It's licensed under the GNU General Public License, version 2. See [NOTICE](NOTICE) and
[LICENSE](LICENSE).
