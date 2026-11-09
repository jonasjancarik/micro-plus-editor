# Mustang Micro Plus editor

A browser editor for the Fender Mustang Micro Plus. It shows your presets as a pedalboard, so you
can switch, compare, edit, reorder, save, undo, export and import them over Bluetooth. It runs on
your own computer and needs no internet connection.

![A preset shown as a pedalboard: two pedals, the amp, then two more pedals, with the EQ menu and Save button above](docs/images/board.png)

Open a pedal to set every knob and swap the effect:

![The Flanger pedal opened up, with five knobs and a menu for choosing a different effect](docs/images/pedal.png)

Find presets by name, sound or artist, and sort them into groups:

![The preset list filtered to the Echoes and space group, each preset with a short description and similar artists](docs/images/presets.png)

It also works on a phone or tablet:

<img src="docs/images/phone.png" width="300" alt="The editor on a phone, with the pedals stacked above the amp and the Save button along the bottom">

This project isn't affiliated with or endorsed by Fender.

Saving writes over the preset on the amp. Before you change presets you care about, export them
from the editor so you have a copy to import back.

## Run it

You need [pnpm](https://pnpm.io) and Chrome. Close Fender Tone first, because the amp accepts one
connection at a time.

```sh
pnpm install
pnpm dev
```

Then open http://localhost:5175 in Chrome and click **Connect to your amp**. To try the page without
an amp, open http://localhost:5175/?simulator=1 instead.

Chrome asks you to choose the amp again after each reload. Web Bluetooth only works on
`localhost` or over HTTPS, so open the page through `localhost` on the computer the amp is near.

## Desktop app

On a Mac, download the app from the
[releases page](https://github.com/jonasjancarik/micro-plus-editor/releases), open the `.dmg` and
drag Micro Plus into Applications. It runs on Apple silicon and Intel Macs. When you connect, it
waits a moment for nearby amps and then asks which one to use.

To run it from the source instead, `pnpm desktop` builds the page and opens it in an Electron window.
`pnpm desktop:dev` opens the running `pnpm dev` page instead, and `pnpm desktop:install` builds an
unsigned copy into your Applications folder.

`pnpm desktop:release` builds the signed and notarized Mac app into `release/`. It needs a Developer
ID Application certificate in your keychain, and an App Store Connect API key in `APPLE_API_KEY`
(the path to the `.p8` file), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. It reads them from
`.env.local` if that file exists.

## Phone apps

`pnpm app` builds the page and copies it into the `android/` and `ios/` projects. Open those in
Android Studio or Xcode to install them.
`node scripts/make-app-icons.mjs` redraws their icons and splash screens from `web/public/icon.svg`.
[docs/REAL_AMP_CHECK.md](docs/REAL_AMP_CHECK.md) has the steps for an iPad and an Android phone.

## Tests

```sh
pnpm typecheck
pnpm test
pnpm test:e2e
```

`pnpm test` covers the amp protocol, sessions, backups, undo and groups, partly against bytes
recorded from the earlier Python version, which worked on the real amp. `pnpm test:e2e` drives the page in
Chrome against the simulated amp. To check the phone apps' file storage on a device, point the app at
`web/native-check.html` on the dev server.

## More detail

- [docs/EDITOR.md](docs/EDITOR.md) covers every feature and how the Bluetooth connection works.
- [docs/REAL_AMP_CHECK.md](docs/REAL_AMP_CHECK.md) lists what's been checked on the real amp, and
  the steps for an iPad and an Android phone.
- [docs/BLUETOOTH_TEST.md](docs/BLUETOOTH_TEST.md) covers the first checks in browsers and on
  phones.

## Credits and licence

This project grew out of [Maneline](https://github.com/tim-littlefair/maneline) by Tim Littlefair,
whose Micro Plus experiments provided the Bluetooth startup sequence and the first connection code.
It's licensed under the GNU General Public License, version 2. See [NOTICE](NOTICE) and
[LICENSE](LICENSE).
