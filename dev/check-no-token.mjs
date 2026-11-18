// Fails the web build if the App Check debug token from .env.local ended up in the public files.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const token = (readFileSync('.env.local', 'utf8').match(/^VITE_APPCHECK_DEBUG_TOKEN=(.+)$/m)?.[1] ?? '').trim();
const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const leaks = token ? walk(process.argv[2]).filter((f) => readFileSync(f).includes(token)) : [];
if (leaks.length) {
  console.error('Debug token found in', leaks);
  process.exit(1);
}
console.log('web build: no debug token in', process.argv[2]);
