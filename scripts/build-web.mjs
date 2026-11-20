import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const at = (path) => fileURLToPath(new URL(path, root));
const packages = 'node_modules/';
const assets = [
  ['@wllama/wllama/esm/index.js', 'vendor/wllama.mjs'],
  ['@wllama/wllama/esm/wasm/wllama.wasm', 'vendor/wllama.wasm'],
  ['@wllama/wllama/LICENCE', 'licenses/wllama.txt'],
  ['markdown-it/dist/browser/markdown-it.esm.min.mjs', 'vendor/markdown-it.mjs'],
  ['markdown-it/LICENSE', 'licenses/markdown-it.txt'],
  ['entities/LICENSE', 'licenses/entities.txt'],
  ['linkify-it/LICENSE', 'licenses/linkify-it.txt'],
  ['mdurl/LICENSE', 'licenses/mdurl.txt'],
  ['punycode.js/LICENSE-MIT.txt', 'licenses/punycode.js.txt'],
  ['uc.micro/LICENSE.txt', 'licenses/uc.micro.txt'],
  ['@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2', 'fonts/manrope.woff2'],
  ['@fontsource-variable/manrope/LICENSE', 'licenses/manrope.txt'],
  ['@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2', 'fonts/instrument-serif-italic.woff2'],
  ['@fontsource/instrument-serif/LICENSE', 'licenses/instrument-serif.txt'],
  ['@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2', 'fonts/jetbrains-mono.woff2'],
  ['@fontsource-variable/jetbrains-mono/LICENSE', 'licenses/jetbrains-mono.txt'],
];

await rm(at('dist'), { recursive: true, force: true });
await cp(at('web'), at('dist'), { recursive: true });
await Promise.all(['vendor', 'licenses', 'fonts'].map((dir) => mkdir(at(`dist/${dir}`), { recursive: true })));
await Promise.all([
  copyFile(at('LICENSE'), at('dist/licenses/frenemy.txt')),
  ...assets.map(([from, to]) => copyFile(at(packages + from), at(`dist/${to}`))),
]);
// A custom domain is published as a plain CNAME file. It is normalised here so
// a stray scheme, path or trailing dot fails the build instead of silently
// clearing the domain on the next deploy.
async function writeCname() {
  let raw;
  try { raw = await readFile(at('web/CNAME'), 'utf8'); }
  catch { return; }
  const domain = raw.trim().toLowerCase();
  if (!/^(?!-)[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/.test(domain)) {
    throw new Error(`web/CNAME must be a bare domain such as chorus.work.gd — found "${raw.trim()}". No https://, no path, no trailing dot.`);
  }
  await writeFile(at('dist/CNAME'), `${domain}\n`);
  console.log(`Custom domain: ${domain}`);
}

await writeCname();
console.log('Built the static Chorus website in dist/.');
