// Starts the Vite dev server and launches Electron against it.
import { createServer } from 'vite';
import { spawn } from 'child_process';
import { execSync } from 'child_process';
execSync('node scripts/build-electron.mjs', { stdio: 'inherit' });
const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const url = server.resolvedUrls.local[0];
const electron = (await import('electron')).default;
const args = ['.'];
if (process.getuid && process.getuid() === 0) args.push('--no-sandbox');
const child = spawn(electron, args, { stdio: 'inherit', env: { ...process.env, VITE_DEV_SERVER_URL: url } });
child.on('exit', () => server.close().then(() => process.exit(0)));
