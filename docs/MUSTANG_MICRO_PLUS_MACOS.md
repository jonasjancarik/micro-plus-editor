# Mustang Micro Plus on macOS

Read when connecting a Micro Plus over Bluetooth, running its browser controls,
or developing its BLE protocol.

Maneline can read, switch, edit and save Micro Plus presets using Bleak's
CoreBluetooth backend. The browser editor supports amplifier/effect model
selection, parameter changes, preset names, and saving to the current slot or
another slot. The USB cable can remain connected for audio and power.
You can also export presets to files and import one into a slot. Signal-chain
reordering and restoring a whole exported library at once are not implemented.

## Setup

Use Python 3.11 or later with Bleak installed. The Python environment created by
`scripts/rebuild_sdk.sh` includes Bleak, or create an isolated environment:

```sh
uv venv _work/mmp-venv
uv pip install --python _work/mmp-venv/bin/python -r scripts/requirements-mmp.txt
```

Turn on the Micro Plus and close Fender Tone on other devices. macOS may ask
the application running Python for Bluetooth permission. If access is denied,
enable it in System Settings > Privacy & Security > Bluetooth before retrying.
macOS holds the app that launched Python responsible: if that app declares no
Bluetooth use, the server prints its address and then crashes with a TCC error in
`~/Library/Logs/DiagnosticReports`. This happened when launching from Claude Code,
so start the server from Terminal or another app with Bluetooth access.

## Browser controls

```sh
bash scripts/run_web_cli.sh --micro-plus
```

Open `http://localhost:8080`. This launch mode serves the Micro Plus page from
`web-app/web_ui`. The page has its own stylesheet, follows the system light or
dark setting, and needs no internet connection. It owns one persistent BLE
connection shared by all browser clients; browser refreshes and preset clicks do
not reconnect the amplifier. The original Java/Lua USB mode is still launched
with `scripts/run_web_cli.sh` without `--micro-plus`.

The page is built around the board. It follows your system's light or dark setting
unless you choose one with the icons in the top bar. Select the preset name in the
top bar, or press `/`, to open the list of presets, which marks the active one. The
70 factory presets are sorted into groups by sound, each with a short description, and
anything else is listed under Your presets. Factory presets are recognised by name
(see `web-app/web_ui/_static/micro-plus-presets.js`), so one you renamed moves to Your
presets, and one you changed but kept the name of keeps its original description. Switch
from In groups to By number to list every preset in slot order instead.

You can make your own groups and use Move on a preset to put it in any group. Moves
belong to the preset's slot, so a preset keeps its group when renamed, and whatever you
save over that slot takes its place in the group. Deleting a group only sends its presets
back to where they started. The groups and descriptions are Maneline's own and aren't
stored on the amp: your groups are in `_work/preset-groups.json` in the checkout the
server runs from, so every browser using this server sees the same groups.

In the list, a preset whose name isn't one of the factory presets is labelled Yours. A
factory preset is labelled Edited once it's saved over from this page, or once you select
it and the amp says it isn't the factory version. Saves made elsewhere can only be spotted
that way, and only when the amp reports them, so such a preset can look unchanged. Those
records are in `_work/preset-saved.json`.

Most factory presets also list artists they're roughly close to, which are
Maneline's own judgement. Search by name, sound, artist or group, or type a number to find exactly that slot. Empty slots are hidden until you
ask for them. The arrows in the top bar and the `[` and `]` keys step through the
listed presets in slot order. Selecting a
preset waits for the amp to confirm the change. The display also follows preset
changes received from the device. Switching presets does not rewrite saved preset
settings.

### Editing and saving

Saving was tested only against disposable slot 100 on firmware 1.1.11. Other
destinations use the same write path but were not overwritten during testing.

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
The positions themselves are the same five in every preset.

Each amp and pedal has its own look. Amps are drawn as combos, stacks or rack units with their
own covering and grille cloth, and each pedal has its own colour and finish. These are generic
drawings made for this page, not pictures of the real gear. The styles are in
`web-app/web_ui/_static/micro-plus-looks.css`.

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
healthy, and reconnecting cleared it. After three failed reads in a row the server
reconnects by itself, at most once every five minutes, and logs each failure. The page
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
the amp; otherwise the change counts as unconfirmed and the server reconnects. Which knobs
each model shows follows Fender Tone's layouts where they were checked and saved
presets elsewhere.
Numbered choices such as **Delay modulation type**
stay numbered because the amp does not report their names. String menus include
values observed on the device and may not contain every option supported by the
firmware. Amplifier choices currently cover the app's 25 guitar models. An
unsupported value is reported as an error, not success.

**Save** replaces the active preset, and **Save as copy**, in the menu on the arrow beside **Save**, writes to another slot,
defaulting to the first empty one. Both confirmations name the preset being
replaced. Before writing, the server reads that slot's saved definition and writes
a JSON backup under `_work/preset-backups/`. If the backup cannot be created, no
save is sent. Saving to another slot creates a copy with a new preset ID and
leaves the source's saved contents unchanged. The device's saved response must be
followed by a matching read-back of the destination name and signal chain before
success is reported. Acknowledgement alone is insufficient.

**Undo this save** restores the backup from the most recent save, after backing up
what it replaces. It is available until the server restarts.

### Exporting and importing

**Export this preset**, in the menu on the arrow beside **Save**, downloads the current preset as
it's saved on the amp, so unsaved changes aren't in the file. In the Presets panel,
**Export all presets** downloads every preset that isn't an empty slot, along with your
groups, as one file. It reads the presets
one at a time and shows its progress, and other controls wait until it finishes. If a preset
still can't be read after a few tries, or you cancel, no file is downloaded. Files are
downloaded by the browser you're using, so this also works from a phone or another computer.

**Import a preset**, also in the Presets panel, takes a file from either kind of export, or a backup from
`_work/preset-backups/`. If the file holds several presets, choose one, then choose its name
and the slot to put it in. An import works like **Save as copy**: the slot's saved contents
are backed up first, nothing is sent if that fails, the imported preset gets a new preset ID,
and success is only reported once reading the slot back matches. **Undo this save** covers it
too. Importing into the active slot loses any unsaved edits to it.

An import only changes that one slot. The groups in an all-presets file aren't restored yet.
Files are checked for the amp's five positions and for a matching amp type before anything is
sent. Models aren't compared with Maneline's list, because the list is incomplete; the amp
decides, and the read-back catches anything it changed. Files don't record the firmware
they came from. Importing was checked on the amp with slot 100, including a preset whose order
none of the amp's own presets use: it was stored and read back as written. The amp moves to the
slot it just received, so an import leaves you on that preset.

A preset is long enough to need many Bluetooth packets. Sent back to back, the amp didn't answer
them and then stayed silent until Maneline reconnected, so they now go out 30 ms apart.

**Discard changes** reloads the saved preset. Switching away from an edited preset
also asks before discarding live edits or an unsaved name. Browser requests include
the selected slot and an opaque editor revision, so stale controls cannot quietly
edit a different preset. The revision includes a fresh connection identity,
including after restarting the server.

Backups contain the device ID, destination slot and full preset JSON. Keep them
when moving or cleaning a worktree. They are not committed to Git. Older backups
have no restore button; the controller's `restore_preset` method uses the verified
full-preset write operation.

If the amplifier disconnects, the page keeps showing the last settings it read,
with controls disabled and a notice, until the connection recovers. The server
retries automatically, using the device ID from the first connection. It does not
retry an unconfirmed switch: it reconnects and reads the actual current selection
instead, and the page reports which preset the amp is on.

### Working on the page without an amp

```sh
_work/mmp-venv/bin/python scripts/mmp_mock.py
```

This serves the real page at `http://localhost:8092` through the real request
handling, against a simulated amp with no Bluetooth. Open `/__mock/mode/disconnected`,
`/__mock/mode/fail`, `/__mock/mode/stall`, `/__mock/mode/noread`,
`/__mock/mode/noread-stuck`, `/__mock/edited-flag` or `/__mock/knob/5` to simulate a lost
connection, unconfirmed writes, the stall described below, or a preset change made
on the amp; `/__mock/mode/ok` returns to normal. Use it for anything that would
otherwise overwrite presets.

Use `--device ID` to select a specific Micro Plus and `--port NUMBER` to change
the HTTP port. If using another Python environment, set `MANELINE_PYTHON` to its
interpreter. The server binds to `0.0.0.0`; localhost and this Mac's hostname and
`.local` hostname are accepted. For another hostname or a numeric LAN address,
add `--allow-host HOSTNAME_OR_IP` (repeatable). Use this on a trusted network;
there is no user login. Browser writes require a matching Origin and Host.

The API is `GET /api/micro-plus` for connection state, selected preset, names and
connection count, and `POST /api/micro-plus` with JSON `{"preset": 72}` to switch.
Preset numbers are 1–100, matching the display. Invalid numbers return HTTP 400;
an unavailable connection or unconfirmed switch returns HTTP 503. A failed
confirmation does not establish that the amplifier stayed on its previous preset.
The editor endpoint is `POST /api/micro-plus/editor` with an `action` of
`parameter`, `model`, `save`, `undo-save`, `read-slot`, or `import`. Each action
except `read-slot` includes `preset` and `revision` from the latest GET response.
Parameter changes also supply `node`, `parameter` and `value`; model changes supply
`node` and `model`; saves supply `target` and `name`; imports supply `target`, `name`
and `document`, the preset itself; and `read-slot` supplies only `slot`. If the amp stored a different number from the one sent, the
parameter response adds `limited` with `node`, `parameter`, `requested` and `stored`.
A stale revision returns HTTP 409, invalid data returns 400, an
unconfirmed device operation returns 503, and a backup-file failure returns 500.
Do not retry an unconfirmed save automatically: read the actual state first.

Traffic logs are appended to `_work/mmp-web.jsonl` and can include preset data.
Stop the server before using any other BLE controller, including the commands
below, so only one program holds the connection.

## One-shot command-line controls

```sh
_work/mmp-venv/bin/python scripts/mmp_ble.py scan
_work/mmp-venv/bin/python scripts/mmp_ble.py status
_work/mmp-venv/bin/python scripts/mmp_ble.py presets
_work/mmp-venv/bin/python scripts/mmp_ble.py preset 72
```

These commands connect, perform one operation and disconnect. Put `--device ID`
before the command to select the ID returned by `scan`. On macOS this is a local
CoreBluetooth UUID, not a Bluetooth MAC address. Multiple matching devices require
an explicit selection. `--log _work/mmp-ble.jsonl` records timestamped BLE traffic.

## Persistent connection and verification

The service/characteristic UUIDs, startup sequence and switch command come from
`mmp_helper.py.disabled` and `mmp_startup.gatttool.json`. The wire protocol uses
zero-based preset indices; the controller converts them to display numbers.
Notifications are reassembled before decoding protobuf messages.

On the tested firmware (1.1.11), one-second keep-alives allowed the connection
to remain open while notifications stopped. Sending the captured heartbeat
`3500050a03c20100` every 250 ms kept notifications working after idle periods.
The original Linux experiment specifies a 500 ms interval. Maneline uses 250 ms
to leave scheduling margin and continues sending while a switch awaits its
acknowledgement. Commands share a write lock, while whole switch operations are
serialized separately. This interval is verified behavior, not a documented
Fender timing guarantee.

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
0.03 s. That used to cause a reconnect; the server now accepts the limited value, and
a retest on the amp reported 0.03 s back and kept the same connection. That retest
sent the value straight to the server rather than from the page, so the page's message
about a limited value has only been seen against the simulator. Time on the other delays and the top of Volume (0 dB) were
not tried; the latter was left out because of the jump in loudness. Discarding
restored the slot's settings.
Disconnect handling is covered by simulated lifecycle tests; physical power-cycle
recovery was not tested.

```sh
_work/mmp-venv/bin/python -m unittest discover -s scripts/tests -v
```

The 54 hardware-independent tests cover captured packets, fragmented names,
typed parameters, acknowledgement and read-back requirements, backups before
writes, undo, stale editor state, copy identities, keep-alives during pending switches,
HTTP validation, same-origin writes and static-file access restrictions.

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
Full-preset writes hold the write lock across their fragments to prevent a
heartbeat from appearing inside a fragmented command.
