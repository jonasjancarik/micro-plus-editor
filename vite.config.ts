import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const RESULTS = resolve(import.meta.dirname, '_work/bluetooth-test');

// Saves what the Bluetooth test page reports, so a run can be read after it has finished or while it goes on.
function saveResults(): Plugin {
  return {
    name: 'save-bluetooth-test-results',
    configureServer(server) {
      server.middlewares.use('/results', (request, response) => {
        const run = new URL(request.url ?? '', 'http://local').searchParams.get('run') ?? '';
        if (request.method !== 'POST' || !/^[\w-]{1,80}$/.test(run)) {
          response.statusCode = 400;
          response.end();
          return;
        }
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          mkdirSync(RESULTS, { recursive: true });
          appendFileSync(resolve(RESULTS, `${run}.jsonl`), Buffer.concat(chunks));
          response.statusCode = 204;
          response.end();
        });
      });
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  publicDir: 'web/public',
  server: { host: '0.0.0.0', port: 5175, strictPort: true, watch: { ignored: ['**/android/**', '**/ios/**', '**/_work/**'] } },
  build: { outDir: resolve(import.meta.dirname, 'dist'), emptyOutDir: true, target: 'es2022' },
  base: './',
  plugins: [saveResults()],
  test: { root: import.meta.dirname, include: ['tests/**/*.test.ts'] },
} as never);
