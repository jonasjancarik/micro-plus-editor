// Decides what the page talks to, then starts it.
import { chooseBackend } from './backend';

await chooseBackend();
await import('./main');
