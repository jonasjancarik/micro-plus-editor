# Checks on the real amp

Read when testing the editor on an amp or trying the phone apps.

The page runs on the TypeScript code. On 2 November 2026 it controlled the real amp (firmware 1.1.11)
from Chrome on the Mac, on preset 100, and the ticked items below passed. Each change was checked by
reading the preset back from the amp, not by listening. The check at the amp found that MODIFY changes didn't show on the page, which is now fixed.

Fender's user guide explains the amp's buttons. A copy for reference is in `docs/reference/`, which
isn't committed; the original is at
https://www.fmicassets.com/Damroot/Original/10062/OM_2311600000_Mustang-Micro-Plus_EN.pdf. Two
things in it matter here: holding SAVE and TAP while switching on resets presets 1 to 80, including
the empty slots from 71, and the amp only saves MODIFY and tap tempo changes itself.

## In Chrome on the Mac

1. Close Fender Tone and anything else connected to the amp, because it accepts one connection at a
   time.
2. Run `pnpm dev`, open http://localhost:5175 in Chrome and click **Connect to your amp**. Web
   Bluetooth needs `localhost` here. The `.local` and Tailscale addresses won't connect.
3. Switch to preset 100, then export it, so you have a copy of what's in it.
4. Work through the list below on preset 100 only.

- [x] **Switching:** go to another preset and back. The amp's sound and screen change with the page.
- [x] **Editing from the page:** turn a knob on the page and hear it change.
- [x] **Editing on the amp:** press **MODIFY +** a few times on the amp and check the matching setting
      changes on the page. The amp has no knobs: MODIFY changes the one effect setting each preset
      assigns to it, and the display shows which.
- [x] **Changing a model:** swap an amp or a pedal for another one.
- [x] **Reordering:** move a pedal and hear the order change.
- [x] **Saving:** save preset 100, switch away and back, and check your change is still there. Set one
      knob to its maximum before saving and check it stays there. JavaScript writes `1.0` as `1`;
      the amp stored and returned it as `1` with no problem.
- [x] **Undo:** undo that save, and check the earlier sound comes back after switching away and back.
- [x] **Backups:** open the list of backups and download one.
- [x] **Import:** import the file you exported in step 3 into preset 100.
- [x] **Compare:** add two presets to the compare list and switch between them.
- [x] **Losing the amp:** turn it off, check the page says so, turn it on and check it carries on.
      It reconnected by itself. The first preset switch after that got no answer, and the editor
      reconnected again and finished it in about 10 seconds. Later switches were quick.
- [ ] **Staying connected:** leave the tab hidden for ten minutes and check it still answers.

Finish by putting the amp back on the preset you normally use.

## On the iPad

Nothing has run on a real iOS device yet. The app builds and opens on a simulator, where its file
storage works, but simulators have no Bluetooth.

1. Run `pnpm app`, then `open ios/App/App.xcodeproj`.
2. In Xcode, open the App target, go to Signing & Capabilities and choose your team. A free Apple ID
   works, but the app stops opening after 7 days until you install it again.
3. Connect the iPad, choose it as the destination and press Run. Allow Bluetooth when asked.
4. Run the list above. Also check that the app finds the amp again when you leave it and come back.

## On Android

`Micro-Plus-Editor-debug.apk` is in Google Drive under `My Drive/projects`. Build a newer one with:

```sh
pnpm app
(cd android && JAVA_HOME=/opt/homebrew/opt/openjdk@21 ANDROID_HOME=$HOME/Library/Android/sdk ./gradlew assembleDebug)
```

The app opens with the simulated amp on an emulator and its file storage works there. On a phone,
only the earlier Bluetooth test has run, so go through the list above once.

## Removing Python

Done on 2 November 2026, after the checks above. The Python server is in Git history before that
date, and in the old Maneline worktree it came from.
