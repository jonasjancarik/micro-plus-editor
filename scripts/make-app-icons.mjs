// Draws the phone apps' icons and splash screens from web/public/icon.svg. Run from the repo root.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const svg = readFileSync('web/public/icon.svg', 'utf8');
const PAPER = '#f5f1ea';
const browser = await chromium.launch({ channel: 'chrome' });

async function draw(path, width, height, scale, background = PAPER) {
  const page = await browser.newPage({ viewport: { width, height } });
  const size = Math.min(width, height) * scale;
  await page.setContent(`<!doctype html><style>html,body{margin:0;height:100%;background:${background};display:grid;place-items:center}
    svg{width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path, omitBackground: background === 'transparent' });
  await page.close();
}

const assets = 'ios/App/App/Assets.xcassets';
await draw(`${assets}/AppIcon.appiconset/AppIcon-512@2x.png`, 1024, 1024, .8);
for (const file of ['', '-1', '-2']) await draw(`${assets}/Splash.imageset/splash-2732x2732${file}.png`, 2732, 2732, .15);

// Android's sizes, one set per screen density.
const res = 'android/app/src/main/res';
const icons = { xhdpi: 96, mdpi: 48, hdpi: 72, xxhdpi: 144, xxxhdpi: 192 };
for (const [density, size] of Object.entries(icons)) {
  const folder = `${res}/mipmap-${density}`;
  await draw(`${folder}/ic_launcher.png`, size, size, .8);
  await draw(`${folder}/ic_launcher_round.png`, size, size, .6);
  await draw(`${folder}/ic_launcher_foreground.png`, size * 2.25, size * 2.25, .5, 'transparent');
}
const splashes = {
  'drawable': [480, 320], 'drawable-land-mdpi': [480, 320], 'drawable-land-hdpi': [800, 480], 'drawable-land-xhdpi': [1280, 720],
  'drawable-land-xxhdpi': [1600, 960], 'drawable-land-xxxhdpi': [1920, 1280], 'drawable-port-mdpi': [320, 480], 'drawable-port-hdpi': [480, 800],
  'drawable-port-xhdpi': [720, 1280], 'drawable-port-xxhdpi': [960, 1600], 'drawable-port-xxxhdpi': [1280, 1920],
};
for (const [folder, [width, height]] of Object.entries(splashes)) await draw(`${res}/${folder}/splash.png`, width, height, .3);
await browser.close();
