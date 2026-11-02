// Decides what the page talks to, then starts it.
import '@fontsource-variable/archivo/wdth.css';
import { chooseBackend } from './backend';

await chooseBackend();
await import('./main');
