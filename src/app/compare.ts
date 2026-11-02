import { knobLabel } from './params';
import { $, EDITOR_API, adopt, bumpEpoch, describeValue, displayName, editsWaiting, exclusive, hasBypass, hasChanges, isEmptyNode, isEmptySlot, known, modelName, pedalTabLabels, post, presetByNumber, render, selectPreset, setText, showMessage, signalOrder, state, storeFlag, storedFlag, switchingTo } from './main';

// Comparing presets: a short list to jump between by ear, whatever their slot numbers.
export const COMPARE_API = '/api/micro-plus/compare';
export const COMPARED_POSITIONS = ['amp', 'stomp', 'mod', 'delay', 'reverb'];
export const COMPARED_SETTINGS_SHOWN = 3;
export let comparePresets = []; // The slots in the list.
export let compareQueued = null; // The last preset asked for during a switch, which plays once that switch ends.
export let compareDifferencesOpen = false;
export let compareReading = false;
export let compareTabbed = false;
export let compareChipsKey = '';
export let compareTableKey = '';
export const comparedDocuments = new Map(); // Slot → its saved document, so the table never has to change preset.
export const compareUnreadable = new Set();

export function compareTarget() { return compareQueued ?? switchingTo ?? known?.preset; }

export async function changeCompare(body) {
  setText($('picker-status'), '');
  bumpEpoch(); // A reply already on its way would otherwise bring the old list back for a moment.
  try {
    adopt(await post(COMPARE_API, body));
    render();
  } catch (error) {
    const text = error.message;
    if ($('preset-panel').open) setText($('picker-status'), text);
    else showMessage(text, 'error');
  }
}

export function toggleCompared(number) {
  changeCompare({ action: comparePresets.includes(number) ? 'remove' : 'add', preset: number });
}

export function jumpToCompared(number) {
  if (switchingTo != null) { // The amp can't be interrupted, so only the latest choice is kept.
    compareQueued = number === switchingTo ? null : number;
    renderCompare();
  } else {
    selectPreset(number);
  }
}

export function playNextCompared() {
  const position = comparePresets.indexOf(compareTarget());
  jumpToCompared(comparePresets[(position + 1) % comparePresets.length]);
}

export function playQueuedCompared(switched) {
  const next = compareQueued;
  compareQueued = null;
  if (switched && next && next !== state.preset) selectPreset(next);
  else renderCompare();
}

export function buildCompareChips() {
  $('compare-presets').replaceChildren(...comparePresets.map((number, index) => {
    const preset = presetByNumber(number);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'compare-chip';
    chip.dataset.preset = number;
    chip.title = `Preset ${number}`;
    const key = document.createElement('kbd');
    key.textContent = String(index + 1);
    chip.append(key, preset ? displayName(preset) : `Preset ${number}`);
    chip.addEventListener('click', () => jumpToCompared(number));
    return chip;
  }));
}

export function comparedModelName(node) {
  if (isEmptyNode(node)) return 'Nothing';
  // A model can sit in a position other than the one it's listed under.
  const model = (Object.values(known.models).flat() as any[]).find(candidate => candidate.id === node.FenderId);
  const name = model?.name ?? modelName(node);
  return hasBypass(node) && node.dspUnitParameters.bypass ? `${name}, off` : name;
}

// One row per position. Where every preset has the same model, its knobs are what can differ.
export function comparedPositionRow(position, documents) {
  const nodes = documents.map(document => document?.audioGraph.nodes.find(node => node.nodeId === position));
  const present = nodes.filter(Boolean);
  const models = present.map(comparedModelName);
  const sameModel = new Set(present.map(node => node.FenderId)).size === 1;
  const describe = (node, key) => (key in node.dspUnitParameters ? describeValue(node, key, node.dspUnitParameters[key]) : '');
  const keys = !sameModel ? [] : [...new Set(present.flatMap(node => Object.keys(node.dspUnitParameters)))]
    .filter(key => key !== 'bypass' && new Set(present.map(node => describe(node, key))).size > 1);
  return {
    label: pedalTabLabels[position],
    differs: new Set(models).size > 1 || keys.length > 0,
    cells: nodes.map(node => node && {
      text: comparedModelName(node),
      details: [...keys.slice(0, COMPARED_SETTINGS_SHOWN).map(key => `${knobLabel(key)} ${describe(node, key)}`),
        ...keys.length > COMPARED_SETTINGS_SHOWN ? [`and ${keys.length - COMPARED_SETTINGS_SHOWN} more settings`] : []],
    }),
  };
}

export function comparedOrderRow(documents) {
  const orders = documents.map(document => document
    && signalOrder(document.audioGraph.nodes, document.audioGraph).map(node => pedalTabLabels[node.nodeId]).join(' → '));
  return { label: 'Order', differs: new Set(orders.filter(Boolean)).size > 1,
    cells: orders.map(text => text && { text, details: [] }) };
}

export function buildCompareTable(documents) {
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  head.append(document.createElement('td'));
  for (const number of comparePresets) {
    const name = document.createElement('th');
    name.scope = 'col';
    name.dataset.preset = number;
    name.textContent = presetByNumber(number) ? displayName(presetByNumber(number)) : `Preset ${number}`;
    head.append(name);
  }
  const body = table.createTBody();
  const rows = [...COMPARED_POSITIONS.map(position => comparedPositionRow(position, documents)), comparedOrderRow(documents)];
  for (const { label, differs, cells } of rows) {
    const row = body.insertRow();
    row.className = differs ? 'differs' : 'same';
    const heading = document.createElement('th');
    heading.scope = 'row';
    heading.textContent = label;
    row.append(heading);
    cells.forEach((cell, index) => {
      const entry = row.insertCell();
      entry.dataset.preset = comparePresets[index];
      entry.textContent = cell?.text ?? (compareUnreadable.has(comparePresets[index]) ? "Couldn't read this preset" : 'Reading…');
      for (const detail of cell?.details ?? []) {
        const line = document.createElement('span');
        line.className = 'compare-detail';
        line.textContent = detail;
        entry.append(line);
      }
    });
  }
  return table;
}

export async function readComparedDocuments() {
  if (!compareDifferencesOpen || compareReading || exclusive || editsWaiting() || !state.connected) return;
  const slot = comparePresets.find(number => !comparedDocuments.has(number) && !compareUnreadable.has(number));
  if (!slot) return;
  compareReading = true;
  try {
    comparedDocuments.set(slot, (await post(EDITOR_API, { action: 'read-slot', slot })).saved_document);
  } catch {
    compareUnreadable.add(slot);
  } finally {
    compareReading = false;
    renderCompare();
  }
}

export function setCompareDifferences(open) {
  compareDifferencesOpen = open;
  storeFlag('mmp-compare-differences', open);
  compareUnreadable.clear();
  renderCompare();
}

export function renderCompare() {
  if (!known) return;
  const current = presetByNumber(known.preset);
  const listed = comparePresets.includes(known.preset);
  $('compare-toggle').hidden = !current || (isEmptySlot(current) && !listed);
  $('compare-toggle').setAttribute('aria-pressed', String(listed));
  setText($('compare-toggle-text'), listed ? 'In compare' : 'Add to compare');
  $('compare').hidden = comparePresets.length === 0;

  const names = comparePresets.map(number => presetByNumber(number)?.name);
  const chipsKey = JSON.stringify([comparePresets, names]);
  if (chipsKey !== compareChipsKey) {
    buildCompareChips();
    compareChipsKey = chipsKey;
  }
  const target = compareTarget();
  for (const chip of $('compare-presets').children) {
    const chosen = Number(chip.dataset.preset) === target;
    if (chosen) chip.setAttribute('aria-current', 'true'); else chip.removeAttribute('aria-current');
    chip.classList.toggle('waiting', chosen && target !== known.preset);
    chip.disabled = !state.connected;
    if (chosen && chip.scrollIntoView && $('compare').scrollWidth > $('compare').clientWidth && chip.dataset.shown !== 'yes') {
      chip.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    chip.dataset.shown = chosen ? 'yes' : '';
  }

  const several = comparePresets.length > 1;
  $('compare-hint').hidden = several;
  $('compare-differences').hidden = !several;
  setText($('compare-differences'), compareDifferencesOpen ? 'Hide differences' : 'Show differences');
  $('compare-differences').setAttribute('aria-expanded', String(compareDifferencesOpen && several));
  const open = compareDifferencesOpen && several;
  $('compare-panel').hidden = !open;
  if (open) {
    const documents = comparePresets.map(number => comparedDocuments.get(number));
    const tableKey = JSON.stringify([comparePresets, names, documents.map(document => document?.audioGraph), [...compareUnreadable]]);
    if (tableKey !== compareTableKey) {
      $('compare-table').replaceChildren(buildCompareTable(documents));
      compareTableKey = tableKey;
    }
    for (const cell of $('compare-table').querySelectorAll('[data-preset]')) {
      cell.classList.toggle('playing', Number(cell.dataset.preset) === target);
    }
    $('compare-unsaved').hidden = !(listed && hasChanges());
    readComparedDocuments();
  }
}

export function setUpCompare() {
  compareDifferencesOpen = storedFlag('mmp-compare-differences');
  $('compare-toggle').addEventListener('click', () => toggleCompared(known.preset));
  $('compare-differences').addEventListener('click', () => setCompareDifferences(!compareDifferencesOpen));
  $('compare-clear').addEventListener('click', () => changeCompare({ action: 'clear' }));
  window.addEventListener('pointerdown', () => { compareTabbed = false; }, true);
  window.addEventListener('keydown', (event: any) => { if (event.key === 'Tab') compareTabbed = true; }, true);
}

// Space belongs to a control only when Tab took you there; a clicked button keeps focus but isn't being aimed at.
// The browser can't say which: any key press makes a clicked button count as keyboard-focused too.
export function compareKeys(event) {
  if (event.repeat || !known) return;
  if (event.key === 'c' || event.key === 'C') {
    if (!$('compare-toggle').hidden) toggleCompared(known.preset);
  } else if (/^[1-9]$/.test(event.key)) {
    const number = comparePresets[Number(event.key) - 1];
    if (number) jumpToCompared(number);
  } else if (event.key === ' ' && comparePresets.length) {
    if (compareTabbed && event.target.closest?.('button, a, summary, [tabindex]')) return;
    event.preventDefault();
    document.activeElement?.blur();
    playNextCompared();
  }
}

export function setComparePresets(slots) { comparePresets = slots; }
