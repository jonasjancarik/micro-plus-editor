'use strict';
// Assembles a pedal from the shared parts. A pedal only needs a name, a colour and its knobs.
const PART = name => `/web_ui/_static/pedal-kit/${name}.png`;
const partImage = (name, className) => `<img class="${className}" src="${PART(name)}" alt="" draggable="false">`;
const KNOB_PAGE_SIZE = 6;
const DRAG_DISTANCE = 150; // Pixels of dragging for a full turn.
const FINE_DRAG = 0.2; // Holding Shift makes a drag this much finer.
const WHEEL_DISTANCE = 20; // Pixels of scrolling for one hundredth of a turn.

function knobAngle(value, min, max) { return -135 + 270 * (value - min) / (max - min); }

function scaleMarks() {
  let marks = '';
  for (let step = 0; step <= 10; step++) {
    const angle = (-135 + 27 * step) * Math.PI / 180;
    const at = radius => `${(50 + Math.sin(angle) * radius).toFixed(1)} ${(50 - Math.cos(angle) * radius).toFixed(1)}`;
    marks += `<path d="M${at(44)} L${at(48.5)}"/>`;
  }
  return `<svg class="marks" viewBox="0 0 100 100" aria-hidden="true">${marks}</svg>`;
}

// The hidden native slider keeps arrow keys and screen readers working; dragging just sets its value.
function buildKnob({ label, value, min = 0, max = 10, step = 0.1, format = shown => Number(shown).toFixed(1), key }) {
  const knob = document.createElement('div');
  knob.className = 'knob';
  knob.innerHTML = `<button type="button" class="readout"></button>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${value}">
    <div class="dial">${scaleMarks()}${partImage('knob', 'body')}${partImage('pointer', 'pointer')}</div>
    <div class="knob-label"></div>`;
  knob.querySelector('.knob-label').textContent = label;
  const input = knob.querySelector('input');
  const dial = knob.querySelector('.dial');
  const pointer = knob.querySelector('.pointer');
  const readout = knob.querySelector('.readout');
  input.setAttribute('aria-label', label);
  readout.setAttribute('aria-label', `Type a value for ${label}`);
  if (key) input.dataset.key = key;
  let hideTimer;
  let lastX = 0;
  let lastY = 0;
  let dragValue = 0;
  let wheelPixels = 0;
  const range = () => Number(input.max) - Number(input.min);
  const paint = () => {
    pointer.style.transform = `rotate(${knobAngle(Number(input.value), Number(input.min), Number(input.max))}deg)`;
    readout.textContent = format(input.value);
    input.setAttribute('aria-valuetext', format(input.value));
  };
  const showBriefly = () => {
    knob.classList.add('active');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => knob.classList.remove('active'), 900);
  };
  const setValue = value => {
    const before = input.value;
    input.value = String(value);
    if (input.value !== before) input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  input.repaintKnob = paint;
  input.addEventListener('input', () => {
    paint();
    if (dial.hasPointerCapture?.(knob.dragPointer)) return; // The number stays up until the drag ends.
    showBriefly();
  });
  dial.addEventListener('pointerdown', event => {
    if (input.disabled) return;
    dial.setPointerCapture(event.pointerId);
    knob.dragPointer = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    dragValue = Number(input.value);
    knob.classList.add('active');
    clearTimeout(hideTimer);
    input.focus({ preventScroll: true });
    event.preventDefault();
  });
  dial.addEventListener('pointermove', event => {
    if (!dial.hasPointerCapture(event.pointerId) || input.disabled) return;
    const moved = (lastY - event.clientY) + (event.clientX - lastX);
    lastX = event.clientX;
    lastY = event.clientY;
    dragValue += moved / DRAG_DISTANCE * range() * (event.shiftKey ? FINE_DRAG : 1);
    dragValue = Math.min(Number(input.max), Math.max(Number(input.min), dragValue));
    setValue(dragValue);
  });
  dial.addEventListener('wheel', event => {
    if (input.disabled) return;
    // In a page that's scrolling, a knob passing under the pointer mustn't turn unless it was chosen first.
    const scroller = knob.closest('dialog');
    if (scroller?.scrollHeight > scroller?.clientHeight && document.activeElement !== input) return;
    event.preventDefault();
    wheelPixels += event.deltaY || event.deltaX;
    const notches = Math.trunc(wheelPixels / WHEEL_DISTANCE);
    if (!notches) return;
    wheelPixels -= notches * WHEEL_DISTANCE;
    setValue(Number(input.value) - notches * Math.max(Number(input.step), range() / 100));
  }, { passive: false });
  readout.addEventListener('click', () => {
    const editor = document.createElement('input');
    editor.type = 'number';
    editor.step = 'any';
    editor.className = 'readout-edit';
    editor.value = input.value;
    editor.setAttribute('aria-label', label);
    readout.hidden = true;
    readout.after(editor);
    editor.select();
    let finished = false;
    const finish = keep => {
      if (finished) return;
      finished = true;
      if (keep && editor.value !== '') setValue(editor.value);
      editor.remove();
      readout.hidden = false;
      input.focus({ preventScroll: true });
    };
    editor.addEventListener('blur', () => finish(true));
    editor.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== 'Escape') return;
      event.preventDefault(); // Escape here cancels the typing, not the window around it.
      finish(event.key === 'Enter');
    });
  });
  dial.addEventListener('pointerup', showBriefly);
  dial.addEventListener('pointercancel', showBriefly);
  paint();
  return knob;
}

// A real checkbox, so it can carry the on/off state and be used from the keyboard.
function buildFootswitch(name, on = true, key) {
  const foot = document.createElement('label');
  foot.className = 'foot';
  foot.innerHTML = `<input type="checkbox">${partImage('foot-up', 'raised')}${partImage('foot-down', 'pressed')}`;
  const input = foot.querySelector('input');
  input.checked = on;
  input.setAttribute('aria-label', `${name} on`);
  if (key) input.dataset.key = key;
  return foot;
}

function setPedalOn(pedal, on) { pedal.classList.toggle('off', !on); }

function buildKnobArea(knobs) {
  const area = document.createElement('div');
  area.className = 'knob-area';
  const pages = [];
  for (let start = 0; start < knobs.length; start += KNOB_PAGE_SIZE) pages.push(knobs.slice(start, start + KNOB_PAGE_SIZE));
  const shown = pages.map(page => {
    const row = document.createElement('div');
    row.className = 'knobs';
    row.append(...page.map(buildKnob));
    return row;
  });
  area.append(...shown);
  if (shown.length < 2) return area;
  const dots = document.createElement('div');
  dots.className = 'knob-pages';
  const buttons = shown.map((row, index) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.setAttribute('aria-label', `Knobs, page ${index + 1} of ${shown.length}`);
    dot.addEventListener('click', () => show(index));
    return dot;
  });
  function show(index) {
    shown.forEach((row, rowIndex) => { row.hidden = rowIndex !== index; });
    buttons.forEach((dot, dotIndex) => dot.setAttribute('aria-current', String(dotIndex === index)));
  }
  dots.append(...buttons);
  area.append(dots);
  show(0);
  return area;
}

function buildPedal({ name, colour, knobs, footswitch = true, on = true, lightInk = false, bypassKey }) {
  const pedal = document.createElement('div');
  pedal.className = lightInk ? 'pedal light-ink' : 'pedal';
  pedal.style.setProperty('--tint', colour);
  pedal.innerHTML = `
    ${partImage('jack', 'jack left')}${partImage('jack', 'jack right')}
    <div class="face">
      ${['tl', 'tr', 'bl', 'br'].map(spot => partImage('screw', `screw ${spot}`)).join('')}
      <div class="light">${partImage('light-off', 'unlit')}${partImage('light-on', 'lit')}</div>
      <div class="name"></div>
    </div>`;
  pedal.querySelector('.name').textContent = name;
  const face = pedal.querySelector('.face');
  face.prepend(buildKnobArea(knobs));
  if (footswitch) {
    const foot = buildFootswitch(name, on, bypassKey);
    const input = foot.querySelector('input');
    input.addEventListener('change', () => setPedalOn(pedal, input.checked));
    face.append(foot);
  }
  setPedalOn(pedal, on);
  return pedal;
}
