# Bluetooth test results

Read when porting the protocol to TypeScript or changing how the app talks to the amp.

Before porting the editor, `bluetooth-test/` checked that a browser and a phone can run the amp
without the Python server. It connects, reads the amp's state, switches preset, rewrites slot 100
with its own contents, waits idle with only keep-alives going, then checks the amp still answers.
Tested with firmware 1.1.11 on 1 November 2026.

| Where | Result |
|---|---|
| Chrome 156 on a Mac, tab hidden, 10 idle minutes | Passed once the keep-alive ran in a worker |
| Chrome 156 on a Pixel 11 Pro (Android 17), page on screen, 3 idle minutes | Passed |
| Capacitor app on the same phone, on screen | Passed up to the slot 100 write; the idle check wasn't finished |
| iOS | Not tested. Planned on a 2018 iPad Pro through the Capacitor app on 2 November 2026 |

To run it, stop anything else connected to the amp, then:

```sh
pnpm install
pnpm bluetooth-test
```

Open http://localhost:5175 in Chrome. Each run is saved in `_work/bluetooth-test/`, with a copy of
slot 100 taken before the write. Add `?idle=3` for a shorter wait. To reach the page from a phone,
run `adb reverse tcp:5175 tcp:5175`.

## What it found

- **Hidden tabs:** Chrome slows a hidden page's timers to about once a second. The amp stopped
  answering after 8 minutes of that, with the Bluetooth link still open. Timers in a worker keep
  their pace, so the keep-alive has to use `steadyTimer`.
- **Android apps in the background:** Android froze the app about a minute after leaving it, so no
  keep-alives went out. Keep-alives resumed by themselves on return. Staying connected in the
  background isn't a goal for an editor, so the app should check the amp is still answering when
  it returns to the screen and reconnect if not. That check isn't built yet.
- **Leftover packets:** switching on notifications can deliver the end of something the amp was
  already sending, so a middle packet with nothing before it has to be ignored.
- **Device lists:** the amp can appear under two addresses, and Chrome listed both when also
  matching on its name. Filtering on the service is the current setting. Android's list connected
  through the address ending C9:EE and Chrome on the Mac through a different one, and both work.
- **Reconnecting:** Chrome here has no `getDevices`, so after a page reload you have to choose the
  amp from the list again.
- **Numbers:** JavaScript can re-save a long decimal with a different last digit. It's the same
  number, and slot 100 read back exactly as it was before the write.
