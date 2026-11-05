import { app, BrowserWindow, dialog, net, protocol, session } from 'electron';
import { existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..', 'dist');
const devUrl = process.env.ELECTRON_START_URL;

// Web Bluetooth only works on secure pages, so the built page is served from app:// rather than file://.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

function createWindow() {
  const window = new BrowserWindow({ width: 1280, height: 860, backgroundColor: '#111111', title: 'Micro Plus' });

  // Chrome shows a device picker; Electron leaves that to us. Wait a moment for nearby amps to show up, then ask.
  let devices = [];
  let answer = null;
  let timer = null;
  let asking = false;
  window.webContents.on('select-bluetooth-device', (event, found, callback) => {
    event.preventDefault();
    devices = found;
    answer = callback;
    if (asking || found.length === 0 || timer) return;
    timer = setTimeout(async () => {
      timer = null;
      asking = true;
      const shown = devices.slice(0, 8);
      const { response } = await dialog.showMessageBox(window, {
        type: 'question',
        message: 'Choose your amp',
        detail: 'Turn the amp on and close Fender Tone on your other devices first.',
        buttons: [...shown.map((device) => device.deviceName || device.deviceId), 'Cancel'],
        cancelId: shown.length,
      });
      asking = false;
      const callbackNow = answer;
      answer = null;
      callbackNow?.(response < shown.length ? shown[response].deviceId : '');
    }, 1500);
  });

  const query = process.env.MICRO_PLUS_SIMULATOR ? '?simulator=1' : '';
  window.loadURL(`${devUrl ?? 'app://page/index.html'}${devUrl ? '' : query}`);
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'bluetooth' || permission === 'clipboard-sanitized-write');
  session.defaultSession.setDevicePermissionHandler((details) => details.deviceType === 'bluetooth');

  protocol.handle('app', (request) => {
    const path = normalize(decodeURIComponent(new URL(request.url).pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(root, path === '/' ? 'index.html' : path);
    if (!file.startsWith(root) || !existsSync(file)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => app.quit());
