import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.jonasjancarik.microplus',
  appName: 'Micro Plus editor',
  webDir: 'dist',
  // Plain http lets the Bluetooth test save its results to the dev server through adb reverse.
  server: { androidScheme: 'http', cleartext: true },
};

export default config;
