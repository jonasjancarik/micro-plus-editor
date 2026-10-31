'use strict';
const $ = id => document.getElementById(id);
const API = '/api/micro-plus';
const EDITOR_API = '/api/micro-plus/editor';
const MESSAGE_SECONDS = 8;
const DOUBLE_TAP_MS = 350;

let state = { connected: false, presets: [], models: {} }; // Latest server reply.
let known = null; // Latest connected reply; stays on screen while the amp is away.
let reachable = true;
let requestRunning = false;
let exclusive = false; // A switch, save or model change owns the amp.
let switchingTo = null;
let epoch = 0; // Discards polls that started before a write.
let reconnectNotice = false;
let checkingAfterNoReply = false;
let reconnectAfterStall = false;

const pendingEdits = new Map(); // "node/parameter" → newest value not yet sent.
let inFlightKey = null;
let sending = false;
let idleWaiters = [];
let dragging = null;

let selectedNode = null; // The pedal open in the close-up.
let builtKey = '';
let renderedNames = '';
let renderedChanges = '';
let formPreset = null;
let advancedOpen = false;
let showEmpty = storedFlag('mmp-show-empty');
let renaming = false;
let nameBeforeRenaming = '';
let sortByNumber = storedFlag('mmp-sort-by-number');
let shownGroup = null; // The one preset group the picker is limited to, if any.
let userGroups = { groups: [], assignments: {} }; // The groups made on this computer, from the server.
let savedPresets = {}; // Slot → the name of a preset seen to be saved there, from the server.
let groupNameCurrent = null; // The group being renamed, whose own name isn't a clash.
const GROUPS_API = '/api/micro-plus/groups';
const NEW_GROUP = '__new__';
const baselines = new Map(); // "generation:preset" → the saved document, for showing what changed.
const pedalTabLabels = { stomp: 'Stomp', mod: 'Mod', amp: 'Amp', delay: 'Delay', reverb: 'Reverb' };

const grid = $('presets');
const filter = $('filter');
const nameInput = $('preset-name');
const editorFields = $('editor');

function storedFlag(key) {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}
function storeFlag(key, value) {
  try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* Only a convenience. */ }
}
function setText(element, text) {
  if (element.textContent !== text) element.textContent = text; // Keeps live regions quiet.
}
function isEmptySlot(preset) { return !preset.name || /^empty$/i.test(preset.name.trim()); }
function displayName(preset) { return isEmptySlot(preset) ? 'Empty' : preset.name; }
function presetByNumber(number) { return known?.presets.find(preset => preset.preset === number); }
function guard() { return { preset: state.preset, revision: state.revision }; }
function documentName() { return known?.document?.info.displayName.trim() ?? ''; }
function nameChanged() { return Boolean(known?.document) && nameInput.value.trim() !== documentName(); }
function shownName() { // A new name shows straight away, though it isn't kept until you save.
  return (formPreset === known?.preset && nameChanged() && nameInput.value.trim()) || known?.name || 'Unnamed preset';
}
function startRenaming() {
  renaming = true;
  nameBeforeRenaming = nameInput.value;
  document.querySelector('.now').classList.add('renaming');
  nameInput.focus();
  nameInput.select();
}
function closeRenaming() {
  renaming = false;
  document.querySelector('.now').classList.remove('renaming');
}
function stopRenaming({ restore = false, refocus = false } = {}) {
  if (!renaming) return;
  closeRenaming();
  nameInput.value = (restore ? nameBeforeRenaming : nameInput.value).trim() || documentName();
  if (refocus) $('rename').focus();
  render();
}
function editsWaiting() { return sending || pendingEdits.size > 0; }
// The amp keeps calling a preset edited even after every setting is back to its saved value.
function edited() { return Boolean(known?.dirty) && !(baseline() && changesFromSaved().length === 0); }
function hasChanges() { return edited() || nameChanged() || editsWaiting(); }

// Messages -----------------------------------------------------------------
let messageTimer;
function showMessage(text, kind = '', { outlastsReconnect = false } = {}) {
  const message = $('message');
  message.hidden = !text;
  message.dataset.kind = kind;
  message.dataset.outlastsReconnect = outlastsReconnect ? 'yes' : '';
  setText(message, text);
  clearTimeout(messageTimer);
  // Problems stay until they're dealt with; good news shouldn't sit there for the rest of the session.
  if (text && kind !== 'error') messageTimer = setTimeout(clearOldNews, MESSAGE_SECONDS * 1000);
}
function clearOldNews() {
  if (exclusive) return; // Still the progress of a running operation, which replaces it when done.
  showMessage('');
  renderStatus();
}

// Talking to the server ----------------------------------------------------
function adopt(next) {
  if (next.preset_groups) userGroups = next.preset_groups;
  if (next.saved_presets) savedPresets = next.saved_presets;
  if (next.stalled) reconnectAfterStall = true;
  if (next.connected) {
    const reconnected = known && known.revision?.split(':')[0] !== next.revision?.split(':')[0];
    if (reconnected && edited()) reconnectNotice = true;
    // A failure message like "reconnecting to check" is out of date once the amp is back.
    const replaceable = !$('message').dataset.outlastsReconnect;
    if (reconnected && replaceable && $('message').dataset.kind === 'error') showMessage(`Reconnected. The amp is on preset ${next.preset}.`);
    if (reconnected && replaceable && reconnectAfterStall) showMessage('Reconnected to your Micro Plus.');
    if (reconnected) reconnectAfterStall = false;
    // The document is briefly missing while the amp changes preset; keep showing the last one.
    known = next.document || !known ? next : { ...next, document: known.document };
    if (next.document && !next.dirty) baselines.set(baselineKey(next), next.document);
    if (checkingAfterNoReply) {
      checkingAfterNoReply = false;
      if (!reconnected) showMessage('The amp is responding. The controls show what it has now.');
    }
    fetchSavedCopy();
  }
  state = next;
}

function baselineKey(snapshot) { return `${snapshot.revision?.split(':')[0]}:${snapshot.preset}`; }

// A page opened after edits never saw the preset clean, so it asks the amp for the saved one.
// Without it the page still works and only can't list the changes, so a few tries are enough.
const SAVED_COPY_TRIES = 3;
const SAVED_COPY_RETRY_MS = 1500;
const savedCopyTries = new Map();
let savedCopyRunning = false;
// While the amp calls the preset edited and the saved copy hasn't arrived, nobody knows yet whether anything differs.
function savedCopyUnknown() { return state.connected && Boolean(known?.dirty && known.document) && !baseline(); }
function savedCopyGaveUp() {
  return savedCopyUnknown() && !savedCopyRunning && (savedCopyTries.get(baselineKey(known)) ?? 0) >= SAVED_COPY_TRIES;
}
function checkingForChanges() { return savedCopyUnknown() && !savedCopyGaveUp() && !nameChanged() && !editsWaiting(); }
async function fetchSavedCopy() {
  if (savedCopyRunning || !known?.dirty || !known.document || baseline()) return;
  const key = baselineKey(known);
  const tries = savedCopyTries.get(key) ?? 0;
  if (tries >= SAVED_COPY_TRIES) return;
  savedCopyTries.set(key, tries + 1);
  savedCopyRunning = true;
  try {
    const reply = await post(EDITOR_API, { action: 'saved-copy', preset: known.preset, revision: known.revision });
    baselines.set(key, reply.saved_document);
  } catch {
    // The server may have just started reconnecting, so a poll gets to report that before this counts as giving up.
    await new Promise(resolve => setTimeout(resolve, SAVED_COPY_RETRY_MS));
  } finally {
    savedCopyRunning = false;
    render();
  }
}

async function readState() {
  if (requestRunning || exclusive || editsWaiting() || document.hidden) return;
  requestRunning = true;
  const started = epoch;
  try {
    const response = await fetch(API, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Unexpected reply');
    const next = await response.json();
    if (started === epoch) { reachable = true; adopt(next); }
  } catch {
    if (started === epoch) { reachable = false; state = { ...state, connected: false, error: null }; }
  } finally {
    requestRunning = false;
    render();
  }
}

async function post(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The Micro Plus did not confirm the change.');
  return result;
}

function failureText(error) {
  if (!(error instanceof TypeError || error.name === 'TimeoutError')) return error.message;
  checkingAfterNoReply = true;
  return 'No reply from the Maneline app, so this change may or may not have reached the amp. Checking…';
}

// Live edits: the newest value per control wins, and controls stay usable while one is being sent.
function queueEdit(node, parameter, value) {
  pendingEdits.set(`${node}/${parameter}`, { node, parameter, value });
  showMessage('');
  reconnectNotice = false;
  pumpEdits();
  renderStatus();
}

async function pumpEdits() {
  if (sending || exclusive) return;
  const [key, edit] = pendingEdits.entries().next().value ?? [];
  if (!key || !state.connected) {
    pendingEdits.clear();
    idleWaiters.splice(0).forEach(resolve => resolve());
    renderStatus();
    return;
  }
  pendingEdits.delete(key);
  sending = true;
  inFlightKey = key;
  epoch++;
  renderStatus();
  try {
    const reply = await post(EDITOR_API, { action: 'parameter', ...guard(), ...edit });
    adopt(reply);
    if (reply.limited) showLimited(reply.limited);
  } catch (error) {
    pendingEdits.clear();
    showMessage(failureText(error), 'error');
    builtKey = ''; // Rebuild from what the amp actually has.
  } finally {
    sending = false;
    inFlightKey = null;
    render();
    pumpEdits();
    if (!editsWaiting()) readState();
  }
}

function showLimited({ node: nodeId, parameter, stored }) {
  const node = nodeById(nodeId);
  if (node) showMessage(`${knobLabel(parameter)} stopped at ${describeValue(node, parameter, stored)}, which is as far as the amp goes here.`);
}

function editsIdle() {
  return new Promise(resolve => {
    if (editsWaiting()) idleWaiters.push(resolve); else resolve();
  });
}

// Operations that need the amp to themselves.
async function exclusiveOperation(url, body, progress, onSuccess) {
  await editsIdle();
  if (exclusive || !state.connected) { switchingTo = null; return false; }
  exclusive = true;
  epoch++;
  const focusKey = editorFields.contains(document.activeElement) ? document.activeElement.dataset?.key : null;
  showMessage(progress);
  render();
  let success = false;
  try {
    adopt(await post(url, body));
    success = true;
    reconnectNotice = false;
    showMessage(onSuccess?.() ?? '');
  } catch (error) {
    showMessage(failureText(error), 'error');
    builtKey = '';
    if (error.message === state.error) state = { ...state, connected: false };
  } finally {
    exclusive = false;
    switchingTo = null;
    render();
    if (focusKey) restoreFocus(focusKey);
    readState();
  }
  return success;
}

function restoreFocus(key) {
  if (document.activeElement && document.activeElement !== document.body) return;
  editorFields.querySelector(`[data-key="${CSS.escape(key)}"]:not(.field)`)?.focus({ preventScroll: true });
}

// Dialogs ------------------------------------------------------------------
function confirmAction(title, text, action) {
  const dialog = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-action').textContent = action;
  dialog.returnValue = 'cancel';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}

function stillSameEditor(expected) {
  if (state.preset === expected.preset && state.revision === expected.revision) return true;
  showMessage('This preset changed since you loaded it. Review its current settings, then try again.', 'error');
  return false;
}

const SAVE_CAUTION = 'Maneline keeps a backup first, and you can undo the save afterwards. '
  + 'Saving is still experimental and has only been tested on a spare slot.';

// Preset switching ---------------------------------------------------------
async function selectPreset(number, { discard = false } = {}) {
  closePicker();
  if (exclusive || !state.connected) return;
  if (number === state.preset && !discard) return;
  await editsIdle();
  const expected = guard();
  if (hasChanges() && !discard) {
    const go = await confirmAction('Discard your unsaved changes?',
      `Switching to preset ${number} loses ${savedCopyGaveUp() ? 'any' : 'your'} edits to this preset.`, 'Discard and switch');
    if (!go || !stillSameEditor(expected)) return;
  }
  switchingTo = number;
  await exclusiveOperation(API, { preset: number }, `Switching to preset ${number}…`, () => {
    formPreset = null; // Discarding has to reset an edited name too.
    return '';
  });
}

function stepPreset(direction) {
  if (!known?.presets.length) return;
  const candidates = known.presets.filter(preset => showEmpty || !isEmptySlot(preset) || preset.preset === known.preset);
  const index = candidates.findIndex(preset => preset.preset === known.preset);
  selectPreset(candidates[(index + direction + candidates.length) % candidates.length].preset);
}

// Saving -------------------------------------------------------------------
async function saveHere() {
  const name = nameInput.value.trim();
  if (!name) { startRenaming(); return; }
  await editsIdle();
  const expected = guard();
  const target = state.preset;
  const factory = known.document?.info.is_factory_default ? 'This is a factory preset. ' : '';
  const go = await confirmAction(`Replace preset ${target}, “${known.name}”?`,
    `“${name}” will replace what's saved there. ${factory}${SAVE_CAUTION}`, `Replace preset ${target}`);
  if (!go || !stillSameEditor(expected)) return;
  await exclusiveOperation(EDITOR_API, { action: 'save', ...guard(), target, name },
    `Backing up and saving preset ${target}…`, () => {
      formPreset = null;
      return `Saved to preset ${target}.`;
    });
}

function renderCopyChoice() {
  const preset = presetByNumber(Number($('copy-target').value));
  if (!preset) return;
  const occupied = !isEmptySlot(preset);
  setText($('copy-warning'), occupied ? `This replaces “${preset.name}”. ${SAVE_CAUTION}` : '');
  setText($('copy-action'), occupied ? `Replace preset ${preset.preset}` : `Save to preset ${preset.preset}`);
}

async function saveCopy() {
  await editsIdle();
  const expected = guard();
  const select = $('copy-target');
  select.replaceChildren(...slotOptions());
  const firstEmpty = known.presets.find(isEmptySlot);
  select.value = String((firstEmpty ?? known.presets.find(preset => preset.preset !== known.preset)).preset);
  $('copy-name').value = nameInput.value.trim() || documentName();
  renderCopyChoice();
  const dialog = $('copy-dialog');
  dialog.returnValue = 'cancel';
  const go = await new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
  if (!go || !stillSameEditor(expected)) return;
  const target = Number(select.value);
  const name = $('copy-name').value.trim();
  await exclusiveOperation(EDITOR_API, { action: 'save', ...guard(), target, name },
    `Saving a copy to preset ${target}…`, () => (target === state.preset
      ? `Saved to preset ${target}.` : `Saved a copy to preset ${target}. You're still editing preset ${state.preset}.`));
}

async function undoSave() {
  const save = state.last_save;
  if (!save) return;
  await editsIdle();
  const expected = guard();
  const current = save.preset === state.preset ? ' Any unsaved edits to it will be lost.' : '';
  const go = await confirmAction(`Undo the save to preset ${save.preset}?`,
    `This puts back what preset ${save.preset} held before you saved “${save.name}”.${current}`, 'Undo the save');
  if (!go || !stillSameEditor(expected)) return;
  await exclusiveOperation(EDITOR_API, { action: 'undo-save', ...guard() }, `Putting preset ${save.preset} back…`, () => {
    formPreset = null;
    return `Preset ${save.preset} is back to what it held before that save.`;
  });
}

// Preset list --------------------------------------------------------------
const YOUR_PRESETS = 'Your presets';
const EMPTY_SLOTS = 'Empty slots';
const factoryPresets = new Map(factoryPresetGroups.flatMap(group =>
  Object.entries(group.presets).map(([name, preset]) => [name, { group: group.name, ...preset }])));

function movableGroups() { return [...userGroups.groups, YOUR_PRESETS, ...factoryPresetGroups.map(group => group.name)]; }
function usualGroup(preset) { return factoryPresets.get(preset.name.trim())?.group ?? YOUR_PRESETS; }
function presetGroup(preset) {
  if (isEmptySlot(preset)) return EMPTY_SLOTS;
  const moved = userGroups.assignments[preset.preset];
  return movableGroups().includes(moved) ? moved : usualGroup(preset);
}
function presetDescription(preset) { return factoryPresets.get(preset?.name?.trim())?.description ?? ''; }
function presetArtists(preset) { return factoryPresets.get(preset?.name?.trim())?.artists ?? []; }
function showArtists(element, artists) {
  const label = document.createElement('span');
  label.className = 'artists-label';
  label.textContent = 'Close to';
  element.replaceChildren(label, ...artists.flatMap(artist => {
    const name = document.createElement('span');
    name.className = 'artist';
    name.textContent = artist;
    return [' ', name];
  }));
}
// Unlabelled presets came with the amp.
function presetOrigin(preset) {
  if (!preset || isEmptySlot(preset)) return '';
  const name = preset.name.trim();
  if (!factoryPresets.has(name)) return 'Yours';
  return savedPresets[preset.preset] === name ? 'Edited' : '';
}

function smallButton(label, onClick, ariaLabel) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
  button.addEventListener('click', onClick);
  return button;
}

function buildPresetList() {
  grid.replaceChildren();
  const groups = [...movableGroups(), EMPTY_SLOTS]
    .map(group => [group, known.presets.filter(preset => presetGroup(preset) === group)])
    .filter(([group, presets]) => presets.length || userGroups.groups.includes(group));
  for (const [group, presets] of sortByNumber ? [[null, known.presets]] : groups) {
    if (group) {
      const bank = document.createElement('li');
      bank.className = 'bank';
      bank.dataset.group = group;
      const heading = document.createElement('span');
      heading.className = 'bank-name';
      heading.textContent = group;
      bank.append(heading);
      if (userGroups.groups.includes(group)) {
        bank.dataset.custom = 'true';
        const note = document.createElement('span');
        note.className = 'bank-note';
        note.textContent = 'No presets yet. Choose Move on any preset to add it here.';
        bank.append(smallButton('Rename', () => renameGroup(group), `Rename ${group}`),
          smallButton('Delete', () => deleteGroup(group), `Delete ${group}`), note);
      }
      grid.append(bank);
    }
    for (const preset of presets) {
      const item = document.createElement('li');
      item.className = 'row';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = isEmptySlot(preset) ? 'preset empty-slot' : 'preset';
      button.dataset.preset = preset.preset;
      const number = document.createElement('span');
      number.className = 'num';
      number.textContent = preset.preset;
      const text = document.createElement('span');
      text.className = 'text';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = displayName(preset);
      const origin = presetOrigin(preset);
      if (origin) {
        const label = document.createElement('span');
        label.className = 'origin';
        label.textContent = origin;
        name.append(' ', label);
      }
      text.append(name);
      const description = presetDescription(preset);
      if (description) {
        const about = document.createElement('span');
        about.className = 'about';
        about.textContent = description;
        text.append(about);
      }
      if (presetArtists(preset).length) {
        const artists = document.createElement('span');
        artists.className = 'artists';
        showArtists(artists, presetArtists(preset));
        text.append(artists);
      }
      const badge = document.createElement('span');
      badge.className = 'badge';
      button.append(number, text, badge);
      item.append(button);
      if (!isEmptySlot(preset)) {
        const move = smallButton('Move', () => movePreset(preset.preset), `Move ${preset.name} to another group`);
        move.className = 'move';
        move.tabIndex = -1; // Reached with the right arrow from its preset, so the list stays one tab stop.
        item.append(move);
      }
      grid.append(item);
    }
  }
  const shown = groups.map(([group]) => group).filter(group => group !== EMPTY_SLOTS);
  if (sortByNumber || !shown.includes(shownGroup)) shownGroup = null;
  $('preset-groups').hidden = sortByNumber;
  $('preset-groups').replaceChildren(...[null, ...shown].map(group => {
    const chip = smallButton(group ?? 'All', () => {
      shownGroup = group;
      filter.value = '';
      renderPresets();
      $('presets-scroll').scrollTop = 0;
    });
    chip.dataset.group = group ?? '';
    return chip;
  }), smallButton('+ New group', newGroup));
}

// Your own groups live on this computer, so changing them never touches the amp.
function groupNameProblem(name, current = null) {
  const taken = [...movableGroups(), EMPTY_SLOTS, 'All'].filter(group => group !== current);
  const match = taken.find(group => group.toLocaleLowerCase() === name.toLocaleLowerCase());
  return match ? `There's already a group called “${match}”. Choose another name.` : '';
}

async function changeGroups(body) {
  setText($('picker-status'), '');
  epoch++; // A reply already on its way would otherwise bring the old groups back for a moment.
  try {
    adopt(await post(GROUPS_API, body));
    render();
    return true;
  } catch (error) {
    setText($('picker-status'), error instanceof TypeError || error.name === 'TimeoutError'
      ? "No reply from the Maneline app, so your groups didn't change." : error.message);
    return false;
  }
}

function askGroupName(title, action, value = '', current = null) {
  const dialog = $('group-dialog');
  setText($('group-title'), title);
  setText($('group-action'), action);
  setText($('group-error'), '');
  $('group-name').value = value;
  groupNameCurrent = current;
  dialog.returnValue = 'cancel';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm' ? $('group-name').value.trim() : null), { once: true });
    dialog.showModal();
  });
}

async function newGroup() {
  const name = await askGroupName('New group', 'Create group');
  if (name && await changeGroups({ action: 'create', name })) shownGroup = null;
}

async function renameGroup(group) {
  const name = await askGroupName(`Rename “${group}”`, 'Rename', group, group);
  if (!name || name === group) return;
  const wasShown = shownGroup === group;
  if (await changeGroups({ action: 'rename', name: group, new_name: name }) && wasShown) {
    shownGroup = name;
    renderPresets();
  }
}

async function deleteGroup(group) {
  const count = known.presets.filter(preset => presetGroup(preset) === group).length;
  const text = count ? `${count === 1 ? 'Its preset goes' : `Its ${count} presets go`} back to where ${count === 1 ? 'it' : 'they'} started. Nothing on your amp changes.`
    : 'This group has no presets in it.';
  if (await confirmAction(`Delete “${group}”?`, text, 'Delete group')) await changeGroups({ action: 'delete', name: group });
}

function showMoveNameField() {
  $('move-new').hidden = $('move-target').value !== NEW_GROUP;
  if (!$('move-new').hidden) $('move-name').focus();
  $('move-name').required = !$('move-new').hidden;
}

async function movePreset(number) {
  const preset = presetByNumber(number);
  const current = presetGroup(preset);
  const usual = usualGroup(preset);
  const select = $('move-target');
  const option = (value, text) => { const entry = document.createElement('option'); entry.value = value; entry.textContent = text; return entry; };
  select.replaceChildren(option(NEW_GROUP, 'New group…'),
    ...movableGroups().map(group => option(group, group === usual ? `${group} (where it started)` : group)));
  select.value = userGroups.groups.length || current !== YOUR_PRESETS ? current : NEW_GROUP;
  setText($('move-title'), `Move “${preset.name}”`);
  setText($('move-error'), '');
  $('move-name').value = '';
  const dialog = $('move-dialog');
  dialog.returnValue = 'cancel';
  const go = new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
  dialog.showModal();
  showMoveNameField();
  if (!await go) return;
  let target = select.value;
  if (target === NEW_GROUP) {
    target = $('move-name').value.trim();
    if (!await changeGroups({ action: 'create', name: target })) return;
  }
  if (target !== current) await changeGroups({ action: 'move', preset: number, group: target === usual ? null : target });
  const row = grid.querySelector(`.preset[data-preset="${number}"]`);
  if (row && !row.parentElement.hidden) { row.focus(); row.scrollIntoView({ block: 'nearest' }); }
  else filter.focus();
}

const searchText = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase(); // So "motley" finds Mötley Crüe.

function matchesSearch(preset, query) {
  if (!query) return true;
  if (/^\d+$/.test(query)) return preset.preset === Number(query); // Numbers mean slots, not "contains 7".
  return [displayName(preset), presetDescription(preset), ...presetArtists(preset), presetGroup(preset), presetOrigin(preset)]
    .some(text => searchText(text).includes(query));
}

function visiblePresetButtons() {
  return [...grid.querySelectorAll('.preset')].filter(button => !button.parentElement.hidden);
}

function renderPresets() {
  if (!known) return;
  const names = JSON.stringify([known.presets, userGroups, savedPresets, sortByNumber]);
  if (names !== renderedNames) {
    const hadFocus = grid.contains(document.activeElement) ? document.activeElement.dataset.preset : null;
    buildPresetList();
    renderedNames = names;
    if (hadFocus) grid.querySelector(`[data-preset="${hadFocus}"]`)?.focus();
  }
  const query = searchText(filter.value).trim();
  const emptyCount = known.presets.filter(isEmptySlot).length;
  let visible = 0;
  let bank = null;
  let bankHasItems = false;
  const settleBank = () => {
    if (!bank) return;
    // Your own group stays visible while it's empty, or there'd be nowhere to rename or delete it.
    const keep = bank.dataset.custom && !query && (!shownGroup || shownGroup === bank.dataset.group);
    bank.hidden = !bankHasItems && !keep;
    const note = bank.querySelector('.bank-note');
    if (note) note.hidden = bankHasItems;
  };
  for (const item of grid.children) {
    if (item.classList.contains('bank')) {
      settleBank();
      bank = item;
      bankHasItems = false;
      continue;
    }
    const button = item.firstElementChild;
    const number = Number(button.dataset.preset);
    const preset = presetByNumber(number);
    const active = number === known.preset;
    const wanted = query ? matchesSearch(preset, query)
      : shownGroup ? presetGroup(preset) === shownGroup
      : showEmpty || !isEmptySlot(preset) || active;
    item.hidden = !wanted;
    if (wanted) { visible++; bankHasItems = true; }
    if (active) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
    setText(button.querySelector('.badge'), number === switchingTo ? 'Switching…' : active ? 'Active' : '');
  }
  settleBank();
  for (const chip of $('preset-groups').querySelectorAll('[data-group]')) {
    chip.setAttribute('aria-pressed', String(!query && chip.dataset.group === (shownGroup ?? '')));
  }
  grid.classList.toggle('unavailable', !state.connected);
  grid.setAttribute('aria-busy', String(exclusive));
  const focusable = visiblePresetButtons();
  const rover = focusable.find(button => button.getAttribute('aria-current') === 'true') ?? focusable[0];
  for (const button of grid.querySelectorAll('.preset')) button.tabIndex = button === rover ? 0 : -1;
  setText($('count'), query ? `${visible} of ${known.presets.length}` : `${known.presets.length - emptyCount} presets`);
  setText($('show-empty-label'), `Show ${emptyCount} empty`);
  $('show-empty').checked = showEmpty;
  $('view-groups').setAttribute('aria-pressed', String(!sortByNumber));
  $('view-number').setAttribute('aria-pressed', String(sortByNumber));
  $('empty').hidden = visible > 0 || !query;
}

function scrollToActive(block = 'nearest') {
  grid.querySelector('[aria-current="true"]')?.scrollIntoView({ block });
}

// Editor: building controls --------------------------------------------------
function currentNodes() { return known?.document?.audioGraph.nodes ?? []; }
function nodeById(id) { return currentNodes().find(node => node.nodeId === id); }
function nodeTitle(node) { return nodeLabels[node.nodeId] || parameterLabel(node.nodeId); }
function modelName(node) {
  return (known.models[node.nodeId] || []).find(model => model.id === node.FenderId)?.name || 'Current model';
}
function specFor(node, parameter, value) {
  return controlSpec(parameter, value, (known.unscaled?.[node.FenderId] || []).includes(parameter),
    known.parameter_choices?.[parameter], node.FenderId);
}

// Controls are only rebuilt when their shape changes, so focus and drags survive edits.
function shapeKey() {
  return JSON.stringify([selectedNode, currentNodes().map(node => [node.nodeId, node.FenderId,
    Object.entries(node.dspUnitParameters).map(([key, value]) => [key, specFor(node, key, value).kind])])]);
}

const nodeColours = { stomp: '#fe6a38', mod: '#2bc4a0', amp: '#5d5a54', delay: '#5a9bea', reverb: '#a184ea' };
const addLabels = { stomp: 'Add a stompbox', mod: 'Add modulation', delay: 'Add a delay', reverb: 'Add a reverb' };

function isEmptyNode(node) { return node.FenderId === 'DUBS_Unknown'; }
function hasBypass(node) { return 'bypass' in node.dspUnitParameters && !isEmptyNode(node); }
function specOfNode(node) { return key => specFor(node, key, node.dspUnitParameters[key]); }

function bindBypass(input, node) {
  input.addEventListener('change', () => {
    for (const twin of controlsFor(`${node.nodeId}/bypass`)) writeControl(twin, !input.checked);
    queueEdit(node.nodeId, 'bypass', !input.checked);
  });
}

function controlsFor(key) {
  return editorFields.querySelectorAll(`[data-key="${CSS.escape(key)}"]:not(.field)`);
}

// The board: one small pedal per position, joined by a cable.
function buildBoard() {
  const board = $('board');
  board.replaceChildren();
  for (const node of currentNodes()) {
    const slot = document.createElement('div');
    slot.className = 'slot';
    slot.dataset.node = node.nodeId;
    if (isEmptyNode(node)) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'empty-position';
      add.textContent = addLabels[node.nodeId] || `Add ${nodeTitle(node).toLowerCase()}`;
      add.addEventListener('click', () => openCloseup(node.nodeId));
      slot.append(add);
      board.append(slot);
      continue;
    }
    const pedal = document.createElement('div');
    pedal.className = node.nodeId === 'amp' ? 'pedal light-ink board-pedal' : 'pedal board-pedal';
    pedal.style.setProperty('--tint', nodeColours[node.nodeId]);
    pedal.dataset.model = node.FenderId;
    const face = document.createElement('div');
    face.className = 'face';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'open-pedal';
    open.setAttribute('aria-label', `Open ${modelName(node)}, ${nodeTitle(node)}`);
    const dials = document.createElement('span');
    dials.className = 'mini-dials';
    const { knobs, main } = splitParameters(node, specOfNode(node));
    if (!knobs.length && main.length) {
      // A pedal with no knobs shows its main setting instead, so you can still read it from the board.
      const setting = document.createElement('span');
      setting.className = 'mini-setting';
      setting.dataset.setting = `${node.nodeId}/${main[0]}`;
      dials.append(setting);
    }
    for (const parameter of knobs.slice(0, node.nodeId === 'amp' ? 5 : 3)) {
      const dial = document.createElement('span');
      dial.className = 'mini-dial';
      dial.dataset.mini = `${node.nodeId}/${parameter}`;
      dial.innerHTML = partImage('knob', 'body') + partImage('pointer', 'pointer');
      const label = document.createElement('span');
      label.className = 'mini-label';
      label.textContent = knobLabel(parameter);
      const knob = document.createElement('span');
      knob.className = 'mini-knob';
      knob.append(dial, label);
      dials.append(knob);
    }
    const light = document.createElement('span');
    light.className = 'light';
    light.innerHTML = partImage('light-off', 'unlit') + partImage('light-on', 'lit');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = modelName(node);
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = nodeTitle(node);
    open.append(dials, light, name, kind);
    open.addEventListener('click', () => openCloseup(node.nodeId));
    face.append(open);
    if (hasBypass(node)) {
      const foot = buildFootswitch(modelName(node), !node.dspUnitParameters.bypass, `${node.nodeId}/bypass`);
      bindBypass(foot.querySelector('input'), node);
      face.append(foot);
    }
    pedal.append(face);
    slot.append(pedal);
    board.append(slot);
  }
}

function buildKnobSpec(node, parameter) {
  const value = node.dspUnitParameters[parameter];
  const spec = specFor(node, parameter, value);
  const shown = value * spec.scale;
  return { label: knobLabel(parameter), value: shown, min: Math.min(spec.min, shown), max: Math.max(spec.max, shown),
    step: spec.step, format: text => formatKnob(spec, text), key: `${node.nodeId}/${parameter}` };
}

function bindKnobs(root, node) {
  for (const input of root.querySelectorAll('.knob input')) {
    const parameter = input.dataset.key.split('/')[1];
    const spec = specFor(node, parameter, node.dspUnitParameters[parameter]);
    input.addEventListener('input', () => queueEdit(node.nodeId, parameter, Number(input.value) / spec.scale));
    const dial = input.closest('.knob').querySelector('.dial');
    let downX = 0;
    let downY = 0;
    let lastTap = 0;
    dial.addEventListener('pointerdown', event => {
      dragging = input;
      downX = event.clientX;
      downY = event.clientY;
    });
    // Counted by hand because not every phone browser reports a double tap, and a knob swallows the gesture anyway.
    dial.addEventListener('pointerup', event => {
      if (Math.hypot(event.clientX - downX, event.clientY - downY) > 5) { lastTap = 0; return; }
      const second = event.timeStamp - lastTap < DOUBLE_TAP_MS;
      lastTap = second ? 0 : event.timeStamp;
      const saved = baselineValue(node.nodeId, parameter);
      if (second && saved !== undefined && !input.disabled) resetToSaved(node.nodeId, parameter, saved);
    });
  }
}

function buildField(node, parameter, value) {
  const spec = specFor(node, parameter, value);
  const key = `${node.nodeId}/${parameter}`;
  const id = `control-${node.nodeId}-${parameter}`;
  const field = document.createElement('div');
  field.className = 'field';
  field.dataset.key = key;
  const head = document.createElement('div');
  head.className = 'field-head';
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = spec.label || parameterLabel(parameter);
  head.append(label);
  let control;
  if (spec.kind === 'toggle') {
    field.classList.add('toggle-field');
    control = document.createElement('input');
    control.type = 'checkbox';
    control.addEventListener('change', () => queueEdit(node.nodeId, parameter, control.checked));
    label.prepend(control);
  } else if (spec.kind === 'select') {
    control = document.createElement('select');
    for (const choice of new Set([value, ...known.parameter_choices[parameter]])) {
      const option = document.createElement('option');
      option.value = choice;
      option.textContent = choiceLabels[choice] || parameterLabel(choice);
      control.append(option);
    }
    control.addEventListener('change', () => queueEdit(node.nodeId, parameter, control.value));
  } else {
    control = document.createElement('input');
    if (spec.kind === 'knob') {
      control.type = 'range';
      control.min = String(Math.min(spec.min, value * spec.scale));
      control.max = String(Math.max(spec.max, value * spec.scale));
      control.step = String(spec.step);
      const output = document.createElement('output');
      output.htmlFor = id;
      head.append(output);
      control.addEventListener('pointerdown', () => { dragging = control; });
      control.addEventListener('input', () => {
        output.textContent = formatKnob(spec, control.value);
        queueEdit(node.nodeId, parameter, Number(control.value) / spec.scale);
      });
    } else if (spec.kind === 'number') {
      control.type = 'number';
      control.step = String(spec.step);
      control.inputMode = spec.step === 1 ? 'numeric' : 'decimal';
      if (spec.min !== undefined) control.min = String(spec.min);
      control.addEventListener('change', () => {
        const number = Number(control.value);
        if (control.value === '' || !Number.isFinite(number)) { syncControl(control); return; }
        queueEdit(node.nodeId, parameter, number);
      });
    } else {
      control.type = 'text';
      control.addEventListener('change', () => queueEdit(node.nodeId, parameter, control.value));
    }
  }
  control.id = id;
  control.dataset.key = key;
  head.append(resetButton(node, parameter));
  if (spec.kind === 'toggle') field.append(head);
  else field.append(head, control);
  return field;
}

function resetButton(node, parameter) {
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'reset';
  reset.hidden = true;
  reset.textContent = 'Reset';
  reset.setAttribute('aria-label', `Reset ${parameterLabel(parameter)} to its saved value`);
  reset.addEventListener('click', () => {
    const saved = baselineValue(node.nodeId, parameter);
    if (saved === undefined) return;
    resetToSaved(node.nodeId, parameter, saved);
    controlsFor(`${node.nodeId}/${parameter}`)[0]?.focus({ preventScroll: true });
  });
  return reset;
}

function resetToSaved(nodeId, parameter, saved) {
  queueEdit(nodeId, parameter, saved);
  for (const control of controlsFor(`${nodeId}/${parameter}`)) writeControl(control, saved);
}

// Changing the model replaces the pedal's settings, so the saved model goes back first and its settings after it.
async function restorePedal(nodeId) {
  const model = changesFromSaved().find(change => change.nodeId === nodeId && change.savedModel);
  if (model && !await exclusiveOperation(EDITOR_API, { action: 'model', ...guard(), node: nodeId, model: model.savedModel },
    'Changing model…')) return;
  for (const change of changesFromSaved()) {
    if (change.nodeId === nodeId && change.parameter) resetToSaved(nodeId, change.parameter, change.saved);
  }
}

function stepModel(node, direction) {
  // Stepping is for trying sounds, so it passes over the choice that removes the pedal.
  const choices = (known.models[node.nodeId] || []).filter(model => model.id !== 'DUBS_Unknown');
  const index = choices.findIndex(model => model.id === node.FenderId);
  const model = choices[(index + direction + choices.length) % choices.length];
  if (model) exclusiveOperation(EDITOR_API, { action: 'model', ...guard(), node: node.nodeId, model: model.id }, `Changing to ${model.name}…`);
}

function buildModelPicker(node) {
  const row = document.createElement('div');
  row.className = 'model-row';
  const label = document.createElement('label');
  label.className = 'model-picker';
  const name = document.createElement('span');
  name.textContent = node.nodeId === 'amp' ? 'Amp model' : 'Effect';
  const select = document.createElement('select');
  select.dataset.key = `${node.nodeId}/#model`;
  const choices = known.models[node.nodeId] || [];
  const options = choices.some(model => model.id === node.FenderId) ? choices
    : [{ id: node.FenderId, name: modelName(node) }, ...choices];
  for (const model of options) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.name;
    select.append(option);
  }
  select.value = node.FenderId;
  select.addEventListener('change', () => {
    exclusiveOperation(EDITOR_API, { action: 'model', ...guard(), node: node.nodeId, model: select.value }, 'Changing model…');
  });
  label.append(name, select);
  row.append(label);
  if (!isEmptyNode(node)) {
    const what = node.nodeId === 'amp' ? 'amp model' : 'effect';
    for (const [text, direction, word] of [['\u2039', -1, 'previous'], ['\u203a', 1, 'next']]) {
      const step = document.createElement('button');
      step.type = 'button';
      step.className = 'icon';
      step.textContent = text;
      step.dataset.key = `${node.nodeId}/#model${direction}`;
      step.title = `Try the ${word} ${what}`;
      step.setAttribute('aria-label', step.title);
      step.addEventListener('click', () => stepModel(nodeById(node.nodeId), direction));
      row.append(step);
    }
  }
  return row;
}

// The close-up: the chosen pedal at full size, with anything less common tucked away below it.
function buildCloseup() {
  const body = $('closeup-body');
  body.replaceChildren();
  const node = nodeById(selectedNode);
  if (!node) return;
  setText($('closeup-title'), isEmptyNode(node) ? (addLabels[node.nodeId] || nodeTitle(node)) : modelName(node));
  setText($('closeup-kind'), isEmptyNode(node) ? 'Nothing is in this position yet. Choose an effect to add one.' : nodeTitle(node));
  if (!isEmptyNode(node)) {
    const { knobs, main, extras } = splitParameters(node, specOfNode(node));
    const pedal = buildPedal({ name: modelName(node), colour: nodeColours[node.nodeId], lightInk: node.nodeId === 'amp',
      knobs: knobs.map(parameter => buildKnobSpec(node, parameter)), footswitch: hasBypass(node),
      on: !node.dspUnitParameters.bypass, bypassKey: `${node.nodeId}/bypass` });
    bindKnobs(pedal, node);
    const foot = pedal.querySelector('.foot input');
    if (foot) bindBypass(foot, node);
    const stage = document.createElement('div');
    stage.className = 'closeup-stage';
    stage.append(pedal);
    body.append(stage, buildModelPicker(node));
    if (main.length) {
      const fields = document.createElement('div');
      fields.className = 'fields';
      for (const parameter of main) fields.append(buildField(node, parameter, node.dspUnitParameters[parameter]));
      body.append(fields);
    }
    if (knobs.length && !storedFlag('mmp-knob-tip-seen')) {
      const tip = document.createElement('p');
      tip.className = 'knob-tip';
      tip.textContent = window.matchMedia('(pointer: coarse)').matches
        ? 'Drag a knob up or down, or tap its number to type a value. Double-tap a knob to put it back to its saved setting.'
        : 'Drag or scroll over a knob to turn it, or select its number to type a value. Double-click a knob to put it back to its saved setting.';
      body.append(tip);
    }
    body.append(buildUndoButton(node));
    if (extras.length) {
      const details = document.createElement('details');
      details.id = 'advanced';
      details.open = advancedOpen;
      details.addEventListener('toggle', () => { advancedOpen = details.open; });
      const summary = document.createElement('summary');
      summary.textContent = `More settings (${extras.length})`;
      const more = document.createElement('div');
      more.className = 'fields';
      for (const parameter of extras) more.append(buildField(node, parameter, node.dspUnitParameters[parameter]));
      details.append(summary, more);
      body.append(details);
    }
  } else {
    body.append(buildModelPicker(node), buildUndoButton(node));
  }
}

function buildUndoButton(node) {
  const undo = document.createElement('button');
  undo.type = 'button';
  undo.id = 'closeup-undo';
  undo.hidden = true;
  undo.textContent = node.nodeId === 'amp' ? 'Undo my changes to the amp' : 'Undo my changes to this pedal';
  undo.addEventListener('click', () => restorePedal(node.nodeId));
  return undo;
}

function openCloseup(nodeId) {
  selectedNode = nodeId;
  builtKey = '';
  renderEditor();
  renderStatus();
  const dialog = $('closeup');
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
}

// One button per position in signal order, so you can move around the board without closing the close-up.
function renderCloseupTabs(changes) {
  const tabs = $('closeup-tabs');
  const nodes = currentNodes();
  if ([...tabs.children].map(tab => tab.dataset.node).join() !== nodes.map(node => node.nodeId).join()) {
    tabs.replaceChildren(...nodes.map(node => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.dataset.node = node.nodeId;
      tab.textContent = pedalTabLabels[node.nodeId] || nodeTitle(node);
      tab.addEventListener('click', () => openCloseup(node.nodeId));
      return tab;
    }));
  }
  for (const tab of tabs.children) {
    const node = nodeById(tab.dataset.node);
    const empty = isEmptyNode(node);
    const off = hasBypass(node) && node.dspUnitParameters.bypass;
    const text = `${empty ? `Empty ${nodeTitle(node).toLowerCase()} position` : `${modelName(node)}, ${nodeTitle(node)}`}${off ? ', off' : ''}`;
    tab.title = text;
    tab.setAttribute('aria-label', text);
    if (tab.dataset.node === selectedNode) tab.setAttribute('aria-current', 'true'); else tab.removeAttribute('aria-current');
    tab.classList.toggle('muted', empty || off);
    tab.classList.toggle('has-changes', changes.some(change => change.nodeId === tab.dataset.node));
  }
}

// Editor: keeping controls in step with the amp ------------------------------
function writeControl(control, value) {
  if (control.type === 'checkbox') {
    const isBypass = control.dataset.key.endsWith('/bypass');
    control.checked = isBypass ? !value : Boolean(value);
    if (isBypass) {
      const pedal = control.closest('.pedal');
      if (pedal) setPedalOn(pedal, control.checked);
    }
  } else if (control.type === 'range') {
    const [nodeId, parameter] = control.dataset.key.split('/');
    const spec = specFor(nodeById(nodeId), parameter, value);
    const shown = value * spec.scale;
    // An amp value past the usual travel widens the knob instead of being misreported.
    if (shown < Number(control.min)) control.min = String(shown);
    if (shown > Number(control.max)) control.max = String(shown);
    control.value = String(shown);
    control.repaintKnob?.();
    const output = control.closest('.field')?.querySelector('output');
    if (output) setText(output, formatKnob(spec, control.value));
  } else if (control.type === 'number') {
    if (Number(control.value) !== Number(value.toPrecision(6)) || control.value === '') control.value = String(Number(value.toPrecision(6)));
  } else if (control.value !== value) {
    control.value = value;
  }
}

function syncControl(control) {
  const key = control.dataset.key;
  if (!key || key === inFlightKey || pendingEdits.has(key) || control === dragging) return;
  const typing = document.activeElement === control && (control.type === 'number' || control.type === 'text');
  if (typing) return;
  const [nodeId, parameter] = key.split('/');
  const node = nodeById(nodeId);
  if (!node) return;
  if (parameter === '#model') { control.value = node.FenderId; return; }
  if (parameter in node.dspUnitParameters) writeControl(control, node.dspUnitParameters[parameter]);
}

function baseline() { return known ? baselines.get(baselineKey(known)) : null; }
function baselineValue(nodeId, parameter) {
  const node = baseline()?.audioGraph.nodes.find(entry => entry.nodeId === nodeId);
  const current = nodeById(nodeId);
  return node && current && node.FenderId === current.FenderId ? node.dspUnitParameters[parameter] : undefined;
}
function sameValue(a, b) {
  return typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-4 : a === b;
}

function changesFromSaved() {
  const saved = baseline();
  if (!saved) return [];
  const changes = [];
  for (const node of currentNodes()) {
    const before = saved.audioGraph.nodes.find(entry => entry.nodeId === node.nodeId);
    if (!before) continue;
    if (before.FenderId !== node.FenderId) {
      const name = id => (known.models[node.nodeId] || []).find(model => model.id === id)?.name || 'Other';
      changes.push({ nodeId: node.nodeId, savedModel: before.FenderId,
        text: `${nodeTitle(node)} model: ${name(before.FenderId)} → ${name(node.FenderId)}` });
      continue;
    }
    for (const [parameter, value] of Object.entries(node.dspUnitParameters)) {
      if (parameter === 'bypassType' || !(parameter in before.dspUnitParameters)
        || sameValue(before.dspUnitParameters[parameter], value)) continue;
      const what = parameter === 'bypass' ? nodeTitle(node) : `${nodeTitle(node)} · ${parameterLabel(parameter)}`;
      changes.push({ nodeId: node.nodeId, parameter, saved: before.dspUnitParameters[parameter],
        text: `${what}: ${describeValue(node, parameter, before.dspUnitParameters[parameter])} → ${describeValue(node, parameter, value)}` });
    }
  }
  return changes;
}

function describeValue(node, parameter, value) {
  if (parameter === 'bypass') return value ? 'Off' : 'On';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'string') return choiceLabels[value] || parameterLabel(value);
  const spec = specFor(node, parameter, value);
  if (spec.kind === 'knob') return formatKnob(spec, value * spec.scale);
  return Number(value.toPrecision(4)).toLocaleString();
}

function renderChanges(changes) {
  const named = nameChanged();
  const count = changes.length + (named ? 1 : 0);
  $('changes').hidden = count === 0;
  setText($('changes-summary'), count === 1 ? 'See 1 change from the saved preset' : `See ${count} changes from the saved preset`);
  const list = $('changes-list');
  const signature = JSON.stringify([named && nameInput.value.trim(), changes.map(change => change.text)]);
  if (signature === renderedChanges) return; // Rebuilding every poll would steal focus from Reset.
  renderedChanges = signature;
  list.replaceChildren();
  if (named) {
    const item = document.createElement('li');
    item.textContent = `Name: ${documentName()} → ${nameInput.value.trim()}`;
    list.append(item);
  }
  for (const change of changes) {
    const item = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = change.text;
    item.append(text);
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'reset';
    reset.textContent = 'Reset';
    reset.setAttribute('aria-label', `Reset ${change.text}`);
    reset.addEventListener('click', () => {
      if (change.parameter) resetToSaved(change.nodeId, change.parameter, change.saved);
      else restorePedal(change.nodeId);
    });
    item.append(reset);
    list.append(item);
  }
}

function renderEditor() {
  const available = Boolean(known?.document);
  $('waiting').hidden = available;
  editorFields.hidden = !available;
  if (!available) return;
  if (selectedNode && !nodeById(selectedNode)) closeCloseup();
  if (formPreset !== known.preset) {
    closeRenaming();
    nameInput.value = documentName();
    formPreset = known.preset;
  }
  const shape = shapeKey();
  if (shape !== builtKey) {
    const focusKey = editorFields.contains(document.activeElement) ? document.activeElement.dataset?.key : null;
    buildBoard();
    buildCloseup();
    builtKey = shape;
    if (focusKey) restoreFocus(focusKey);
  }
  for (const control of editorFields.querySelectorAll('[data-key]:not(.field)')) syncControl(control);
  const changes = changesFromSaved();
  const changedKeys = new Set(changes.filter(change => change.parameter).map(change => `${change.nodeId}/${change.parameter}`));
  for (const field of editorFields.querySelectorAll('.field')) {
    const changed = changedKeys.has(field.dataset.key);
    field.classList.toggle('is-changed', changed);
    field.querySelector('.reset').hidden = !changed;
  }
  for (const knob of editorFields.querySelectorAll('.knob')) {
    knob.classList.toggle('is-changed', changedKeys.has(knob.querySelector('input').dataset.key));
  }
  for (const dial of $('board').querySelectorAll('.mini-dial')) {
    const [nodeId, parameter] = dial.dataset.mini.split('/');
    const node = nodeById(nodeId);
    const value = node?.dspUnitParameters[parameter];
    if (typeof value !== 'number') continue;
    const spec = specFor(node, parameter, value);
    const shown = value * spec.scale;
    dial.querySelector('.pointer').style.transform = `rotate(${knobAngle(shown, Math.min(spec.min, shown), Math.max(spec.max, shown))}deg)`;
    dial.parentElement.title = `${knobLabel(parameter)}: ${describeValue(node, parameter, value)}`;
  }
  for (const setting of $('board').querySelectorAll('.mini-setting')) {
    const [nodeId, parameter] = setting.dataset.setting.split('/');
    const node = nodeById(nodeId);
    if (node) setText(setting, `${parameterLabel(parameter)}: ${describeValue(node, parameter, node.dspUnitParameters[parameter])}`);
  }
  for (const slot of $('board').children) {
    const edited = changes.some(change => change.nodeId === slot.dataset.node);
    slot.classList.toggle('has-changes', edited);
  }
  const undo = $('closeup-undo');
  if (undo) undo.hidden = !changes.some(change => change.nodeId === selectedNode);
  renderChanges(changes);
  renderCloseupTabs(changes);
  setText($('name-count'), `${nameInput.value.length}/16`);
  // The close-up's own buttons stay outside these, so it can still be closed while the amp is away.
  $('board-fields').disabled = $('closeup-body').disabled = !state.connected || exclusive;
}

// Status, top bar and banners ------------------------------------------------
function renderStatus() {
  const count = changesFromSaved().length + (nameChanged() ? 1 : 0);
  const checking = checkingForChanges();
  const unsaved = state.connected && hasChanges() && !checking;
  const unsure = savedCopyGaveUp() && !nameChanged() && !editsWaiting();
  setText($('dirty'), checking ? 'Checking for changes…' : !unsaved ? '' : unsure ? 'May have unsaved changes'
    : count > 1 ? `${count} unsaved changes` : count === 1 ? '1 unsaved change' : 'Unsaved changes');
  if (state.connected) setText($('connection-text'), editsWaiting() ? 'Sending to the amp…' : 'Connected');
  const note = $('message').hidden ? '' : $('message').textContent;
  const problem = $('message').dataset.kind === 'error' ? note : '';
  const closeupStatus = $('closeup-status');
  setText(closeupStatus, !state.connected ? "The amp isn't connected, so these controls are paused until it's back."
    : note || (editsWaiting() ? 'Sending to the amp…' : ''));
  closeupStatus.dataset.kind = !state.connected || problem ? 'error' : '';
  const usable = state.connected && !exclusive;
  $('save').disabled = !usable || !hasChanges() || checking || !nameInput.value.trim();
  $('save-copy').disabled = !usable;
  $('discard').disabled = !usable || !hasChanges();
  $('discard').hidden = !hasChanges() || checking;
  $('prev').disabled = $('next').disabled = !usable;
  $('rename').disabled = nameInput.disabled = !usable || !known?.document;
  if (nameInput.disabled) closeRenaming();
  $('open-presets').disabled = !known;
  if (known?.preset) document.title = `${unsaved ? '• ' : ''}${known.preset} · ${shownName()} · Maneline`;
}

function renderConnection() {
  const connection = $('connection');
  let label;
  let banner = '';
  if (state.connected) {
    connection.dataset.state = 'connected';
    label = 'Connected';
    if (savedCopyGaveUp()) {
      banner = "Your Micro Plus isn't sending its saved copy of this preset, so this page can't tell whether anything has changed. Turning the amp off and on again may help.";
    } else if (reconnectNotice && !savedCopyUnknown() && edited()) {
      banner = 'Reconnected. Check how the preset sounds before saving, because your unsaved changes may not have survived.';
    }
  } else if (!reachable) {
    connection.dataset.state = 'lost';
    label = 'Not connected';
    banner = "Can't reach the Maneline app on this computer. Make sure it's still running; this page will reconnect by itself.";
  } else if (known) {
    connection.dataset.state = 'lost';
    label = 'Reconnecting…';
    // Don't repeat what the message under the top bar already says.
    const reason = state.error && state.error !== $('message').textContent ? `${state.error} ` : '';
    // A stall can leave the page without the saved copy, and then it doesn't know of any edits to warn about.
    const edits = (state.stalled ? changesFromSaved().length > 0 : edited()) || nameChanged() ? ' Your unsaved changes may not survive this.' : '';
    banner = `${state.stalled ? '' : 'Lost the connection to your Micro Plus. '}${reason}This page shows the last settings it read and will reconnect by itself.${edits}`;
  } else {
    connection.dataset.state = 'connecting';
    label = 'Connecting…';
    if (state.error) banner = state.error;
  }
  setText($('connection-text'), label);
  const element = $('connection-banner');
  element.hidden = !banner;
  setText(element, banner);
  if (known?.preset) {
    setText($('current-number'), state.connected ? `Preset ${known.preset}` : `Preset ${known.preset} (last known)`);
    setText($('current-name'), shownName());
    const current = presetByNumber(known.preset);
    setText($('preset-about'), presetOrigin(current) === 'Edited'
      ? `Edited since it came with the amp, so it may no longer sound like this: ${presetDescription(current)}` : presetDescription(current));
    $('preset-about').hidden = !$('preset-about').textContent;
    const artists = presetArtists(current);
    if ($('preset-artists').dataset.artists !== artists.join()) {
      $('preset-artists').dataset.artists = artists.join();
      showArtists($('preset-artists'), artists);
    }
    $('preset-artists').hidden = !artists.length;
  }
}

function renderLastSave() {
  const save = state.connected ? state.last_save : null;
  $('last-save').hidden = !save;
  $('undo-save').disabled = exclusive || editsWaiting();
  if (save) {
    const time = new Date(save.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setText($('last-save-text'), `Saved “${save.name}” to preset ${save.preset} at ${time}. Maneline kept a backup of what it replaced.`);
    $('last-save-text').title = `Backup file: ${save.backup}`;
  }
}

function render() {
  const previousActive = grid.querySelector('[aria-current="true"]')?.dataset.preset;
  renderConnection();
  renderPresets();
  renderEditor();
  renderStatus();
  renderLastSave();
  renderPresetFiles();
  // The first time, centre it so the presets around it show too.
  if (grid.querySelector('[aria-current="true"]')?.dataset.preset !== previousActive) scrollToActive(previousActive ? 'nearest' : 'center');
}

// Close-up -----------------------------------------------------------------------
function closeCloseup() {
  if ($('closeup').open) $('closeup').close();
  else selectedNode = null;
}

// Save menu ------------------------------------------------------------------
function closeSaveMenu() {
  $('save-menu').hidden = true;
  $('save-more').setAttribute('aria-expanded', 'false');
}
function toggleSaveMenu() {
  const open = $('save-menu').hidden;
  $('save-menu').hidden = !open;
  $('save-more').setAttribute('aria-expanded', String(open));
}

// Preset picker --------------------------------------------------------------
function openPicker({ search = false } = {}) {
  const picker = $('preset-panel');
  if (picker.open || !known) return;
  filter.value = '';
  shownGroup = null;
  renderPresets();
  picker.showModal();
  scrollToActive('center');
  // Going to the list instead of the search box keeps a phone's keyboard closed.
  const typing = search || window.matchMedia('(pointer: fine)').matches;
  (typing ? filter : grid.querySelector('.preset[tabindex="0"]') ?? filter).focus({ preventScroll: true });
}
function closePicker() {
  if ($('preset-panel').open) $('preset-panel').close();
}

// Events -----------------------------------------------------------------------
window.addEventListener('pointerup', () => { dragging = null; });
window.addEventListener('pointercancel', () => { dragging = null; });
document.addEventListener('visibilitychange', () => { if (!document.hidden) readState(); });

$('closeup-close').addEventListener('click', closeCloseup);
$('closeup').addEventListener('close', () => {
  if ($('closeup').open) return; // Already reopened; the close event arrives late.
  storeFlag('mmp-knob-tip-seen', true);
  const opened = selectedNode;
  selectedNode = null;
  builtKey = '';
  renderEditor();
  $('board').querySelector(`[data-node="${opened}"] button`)?.focus({ preventScroll: true });
});
// Selecting the dimmed area around the close-up closes it; the backdrop's clicks land on the dialog itself.
$('closeup').addEventListener('click', event => { if (event.target === $('closeup')) closeCloseup(); });
$('open-presets').addEventListener('click', () => openPicker());
$('close-presets').addEventListener('click', closePicker);
$('preset-panel').addEventListener('click', event => { if (event.target === $('preset-panel')) closePicker(); });
$('prev').addEventListener('click', () => stepPreset(-1));
$('next').addEventListener('click', () => stepPreset(1));
$('save').addEventListener('click', saveHere);
$('save-copy').addEventListener('click', saveCopy);
$('save-more').addEventListener('click', toggleSaveMenu);
// Runs before the chosen item's own handler, so a dialog it opens hands focus back to the arrow rather than a hidden item.
$('save-menu').addEventListener('click', () => { closeSaveMenu(); $('save-more').focus(); }, { capture: true });
document.addEventListener('click', event => { if (!event.target.closest('.save-split')) closeSaveMenu(); });
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || $('save-menu').hidden) return;
  closeSaveMenu();
  $('save-more').focus();
});
$('undo-save').addEventListener('click', undoSave);
$('copy-target').addEventListener('change', renderCopyChoice);
$('export-current').addEventListener('click', exportCurrentPreset);
// These close the picker first: its dimmed layer would otherwise hide the messages they show on the page.
$('export-all').addEventListener('click', () => { closePicker(); exportAllPresets(); });
$('import-preset').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', event => {
  const [file] = event.target.files;
  event.target.value = ''; // So choosing the same file again still counts as a change.
  if (!file) return;
  closePicker();
  importFromFile(file);
});
$('import-choice').addEventListener('change', useChosenImport);
$('import-target').addEventListener('change', renderImportChoice);
$('export-dialog').addEventListener('close', () => {
  if (!$('export-dialog').open) exportStopped = true; // Otherwise the next export has begun; the close event arrives late.
});
$('show-empty').addEventListener('change', event => {
  showEmpty = event.target.checked;
  storeFlag('mmp-show-empty', showEmpty);
  renderPresets();
});
function listPresets(byNumber) {
  sortByNumber = byNumber;
  storeFlag('mmp-sort-by-number', sortByNumber);
  renderPresets();
  scrollToActive('center');
}
function showTheme() {
  const theme = document.documentElement.dataset.theme ?? 'auto';
  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme));
  }
}
for (const button of document.querySelectorAll('[data-theme-choice]')) {
  button.addEventListener('click', () => {
    const theme = button.dataset.themeChoice;
    if (theme === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('mmp-theme', theme); } catch { /* Only a convenience. */ }
    showTheme();
  });
}
showTheme();
$('view-groups').addEventListener('click', () => listPresets(false));
$('view-number').addEventListener('click', () => listPresets(true));
$('move-target').addEventListener('change', showMoveNameField);
$('group-form').addEventListener('submit', event => {
  if (event.submitter?.value !== 'confirm') return;
  const problem = groupNameProblem($('group-name').value.trim(), groupNameCurrent);
  setText($('group-error'), problem);
  if (problem) event.preventDefault();
});
$('move-form').addEventListener('submit', event => {
  if (event.submitter?.value !== 'confirm' || $('move-target').value !== NEW_GROUP) return;
  const problem = groupNameProblem($('move-name').value.trim());
  setText($('move-error'), problem);
  if (problem) event.preventDefault();
});
$('discard').addEventListener('click', async () => {
  await editsIdle();
  const expected = guard();
  if (await confirmAction('Discard your unsaved changes?',
    'This reloads the saved preset from the amp. Your edits and any name change will be lost.', 'Discard changes')
    && stillSameEditor(expected)) {
    reconnectNotice = false;
    await selectPreset(expected.preset, { discard: true });
  }
});
nameInput.addEventListener('input', () => { renderEditor(); renderStatus(); });
nameInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); stopRenaming({ refocus: true }); }
  if (event.key === 'Escape') { event.preventDefault(); stopRenaming({ restore: true, refocus: true }); }
});
nameInput.addEventListener('blur', () => stopRenaming());
$('rename').addEventListener('click', startRenaming);

filter.addEventListener('input', () => { shownGroup = null; renderPresets(); }); // Search always covers every group.
filter.addEventListener('keydown', event => {
  const first = visiblePresetButtons()[0];
  if (event.key === 'Enter' && first) {
    event.preventDefault();
    selectPreset(Number(first.dataset.preset));
  } else if (event.key === 'ArrowDown' && first) {
    event.preventDefault();
    first.focus();
  }
});
grid.addEventListener('click', event => {
  const button = event.target.closest('.preset');
  if (button) selectPreset(Number(button.dataset.preset));
});
grid.addEventListener('keydown', event => {
  if (event.key === 'ArrowLeft' && event.target.closest('.move')) event.target.previousElementSibling.focus();
  const button = event.target.closest('.preset');
  if (!button) return;
  if (event.key === 'ArrowRight') button.nextElementSibling?.focus();
  const buttons = visiblePresetButtons();
  const index = buttons.indexOf(button);
  const targets = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: buttons.length - 1 };
  if (event.key in targets) {
    event.preventDefault();
    const target = buttons[targets[event.key]];
    if (target) { target.focus(); target.scrollIntoView({ block: 'nearest' }); }
    else if (event.key === 'ArrowUp') filter.focus();
  }
});
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault(); // Never the browser's "save this page".
    if (!document.querySelector('dialog[open]:not(#closeup)') && !$('save').disabled) {
      if ($('closeup').open) closeCloseup();
      saveHere();
    }
    return;
  }
  if (document.querySelector('dialog[open]') || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target.closest('input, select, textarea')) return;
  if (event.key === '[') stepPreset(-1);
  if (event.key === ']') stepPreset(1);
  if (event.key === '/') { event.preventDefault(); openPicker({ search: true }); }
});

$('changes').open = window.matchMedia('(min-width: 861px)').matches; // There's room for the list beside everything else.

readState();
setInterval(readState, 1000);
