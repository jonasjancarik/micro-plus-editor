import { backend } from './backend';
import { saveTextFile } from './save-file';
import { $, EDITOR_API, SAVE_CAUTION, bumpEpoch, clearFormPreset, closeSaveMenu, displayName, editsIdle, exclusive, exclusiveOperation, guard, hasChanges, isEmptySlot, known, post, presetByNumber, readState, render, setExclusive, setText, showMessage, state, stillSameEditor, userGroups } from './main';

// Exporting presets to files and importing one into a slot. main.ts provides the page's helpers.
export const BACKUP_FORMAT = 'maneline-micro-plus-backup-v1';
export const LIBRARY_FORMAT = 'maneline-micro-plus-library-v1';
export const MAX_IMPORT_FILE = 4 * 1024 * 1024; // Far more than 100 presets, so a wrong file is refused before it's read.
export const READ_ATTEMPTS = 4; // With the pauses, long enough for the session's own reconnect after a stalled read.
export const READ_RETRY_MS = 5000;
export const NOT_A_PRESET_FILE = "This file doesn't contain a Micro Plus preset. Choose a file exported from this page.";

export let exportStopped = false;
export let importEntries = [];

export function slotOptions() {
  return known.presets.map(preset => {
    const option = document.createElement('option');
    option.value = String(preset.preset);
    option.textContent = `${preset.preset} · ${displayName(preset)}`;
    return option;
  });
}

// Exporting ----------------------------------------------------------------
export function fileSafe(name) {
  return name.trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'preset';
}

export function downloadJson(filename, content) {
  saveTextFile(filename, JSON.stringify(content, null, 2)).catch(error => showMessage(`Couldn't save the file: ${error.message}`, 'error'));
}

export async function readForExport(slot) {
  for (let attempt = 1; ; attempt++) {
    try {
      return (await post(EDITOR_API, { action: 'read-slot', slot })).saved_document;
    } catch (error) {
      if (attempt === READ_ATTEMPTS || exportStopped) throw error;
      await new Promise(resolve => setTimeout(resolve, READ_RETRY_MS));
    }
  }
}

// Returns every preset asked for, or nothing: a file missing some presets could pass for a full backup.
export async function readPresets(slots) {
  await editsIdle();
  if (exclusive || !state.connected) return null;
  setExclusive(true);
  bumpEpoch();
  exportStopped = false;
  showMessage('');
  render();
  const dialog = $('export-dialog');
  $('export-progress').max = slots.length;
  $('export-progress').value = 0;
  dialog.showModal();
  let current = null;
  try {
    const presets = [];
    for (const [index, slot] of slots.entries()) {
      if (exportStopped) break;
      current = slot;
      setText($('export-status'), `Reading preset ${index + 1} of ${slots.length}: ${displayName(presetByNumber(slot))}`);
      presets.push({ slot, preset: await readForExport(slot) });
      $('export-progress').value = index + 1;
    }
    if (!exportStopped) return presets;
    showMessage('Export cancelled, so no file was downloaded.');
  } catch {
    showMessage(`Couldn't read preset ${current}, so no file was downloaded. Check that your amp is connected, then try again.`,
      'error', { outlastsReconnect: true }); // A reconnect doesn't bring the missing file back.
  } finally {
    if (dialog.open) dialog.close();
    setExclusive(false);
    render();
    readState();
  }
  return null;
}

export async function exportCurrentPreset() {
  const slot = state.preset;
  const presets = await readPresets([slot]);
  if (!presets) return;
  const { preset } = presets[0];
  const name = preset.info.displayName.trim();
  downloadJson(`micro-plus-preset-${String(slot).padStart(3, '0')}-${fileSafe(name)}.json`,
    { format: BACKUP_FORMAT, slot, preset });
  showMessage(hasChanges() ? `Exported “${name}” as it's saved on your amp. Your unsaved changes aren't in the file.`
    : `Exported “${name}”.`);
}

export async function exportAllPresets() {
  const presets = await readPresets(known.presets.filter(preset => !isEmptySlot(preset)).map(preset => preset.preset));
  if (!presets) return;
  const exported = new Date();
  const day = [exported.getFullYear(), String(exported.getMonth() + 1).padStart(2, '0'),
    String(exported.getDate()).padStart(2, '0')].join('-');
  downloadJson(`micro-plus-presets-${day}.json`, { format: LIBRARY_FORMAT, exported_at: exported.toISOString(),
    presets, preset_groups: userGroups });
  showMessage(`Exported ${presets.length} presets.`);
}

// Importing ----------------------------------------------------------------
export function presetsInFile(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(NOT_A_PRESET_FILE); }
  const entries = Array.isArray(data?.presets) ? data.presets : [data];
  const presets = entries.filter(entry => entry?.preset?.nodeType === 'preset'
    && typeof entry.preset.info?.displayName === 'string');
  if (!presets.length) throw new Error(NOT_A_PRESET_FILE);
  return presets;
}

export function chosenImport() { return importEntries[Number($('import-choice').value)]; }

export function renderImportChoice() {
  const target = presetByNumber(Number($('import-target').value));
  if (!target) return;
  const occupied = !isEmptySlot(target);
  const edits = target.preset === known.preset && hasChanges() ? ' Your unsaved edits to it will be lost.' : '';
  setText($('import-warning'), occupied ? `This replaces “${target.name}”.${edits} ${SAVE_CAUTION}` : edits.trim());
  setText($('import-action'), occupied ? `Replace preset ${target.preset}` : `Import to preset ${target.preset}`);
}

export function useChosenImport() { $('import-name').value = chosenImport().preset.info.displayName.trim().slice(0, 16); }

export async function importFromFile(file) {
  try {
    if (file.size > MAX_IMPORT_FILE) throw new Error(NOT_A_PRESET_FILE);
    importEntries = presetsInFile(await file.text());
  } catch (error) {
    showMessage(error.message === NOT_A_PRESET_FILE ? error.message : "Couldn't read that file.", 'error');
    return;
  }
  await editsIdle();
  if (exclusive || !state.connected) return;
  const expected = guard();
  showMessage('');
  setText($('import-file-name'), `From ${file.name}`);
  const choice = $('import-choice');
  choice.replaceChildren(...importEntries.map((entry, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = (entry.slot ? `${entry.slot} · ` : '') + entry.preset.info.displayName.trim();
    return option;
  }));
  $('import-choice-field').hidden = importEntries.length < 2;
  useChosenImport();
  const select = $('import-target');
  select.replaceChildren(...slotOptions());
  const firstEmpty = known.presets.find(isEmptySlot);
  select.value = String((firstEmpty ?? known.presets.find(preset => preset.preset !== known.preset)).preset);
  renderImportChoice();
  const dialog = $('import-dialog');
  dialog.returnValue = 'cancel';
  const go = await new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
  if (!go || !stillSameEditor(expected)) return;
  const target = Number(select.value);
  const name = $('import-name').value.trim();
  await exclusiveOperation(EDITOR_API, { action: 'import', ...guard(), target, name, document: chosenImport().preset },
    `Backing up preset ${target} and importing “${name}”…`, () => {
      if (target === state.preset) clearFormPreset();
      return `Imported “${name}” to preset ${target}.`;
    });
}

export function renderPresetFiles() {
  const unavailable = exclusive || !state.connected;
  for (const id of ['export-current', 'save-more', 'export-all', 'import-preset']) $(id).disabled = unavailable;
  if (unavailable) closeSaveMenu();
}

export function stopExport() { exportStopped = true; }

// Backups ------------------------------------------------------------------
function backupLine(entry) {
  const item = document.createElement('li');
  const text = document.createElement('span');
  text.textContent = `Preset ${entry.preset}, before the change on ${new Date(entry.time).toLocaleString()}`;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Download';
  button.addEventListener('click', async () => {
    try {
      await saveTextFile(entry.name, await backend.readBackup(entry.name));
    } catch (error) {
      setText($('backups-empty'), error.message);
      $('backups-empty').hidden = false;
    }
  });
  item.append(text, button);
  return item;
}

async function downloadAllBackups(entries) {
  const backups = [];
  for (const entry of entries) backups.push({ file: entry.name, ...JSON.parse(await backend.readBackup(entry.name)) });
  const day = new Date().toISOString().slice(0, 10);
  await saveTextFile(`micro-plus-backups-${day}.json`, JSON.stringify({ format: 'maneline-micro-plus-backups-v1', backups }, null, 2));
}

async function openBackups() {
  const entries = await backend.listBackups();
  $('backups-list').replaceChildren(...entries.map(backupLine));
  setText($('backups-empty'), 'There are no backups yet.');
  $('backups-empty').hidden = entries.length > 0;
  $('backups-all').hidden = entries.length < 2;
  $('backups-all').onclick = () => downloadAllBackups(entries).catch(error => {
    setText($('backups-empty'), `Couldn't download them: ${error.message}`);
    $('backups-empty').hidden = false;
  });
  $('backups-dialog').showModal();
}

export function setUpBackups() {
  $('open-backups').hidden = !backend.listBackups;
  $('open-backups').addEventListener('click', openBackups);
}
