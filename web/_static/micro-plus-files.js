'use strict';
// Exporting presets to files and importing one into a slot. Loaded first; micro-plus.js provides the page's helpers.
const BACKUP_FORMAT = 'maneline-micro-plus-backup-v1';
const LIBRARY_FORMAT = 'maneline-micro-plus-library-v1';
const MAX_IMPORT_FILE = 4 * 1024 * 1024; // Far more than 100 presets, so a wrong file is refused before it's read.
const READ_ATTEMPTS = 4; // With the pauses, long enough for the server's own reconnect after a stalled read.
const READ_RETRY_MS = 5000;
const NOT_A_PRESET_FILE = "This file doesn't contain a Micro Plus preset. Choose a file exported from this page.";

let exportStopped = false;
let importEntries = [];

function slotOptions() {
  return known.presets.map(preset => {
    const option = document.createElement('option');
    option.value = preset.preset;
    option.textContent = `${preset.preset} · ${displayName(preset)}`;
    return option;
  });
}

// Exporting ----------------------------------------------------------------
function fileSafe(name) {
  return name.trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'preset';
}

function downloadJson(filename, content) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url));
}

async function readForExport(slot) {
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
async function readPresets(slots) {
  await editsIdle();
  if (exclusive || !state.connected) return null;
  exclusive = true;
  epoch++;
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
    exclusive = false;
    render();
    readState();
  }
  return null;
}

async function exportCurrentPreset() {
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

async function exportAllPresets() {
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
function presetsInFile(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(NOT_A_PRESET_FILE); }
  const entries = Array.isArray(data?.presets) ? data.presets : [data];
  const presets = entries.filter(entry => entry?.preset?.nodeType === 'preset'
    && typeof entry.preset.info?.displayName === 'string');
  if (!presets.length) throw new Error(NOT_A_PRESET_FILE);
  return presets;
}

function chosenImport() { return importEntries[Number($('import-choice').value)]; }

function renderImportChoice() {
  const target = presetByNumber(Number($('import-target').value));
  if (!target) return;
  const occupied = !isEmptySlot(target);
  const edits = target.preset === known.preset && hasChanges() ? ' Your unsaved edits to it will be lost.' : '';
  setText($('import-warning'), occupied ? `This replaces “${target.name}”.${edits} ${SAVE_CAUTION}` : edits.trim());
  setText($('import-action'), occupied ? `Replace preset ${target.preset}` : `Import to preset ${target.preset}`);
}

function useChosenImport() { $('import-name').value = chosenImport().preset.info.displayName.trim().slice(0, 16); }

async function importFromFile(file) {
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
    option.value = index;
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
      if (target === state.preset) formPreset = null;
      return `Imported “${name}” to preset ${target}.`;
    });
}

function renderPresetFiles() {
  const unavailable = exclusive || !state.connected;
  for (const id of ['export-current', 'save-more', 'export-all', 'import-preset']) $(id).disabled = unavailable;
  if (unavailable) closeSaveMenu();
}
