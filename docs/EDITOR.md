# Micro Plus editor

Read when using or changing the editor, or working on how it talks to the amp over Bluetooth.

The editor can read, switch, edit and save Micro Plus presets over Bluetooth, from Chrome or Edge
on a computer or an Android phone, or from the Android and iOS apps. It supports amplifier and effect
model selection, parameter changes, preset names, and saving to the current slot or another slot.
The USB cable can remain connected for audio and power. You can also export presets to files and
import one into a slot. Restoring a whole exported library at once is not implemented.

Until 2 November 2026 the editor ran on a Python server on the Mac. The TypeScript version replaced
it after the checks in [REAL_AMP_CHECK.md](REAL_AMP_CHECK.md). The test history further down was
mostly gathered with the Python version, which did the same steps over the same protocol.

## Using it

Turn on the Micro Plus and close Fender Tone on other devices, because the amp accepts one
connection at a time. Run `pnpm dev`, open `http://localhost:5175` in Chrome and choose
**Connect to your amp**, then pick the amp from Chrome's list. Web Bluetooth only works on
`localhost` or over HTTPS, so the `.local` and Tailscale addresses can't connect. Chrome asks for the
amp again after every reload, unless it lets pages find devices they've used before, which is
currently behind a setting in `chrome://flags`. The phone apps remember the amp and reconnect by
themselves.

The page has its own stylesheet and needs no internet connection.

The page is built around the board. It follows your system's light or dark setting
unless you choose one with the icons in the top bar. Select the preset name in the
top bar, or press `/`, to open the list of presets, which marks the active one. The
70 factory presets are sorted into groups by sound, each with a short description, and
anything else is listed under Your presets. Factory presets are recognised by name
(see `src/app/presets.ts`), so one you renamed moves to Your
presets, and one you changed but kept the name of keeps its original description. Switch
from In groups to By number to list every preset in slot order instead.

You can make your own groups and use Move on a preset to put it in any group. Moves
belong to the preset's slot, so a preset keeps its group when renamed, and whatever you
save over that slot takes its place in the group. Deleting a group only sends its presets
back to where they started. The groups and descriptions are this editor's own and aren't
stored on the amp. Your groups, compare list and backups are kept on the device you're using, in
the browser's own storage or in the phone app's folder, so another device doesn't see them.

To compare presets whose slots are far apart, choose Add to compare in the top bar or press
`C` on each one, or choose Compare on its row in the list of presets, which adds it without
switching to it. They appear in a strip under the top bar, up to 6 at a time. Select one to
hear it, press `1` to `6` for its position, or press Space to go to the next one. `[` and `]`
still step through every preset by number. If you press several while the amp is changing
preset, which takes about 1.5 seconds, only the last one counts. Switching away from unsaved
changes asks first, as it does anywhere else. Show differences lists each preset's models,
any settings that differ when the model is the same, and the order of its pedals. It reads the
saved presets without changing what the amp is playing. The list belongs to
the slots, so it follows whatever you save there.

In the list, a preset whose name isn't one of the factory presets is labelled Yours. A
factory preset is labelled Edited once it's saved over from this page, or once you select
it and the amp says it isn't the factory version. Saves made elsewhere can only be spotted
that way, and only when the amp reports them, so such a preset can look unchanged. Those records
stay on the device too.

Most factory presets also list artists they're roughly close to, which are
this editor's own judgement. Search by name, sound, artist or group, or type a number to find exactly that slot. Empty slots are hidden until you
ask for them. The arrows in the top bar and the `[` and `]` keys step through the
listed presets in slot order. Selecting a
preset waits for the amp to confirm the change. The display also follows preset
changes received from the device. Switching presets does not rewrite saved preset
settings.

### Editing and saving

Saving was tested only against disposable slot 100 on firmware 1.1.11. Other
destinations use the same write path but were not overwritten during testing. The amp's own
MODIFY buttons change one effect setting per preset, and the page shows those changes too.
Tapping TAP does the same for the delay's Time: the amp reports the new time as a changed
setting, and the preset counts as edited.

The EQ buttons choose one of the amp's nine EQ settings for everything it plays, not for one
preset. The EQ menu in the top bar, next to the connection status, shows the amp's setting,
changes it, and follows the amp's buttons. Each press arrives unasked as reply kind 19:
`9a01 04 0801 10nn`, where `nn` is the setting's position starting from 0 for EQ1 Flat (the
field is left out at 0). Request kind 25 with no content, which the editor sends while
connecting, asks for it. Request kind 22, also sent while connecting, gets reply kind 18:
`0d` with −6.0 as a float, then `1001`, possibly a gain; what it controls isn't known. Request kind 26 sets the EQ, with the same
content as the reply: `0801 10nn` (`0801` alone for Flat). The amp answers with kind 19 holding
the new setting. On 2 November 2026 this set EQ2 and then Flat on the real amp, and the amp kept
answering afterwards. Field 1 has always been 1, and what it means isn't known.

The first time kind 26 was sent, the amp stopped answering over Bluetooth until it was switched
off and on, though its buttons kept working. The same had happened half an hour earlier with
no test command, after the editor's tab had been in the background, and sending kind 26 again
after a restart caused no trouble, so the two are probably unrelated. Messages the editor
doesn't use are written to the browser's console, each different one once.

Choose a preset and it appears as a pedalboard: stompbox, modulation, amp, delay
and reverb, joined by a cable, with each knob labelled. It runs across the screen in
a wide window, and in a narrow one or on a phone it stacks in rows that each read
left to right, with the cable dropping through the amp. Each pedal's footswitch
turns it on or off from the board, and a pedal that's off says so under its name. Hover over a knob on the board to read its value;
a pedal with no knobs, such as the compressor, shows its main setting instead. Select
a pedal or the amp to open a close-up with its knobs and their values; select an empty
position to add an effect. Drag a knob up or down, or scroll over it, or select it and
use the arrow keys; hold Shift while dragging for finer changes. Select the number above
a knob to type a value, and double-click or double-tap a knob to put it back to its
saved setting. In a close-up too tall for the window, a knob only responds to scrolling
once it has been selected, so scrolling past one doesn't change it. A model
with more than six knobs spreads them over pages, and less common settings are
under **More settings**. The buttons along the top of the close-up go to any position on
the board and mark the ones with changes, and the arrows beside the model menu try the
previous or next model, passing over **None**. To close the close-up, choose **Done**, press Escape or
select outside it. Changes are sent to the active sound while you make them.
Ctrl+S or ⌘+S asks to save over the current preset, as **Save** does.
Controls stay usable during a send: the amp takes about a second per change, so
only the newest value of each control is sent and a knob drag is heard in steps.
A parameter change is acknowledged and its updated preset is read back before the
browser accepts it. The editor queries the device's parameter type before
writing, distinguishing continuous float controls from integer choices.

The board is drawn in the order the sound travels, from the preset's connections, so it differs
between presets: many put reverb before delay, and a few put modulation after the amp or the amp first.
The positions themselves are the same five in every preset. To change the order, drag a pedal,
or use the arrows under it (always shown on touch screens, and reachable from the keyboard). With a
finger, hold the pedal still for about a third of a second first; a quicker swipe scrolls the page. The amp has no known way to play a new order live, so it counts as an unsaved change: Save
sends the whole preset to the amp, backed up and read back like an import, and only then can you hear it.

Each amp and pedal has its own look. Amps are drawn as combos, stacks or rack units with their
own covering and grille cloth, and each pedal has its own colour and finish. These are generic
drawings made for this page, not pictures of the real gear. The styles are in
`src/app/micro-plus-looks.css`.

To rename a preset, select the pencil beside its name in the top bar, then save as
usual. On a phone, **Save** and its menu stay at
the bottom of the screen, and **Discard changes** appears only when there's something
to discard. The top bar counts unsaved changes. A pedal with changes is outlined on the board,
changed knobs are marked with a dot, and the close-up offers to undo that pedal's
changes, including a changed model. The list under the board shows each change from
the saved preset, with a **Reset** button for each one, and the browser tab's title
starts with a dot while anything is unsaved. A page opened after edits were made asks
the amp for the saved preset, which only reads it, says "Checking for changes" until it
arrives, and lists the same changes.

The amp has been seen to stop sending saved presets while its connection still looked
healthy, and reconnecting cleared it. After three failed reads in a row the editor
reconnects by itself, at most once every five minutes. The page
says what's happening, and the live preset stayed as it was when this happened on the real
amp. If reads still fail, the page says "May have unsaved changes" and explains that it
can't compare, without reconnecting again until five minutes have passed.

The amp keeps reporting a preset as edited even after every setting is put back, so
the page goes by the comparison instead: once nothing differs from the saved preset,
it shows no unsaved changes and switching presets doesn't ask first.

Normalized values appear as 0–10. Knobs for values the amp stores in real units
(dB, Hz and seconds) use ranges chosen from saved presets with some room on each
side, not from documentation. A saved value outside that range widens the knob
rather than being changed. If the amp stores a different number from the one sent,
for example by limiting it, the control moves to the stored value and the page says
where it stopped. The stored value must also appear in the preset read back from
the amp; otherwise the change counts as unconfirmed and the editor reconnects. Which knobs
each model shows follows Fender Tone's layouts where they were checked and saved
presets elsewhere.
Numbered choices such as **Delay modulation type** and the compressor's **Compression setting**
stay numbered because the amp does not report their names. Nor does it report how far they go,
so their knob has no ends: each small turn up or right adds one and each turn down or left takes one
away, as far as you like. The number beside it can still be typed. String menus include
values observed on the device and may not contain every option supported by the
firmware. Amplifier choices currently cover the app's 25 guitar models. An
unsupported value is reported as an error, not success.

**Save** replaces the active preset, and **Save as copy**, in the menu on the arrow beside **Save**, writes to another slot,
defaulting to the first empty one. Both confirmations name the preset being
replaced. Before writing, the editor reads that slot's saved definition and keeps it
as a backup on the device. The browser may clear its storage to free space, so download backups
you care about from **Backups** in the Presets panel. If the backup cannot be created, no save is
sent. Saving to another slot creates a copy with a new preset ID and
leaves the source's saved contents unchanged. The device's saved response must be
followed by a matching read-back of the destination name and signal chain before
success is reported. Acknowledgement alone is insufficient.

**Undo this save** restores the backup from the most recent save, after backing up
what it replaces. It is available until the page is reloaded.

### Exporting and importing

**Export this preset**, in the menu on the arrow beside **Save**, downloads the current preset as
it's saved on the amp, so unsaved changes aren't in the file. In the Presets panel,
**Export all presets** downloads every preset that isn't an empty slot, along with your
groups, as one file. It reads the presets
one at a time and shows its progress, and other controls wait until it finishes. If a preset
still can't be read after a few tries, or you cancel, no file is downloaded. Files are
downloaded by the browser you're using, so this also works from a phone or another computer.

**Import a preset**, also in the Presets panel, takes a file from either kind of export, or a downloaded
backup. Backups the Python version kept in `_work/preset-backups/` work too. If the file holds several presets, choose one, then choose its name
and the slot to put it in. An import works like **Save as copy**: the slot's saved contents
are backed up first, nothing is sent if that fails, the imported preset gets a new preset ID,
and success is only reported once reading the slot back matches. **Undo this save** covers it
too. Importing into the active slot loses any unsaved edits to it.

An import only changes that one slot. The groups in an all-presets file aren't restored yet.
Files are checked for the amp's five positions and for a matching amp type before anything is
sent. Models aren't compared with the editor's list, because the list is incomplete; the amp
decides, and the read-back catches anything it changed. Files don't record the firmware
they came from. Importing was checked on the amp with slot 100, including a preset whose order
none of the amp's own presets use: it was stored and read back as written, and it sounded clearly
different from the same settings in the usual order, so the amp follows a preset's connections.
The amp moves to the slot it just received, so an import leaves you on that preset.

A preset is long enough to need many Bluetooth packets. Sent back to back, the amp didn't answer
them and then stayed silent until the editor reconnected, so they now go out 30 ms apart.

**Discard changes** reloads the saved preset. Switching away from an edited preset
also asks before discarding live edits or an unsaved name. Browser requests include
the selected slot and an opaque editor revision, so stale controls cannot quietly
edit a different preset. The revision includes a fresh connection identity.

Backups contain the device ID, destination slot and full preset JSON. Older backups have no
restore button; import one instead.

If the amplifier disconnects, the page keeps showing the last settings it read,
with controls disabled and a notice, until the connection recovers. The editor
retries automatically, and gives up on an attempt that hasn't finished after 30 seconds
and starts another. It does not
retry an unconfirmed switch: it reconnects and reads the actual current selection
instead, and the page reports which preset the amp is on.

The amp's Bluetooth sometimes stops answering until the amp is switched off and on, and
Chrome can then keep saying the amp is "no longer in range" even once it's back. After three
failed attempts in a row, the notice offers **Look for your amp again**. In Chrome it opens the device list and starts
over with the amp picked there, without reloading the page; the phone apps search for the amp
again by themselves. The phone apps never show a device list: iPadOS labels a device it hasn't
connected to before "Unknown" there, so they connect to the amp they hear most clearly instead. In the simulator, set `simulator.failedAttempts = 3` while disconnected to see it.

Each lost connection is written to the browser's console, with how long it lasted and why it
ended, and so is each failed attempt to reconnect. For Chrome's own view of the
connection, keep `chrome://bluetooth-internals` open in another tab.

### Working on the page without an amp

Open `http://localhost:5175/?simulator=1` to run the page against a simulated amp, with no
Bluetooth. `&delay=30` makes it answer faster than the real amp's second or so. In the browser's
console, `simulator.setMode('disconnected')`, `'fail'`, `'stall'`, `'noread'` or
`'noread-stuck'` simulates a lost connection, unconfirmed writes, the stall described above, or
saved presets that can't be read; `simulator.setMode('ok')` returns to normal.
`simulator.knob(5)` acts as if someone changed preset on the amp, and
`simulator.limit(node, parameter, value)` makes the next change store a different value. Use it for
anything that would otherwise overwrite presets.

`pnpm test:e2e` runs the page in Chrome against the simulator.

## Persistent connection and verification

The service/characteristic UUIDs, startup sequence and switch command come from Tim Littlefair's
Maneline experiments, which captured them from the amp. The wire protocol uses
zero-based preset indices; the controller converts them to display numbers.
Notifications are reassembled before decoding protobuf messages.

On the tested firmware (1.1.11), one-second keep-alives allowed the connection
to remain open while notifications stopped. Sending the captured heartbeat
`3500050a03c20100` every 250 ms kept notifications working after idle periods.
The original Linux experiment specifies a 500 ms interval. The editor uses 250 ms
to leave scheduling margin and continues sending while a switch awaits its
acknowledgement. Commands are written one at a time, and the page's commands run one at a time. This interval is verified behavior, not a documented
Fender timing guarantee.

Keeping the connection open costs the amp battery: its radio wakes every 45 ms for the link
(measured by Maneline on firmware 1.1.11), on top of the heartbeat. So in the phone and desktop apps,
once the editor has been in the background for a minute (a minimised window, or another app in front
on the phone), it lets go of the amp. It stays connected if there are unsaved changes, because a new
connection would lose them. When the editor is shown again it reconnects, and the top bar says
"Reconnecting…" in the meantime, without the lost-connection warning. A phone that freezes the app in
the background may never run the timer, and then nothing changes. The apps' versions of this haven't
been tried on the real amp yet.

The browser version stays connected. On 12 November 2026 in Chrome 157 on the Mac it let go of the
amp as planned, but then failed every reconnect with "Bluetooth Device is no longer in range" until
the amp was chosen from the device list again, which needs a click. The amp itself was fine. Chrome's
way around this, watching for the amp's advertising, needs a Chrome flag.

It may not cover every case. In one live test on 30 October 2026, about ten minutes
into a connection, a switch reached the amp but no notifications arrived for the
8-second timeout even though heartbeats continued. Reconnecting recovered in about
three seconds. The cause is unknown and this has not been reproduced.

On 30 October 2026 live testing on macOS read all 100 saved preset definitions.
Editor tests were restricted to disposable slot 100, with a backup created before
its first write. Float, integer and boolean parameter edits, effect replacement,
unsaved-change discard, same-slot save and cross-slot copy were exercised. A
saved test name and gain were also verified over a new Bluetooth connection.
The reworked page was then run against slot 100 in the browser: keyboard and
sustained slider edits, a number box, an effect on/off switch, an integer setting,
Reset, saving with a new name, and undo. The saved result survived switching away
and back, and after undo the slot's definition matched its original exactly.

The pedalboard was then run against slot 100, without saving. Dragging a knob, arrow
keys, the board footswitch and the close-up all worked, with each send confirmed in
about a second. Every stompbox, modulation, delay and reverb model and all 25 amps
loaded with their own settings and the expected knobs, in about 1.5 seconds each.
Rate knobs took 0.1 and 10 Hz on the Mod Delay, Flanger and modulated hall; the Mod
Delay's Time took 1.5 s; the modulated hall's Level took −30 and 0 dB; Volume took
−40 dB; the Five-band EQ's Low and Gain took ±12 dB; and the Greenbox's Output took
−24 and 0 dB. A Time of 0.02 s was stored as 0.03 s, so that knob now stops at
0.03 s. That used to cause a reconnect; the editor now accepts the limited value, and
a retest on the amp reported 0.03 s back and kept the same connection. That retest
sent the value without the page, so the page's message about a limited value has only been seen
against the simulator. Time on the other delays and the top of Volume (0 dB) were
not tried; the latter was left out because of the jump in loudness. Discarding
restored the slot's settings.
Disconnect handling is covered by simulated lifecycle tests. On 2 November 2026 the TypeScript
editor was also checked through switching the amp off and on: it said it had lost the amp and
reconnected by itself. The first preset switch afterwards got no answer and needed one more
reconnect, about 10 seconds in all; later switches were quick. Later that day the connection
dropped while switching presets and the editor never reconnected. It had no time limit on
reconnecting then, and Chrome is likely to have waited forever.

```sh
pnpm typecheck
pnpm test
pnpm test:e2e
```

The hardware-independent tests cover captured packets, fragmented names, typed parameters,
acknowledgement and read-back requirements, backups before writes, undo, stale editor state, copy
identities, keep-alives and the page itself against the simulator. `tests/fixtures/wire.json` holds
bytes the Python version produced, so the TypeScript code is checked against what already worked
on the amp.

### Linux

The editor hasn't been tried on Linux. Tim Littlefair's Maneline project got the amp working there
through BlueZ ([pull request 140](https://github.com/tim-littlefair/maneline/pull/140), BlueZ 5.87,
firmware 1.1.11), and found the following, which would also apply to Chrome and to the desktop app on Linux:

- The amp plays audio over classic Bluetooth and takes control over Bluetooth LE. A normal BlueZ
  disconnect closes both, so closing the editor would also stop audio from the computer. Closing
  only the LE link needs BlueZ 5.84 or later with `Experimental = true` in `/etc/bluetooth/main.conf`,
  and a program that uses BlueZ's `Bearer.LE1` interface. Chrome and the desktop app's Bluetooth
  library don't use it.
- The amp has to be paired over LE as well as for audio. If it was only paired for audio, BlueZ
  connects over classic Bluetooth, which has no control service.
- When it connects, BlueZ writes to the Client Supported Features characteristic (`0x2b29`) and the
  amp never answers, so every later request stalls and BlueZ drops the link after 30 s. The fix is to
  delete that entry from BlueZ's cache file for the amp while `bluetoothd` is stopped, and do it again
  whenever BlueZ rediscovers the amp's services.
- Scanning by service UUID made BlueZ reset an Intel AX201 adapter. On desktop Linux the browser
  chooser therefore also matches the amp by name. Elsewhere it doesn't, because that made Chrome list
  the amp twice (see [BLUETOOTH_TEST.md](BLUETOOTH_TEST.md)).

The Linux notes in that pull request have the exact commands.

### Editing protocol

Command and response IDs were recovered from the protobuf descriptors in the
user-installed Fender Tone Android package, version 5.1.3.112680, specifically
`mp/MustangLtxAppMessage.proto`. No app binaries, private app data, or proprietary
implementation code are included in this repository. Model identifiers are
from the app's Micro Plus interface metadata. String choices and numeric display
hints are interface facts observed in preset definitions, not complete firmware
parameter specifications.

| Operation | Request field | Response field |
| --- | --- | --- |
| Read current preset and JSON | 4 | 5 (selection), 4 (JSON) |
| Read saved slot without selecting it | 12 | 10 |
| Read a parameter's value/type | 11 | 9 |
| Set a parameter | 20 | 9 |
| Replace an amp/effect model | 17 | 15 |
| Save the current preset | 5 | 13 |
| Write a preset copy to a slot | 18 | 13 |

Requests use outer field 1 and responses outer field 2. Preset JSON is an LZ4
block inside protobuf bytes fields; no fixed offsets are assumed. Large messages
use transport markers `0x33`, `0x34`, `0x35`. The Micro Plus can emit `0x35` before
the message is complete, so reassembly also checks the protobuf envelope length.
A full-preset write sends all its fragments before any other write, so a heartbeat can't
appear inside a fragmented command.
