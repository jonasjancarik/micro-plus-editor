import { expect, test, type Page } from '@playwright/test';

const inSim = <T>(page: Page, source: string) => page.evaluate(`(() => { const simulator = window.simulator; return ${source}; })()`) as Promise<T>;

async function open(page: Page) {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  await page.goto('/?simulator=1&delay=10');
  await expect(page.locator('#connection-text')).toHaveText('Connected');
  return problems;
}

const firstSwitch = (page: Page) => page.locator('#board input[type=checkbox]').first();

async function confirm(page: Page) {
  await expect(page.locator('#confirm-dialog')).toBeVisible();
  await page.locator('#confirm-action').click();
}

test('shows the board and changes preset', async ({ page }) => {
  const problems = await open(page);
  await expect(page.locator('#current-name')).toHaveText('Wild Nocturne');
  await expect(page.locator('#board .pedal')).not.toHaveCount(0);
  await page.locator('#next').click();
  await expect(page.locator('#current-number')).toHaveText('Preset 18');
  await page.keyboard.press('[');
  await expect(page.locator('#current-number')).toHaveText('Preset 17');
  expect(problems).toEqual([]);
});

test('changes the amp’s EQ, and follows a change made on the amp', async ({ page }) => {
  const problems = await open(page);
  const eq = page.locator('#eq');
  await expect(eq).toHaveValue('0');
  await eq.selectOption({ label: 'EQ8 Bass boost 1' });
  await expect.poll(() => inSim<number>(page, 'simulator.eq')).toBe(7);
  await inSim(page, 'simulator.eq = 2');
  await expect(eq).toHaveValue('2');
  expect(problems).toEqual([]);
});

test('every image on the board loads', async ({ page }) => {
  const failed: string[] = [];
  page.on('response', (response) => { if (response.status() >= 400) failed.push(response.url()); });
  await open(page);
  await page.waitForLoadState('networkidle');
  expect(failed).toEqual([]);
});

test('edits, saves with a backup, and undoes', async ({ page }) => {
  await open(page);
  await firstSwitch(page).dispatchEvent('click');
  await expect(page.locator('#dirty')).toHaveText('1 unsaved change');
  await expect(page).toHaveTitle(/^• 17/);
  await page.locator('#save').click();
  await confirm(page);
  await expect(page.locator('#dirty')).toHaveText('');
  await expect(page.locator('#last-save')).toBeVisible();

  await page.locator('#open-presets').click();
  await page.locator('#open-backups').click();
  await expect(page.locator('#backups-list li')).toHaveCount(1);
  await expect(page.locator('#backups-list li')).toContainText('Preset 17');
  const download = page.waitForEvent('download');
  await page.locator('#backups-list button').click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/preset-017\.json$/);
  await page.locator('#backups-dialog button.primary').click();
  await page.locator('#close-presets').click();

  await page.locator('#undo-save').click();
  if (await page.locator('#confirm-dialog').isVisible()) await page.locator('#confirm-action').click();
  await expect(page.locator('#message')).toContainText('back to what it held');
  expect(await inSim(page, 'simulator.lastSave')).toBeNull();
});

test('moves a pedal, shows it as a change, and can discard it', async ({ page }) => {
  await open(page);
  await page.locator('#board button[data-move]:not([disabled])').first().click();
  await expect(page.locator('#dirty')).not.toHaveText('');
  await page.locator('#discard').click();
  await confirm(page);
  await expect(page.locator('#dirty')).toHaveText('');
});

test('steps a numbered setting with its buttons', async ({ page }) => {
  await open(page);
  await page.getByText('Compression setting: 1').click();
  const value = page.locator('.stepper input');
  await page.getByRole('button', { name: 'Raise Compression setting' }).click();
  await expect(value).toHaveValue('2');
  await expect(page.locator('#dirty')).toHaveText('1 unsaved change');
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Lower Compression setting' }).click();
  await expect(value).toHaveValue('0');
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true });

  async function swipe(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, holdMs: number) {
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', point?: { x: number; y: number }) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [{ x: point.x, y: point.y }] : [] });
    await touch('touchStart', from);
    await page.waitForTimeout(holdMs);
    for (let step = 1; step <= 10; step++) {
      await touch('touchMove', { x: from.x + (to.x - from.x) * step / 10, y: from.y + (to.y - from.y) * step / 10 });
    }
    await touch('touchEnd');
  }

  const centre = async (page: Page, index: number) => {
    const box = (await page.locator('#board > .slot').nth(index).locator('.face').boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };

  test('a held pedal follows the finger, and a quick swipe leaves the order alone', async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    await open(page);
    const order = () => page.locator('#board > .slot').evaluateAll((slots) => slots.map((slot) => slot.getAttribute('data-node')));
    const before = await order();

    await swipe(page, await centre(page, 0), await centre(page, 1), 0);
    expect(await order()).toEqual(before);
    await expect(page.locator('#dirty')).toHaveText('');

    await swipe(page, await centre(page, 0), await centre(page, 1), 500);
    await expect.poll(order).toEqual([before[1], before[0], ...before.slice(2)]);
    await expect(page.locator('#dirty')).not.toHaveText('');
  });
});

test('keeps the amp wide after moving it to the end', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await open(page);
  const toEnd = page.getByRole('button', { name: 'Move amplifier closer to your headphones' });
  await toEnd.click();
  await toEnd.click();
  await expect(page.locator('#board > .slot').last()).toHaveAttribute('data-node', 'amp');
  const widths = await page.locator('#board > .slot').evaluateAll((slots) => slots.map((slot) => slot.getBoundingClientRect().width));
  expect(widths.at(-1)).toBeGreaterThan(Math.max(...widths.slice(0, -1)));
});

test('saves a copy to another slot', async ({ page }) => {
  await open(page);
  await page.locator('#save-more').click();
  await page.locator('#save-copy').click();
  await page.locator('#copy-name').fill('My copy');
  await page.locator('#copy-target').selectOption('99');
  await page.locator('#copy-action').click();
  if (await page.locator('#confirm-dialog').isVisible()) await page.locator('#confirm-action').click();
  await expect(page.locator('#message')).toContainText('Saved a copy to preset 99');
  await expect(page.locator('#current-number')).toHaveText('Preset 17');
});

test('exports a preset and imports it into another slot', async ({ page }) => {
  await open(page);
  await page.locator('#save-more').click();
  const download = page.waitForEvent('download');
  await page.locator('#export-current').click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^micro-plus-preset-017-/);
  await page.locator('#open-presets').click();
  await page.locator('#import-file').setInputFiles(await file.path());
  await expect(page.locator('#import-dialog')).toBeVisible();
  await page.locator('#import-name').fill('Imported');
  await page.locator('#import-action').click();
  await expect(page.locator('#message')).toContainText('Imported “Imported” to preset');
});

test('refuses a file that is not a preset', async ({ page }) => {
  await open(page);
  await page.locator('#open-presets').click();
  await page.locator('#import-file').setInputFiles({ name: 'other.json', mimeType: 'application/json', buffer: Buffer.from('{"a":1}') });
  await expect(page.locator('#message')).toContainText("doesn't contain a Micro Plus preset");
});

test('compares presets', async ({ page }) => {
  await open(page);
  await page.locator('#compare-toggle').click();
  await page.locator('#next').click();
  await expect(page.locator('#current-number')).toHaveText('Preset 18');
  await page.locator('#compare-toggle').click();
  await expect(page.locator('#compare-presets button')).toHaveCount(2);
  await page.locator('#compare-differences').click();
  await expect(page.locator('#compare-table tbody tr')).toHaveCount(6);
  await page.keyboard.press('1');
  await expect(page.locator('#current-number')).toHaveText('Preset 17');
});

test('makes and uses a group', async ({ page }) => {
  await open(page);
  expect(await inSim(page, 'simulator.groups.apply({ action: "create", name: "Gig" }).then(() => simulator.groups.state.groups)')).toEqual(['Gig']);
  await page.locator('#open-presets').click();
  await expect(page.locator('#preset-groups')).toContainText('Gig');
});

test('tells you when the amp goes away, and carries on when it is back', async ({ page }) => {
  await open(page);
  await inSim(page, 'simulator.setMode("disconnected")');
  await expect(page.locator('#connection-text')).toHaveText('Reconnecting…');
  await expect(page.locator('#connection-banner')).toContainText('Lost the connection');
  await expect(page.locator('#save')).toBeDisabled();
  await inSim(page, 'simulator.setMode("ok")');
  await expect(page.locator('#connection-text')).toHaveText('Connected');
});

test('offers to choose the amp again when reconnecting keeps failing', async ({ page }) => {
  await open(page);
  await inSim(page, 'simulator.setMode("disconnected")');
  await expect(page.locator('#connection-text')).toHaveText('Reconnecting…');
  await expect(page.locator('#choose-again')).toBeHidden();
  await inSim(page, 'simulator.failedAttempts = 3');
  await page.locator('#choose-again').click();
  await expect(page.locator('#connection-text')).toHaveText('Connected');
  await expect(page.locator('#choose-again')).toBeHidden();
});

test('reports a change the amp did not confirm', async ({ page }) => {
  await open(page);
  await inSim(page, 'simulator.setMode("fail")');
  await firstSwitch(page).dispatchEvent('click');
  await expect(page.locator('#message')).toContainText('did not confirm');
  await expect(page.locator('#message')).toHaveAttribute('data-kind', 'error');
});

test('notices the knob on the amp being turned', async ({ page }) => {
  await open(page);
  await inSim(page, 'simulator.knob(5)');
  await expect(page.locator('#current-number')).toHaveText('Preset 5');
});

test('says what the amp stored when it limits a value', async ({ page }) => {
  await open(page);
  await page.locator('#board .pedal .name').first().click();
  const knob = page.locator('#closeup-body .knob input').first();
  const key = await knob.getAttribute('data-key');
  const [node, parameter] = key!.split('/');
  const stored = await inSim<number>(page, `simulator.document.audioGraph.nodes.find((entry) => entry.nodeId === '${node}').dspUnitParameters['${parameter}']`);
  await inSim(page, `simulator.limit('${node}', '${parameter}', ${stored})`);
  await knob.evaluate((input: HTMLInputElement) => {
    input.value = input.max;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#message')).toContainText('as far as the amp goes');
});

test('asks for a click before connecting to the real amp', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#connect')).toBeVisible();
  await expect(page.locator('#waiting-title')).toHaveText('Connect to your Micro Plus');
  await expect(page.locator('#connection-text')).toHaveText('Not connected');
});

test('says so when the browser has no Bluetooth', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'bluetooth', { value: undefined }));
  await page.goto('/');
  await expect(page.locator('#waiting-title')).toHaveText("Bluetooth isn't available here");
  await expect(page.locator('#connect')).toBeHidden();
});

test('works at phone size with no sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await open(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
