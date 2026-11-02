# Checks still to do on the real amp

Read when testing the TypeScript editor on an amp, trying the app on an iPad, or removing Python.

The page runs on the TypeScript code. On 2 November 2026 it controlled the real amp (firmware 1.1.11)
from Chrome on the Mac, on preset 100, and the ticked items below passed. Each change was checked by
reading the preset back from the amp, not by listening. The unticked ones need someone at the amp.

## In Chrome on the Mac

1. Stop the Python server on port 8080, because the amp accepts one connection at a time. Close
   Fender Tone too.
2. Run `pnpm dev`, open http://localhost:5175 in Chrome and click **Connect to your amp**. Web
   Bluetooth needs `localhost` here. The `.local` and Tailscale addresses won't connect.
3. Switch to preset 100, then export it, so you have a copy of what's in it.
4. Work through the list below on preset 100 only.

- [x] **Switching:** go to another preset and back. The amp's sound and screen change with the page.
- [x] **Editing from the page:** turn a knob on the page and hear it change.
- [ ] **Editing on the amp:** turn a knob on the amp and see it move on the page. Switch a pedal off
      and on.
- [x] **Changing a model:** swap an amp or a pedal for another one.
- [x] **Reordering:** move a pedal and hear the order change.
- [x] **Saving:** save preset 100, switch away and back, and check your change is still there. Set one
      knob to its maximum before saving and check it stays there. JavaScript writes `1.0` as `1`;
      the amp stored and returned it as `1` with no problem.
- [x] **Undo:** undo that save, and check the earlier sound comes back after switching away and back.
- [x] **Backups:** open the list of backups and download one.
- [x] **Import:** import the file you exported in step 3 into preset 100.
- [x] **Compare:** add two presets to the compare list and switch between them.
- [ ] **Losing the amp:** turn it off, check the page says so, turn it on and check it carries on.
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

Do this once the Chrome list passes. The Python server is the only proven way to use the amp until
then, and the old copy in the Codex worktree isn't affected by anything in this repo.

1. In `src/app/backend.ts`, remove `ServerBackend`, `servedByPython` and the branch that uses them.
2. Trash `server/` and `run.sh`, and keep `tests/fixtures/wire.json` as a fixed record of what the
   Python code produced.
3. Remove the Python instructions from `README.md` and rewrite the Python parts of
   `docs/MUSTANG_MICRO_PLUS_MACOS.md`.
4. Take out "Saving is still experimental" in `src/app/main.ts` if the checks justify it.
