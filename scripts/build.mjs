import { build } from 'esbuild';
import { readdir, readFile, writeFile, realpath, mkdir, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

await mkdir('dist/page', { recursive: true });
for (const file of ['index.html', 'boot.js', '.npmignore']) await copyFile(join('page', file), join('dist/page', file));
await copyFile('web/public/brand.svg', 'dist/page/brand.svg');

await build({
  entryPoints: { plugin: 'src/plugin.mjs', cli: 'src/cli.mjs' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: "import { createRequire as createBundledRequire } from 'node:module'; const require = createBundledRequire(import.meta.url);" },
  sourcemap: true,
  legalComments: 'eof',
});

// Ship the same pinned management CLI as the desktop, without runtime npm downloads.
const skillsRoot = dirname(createRequire(import.meta.url).resolve('skills/package.json'));
await mkdir('dist/vendor/skills/bin', { recursive: true });
await build({
  entryPoints: [join(skillsRoot, 'dist/cli.mjs')],
  outfile: 'dist/vendor/skills/dist/cli.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  banner: { js: "import { createRequire as createBundledRequire } from 'node:module'; const require = createBundledRequire(import.meta.url);" },
  legalComments: 'eof',
});
await copyFile(join(skillsRoot, 'bin/cli.mjs'), 'dist/vendor/skills/bin/cli.mjs');
await copyFile(join(skillsRoot, 'package.json'), 'dist/vendor/skills/package.json');
await copyFile(join(skillsRoot, 'ThirdPartyNoticeText.txt'), 'dist/vendor/skills/ThirdPartyNoticeText.txt');

// Keep the original dependency license texts with the self-contained bundle.
const notices = new Map();
const visited = new Set();
async function licenseOf(directory) {
  try {
    directory = await realpath(directory);
    if (visited.has(directory)) return;
    visited.add(directory);
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const texts = [];
    for (const file of await readdir(directory)) {
      if (/^(?:licen[sc]e|copying|ofl)(?:\.|$)/i.test(file)) {
        try { texts.push(await readFile(join(directory, file), 'utf8')); } catch {}
      }
    }
    if (texts.length) notices.set(`${manifest.name}@${manifest.version}`, texts.join('\n\n'));
  } catch {}
}
for (const directory of await readdir('node_modules/.pnpm')) {
  if (directory === 'node_modules' || directory.endsWith('.yaml')) continue;
  const modules = join('node_modules/.pnpm', directory, 'node_modules');
  let children;
  try { children = await readdir(modules); } catch { continue; }
  for (const child of children) {
    if (child.startsWith('@')) {
      try { for (const scoped of await readdir(join(modules, child))) await licenseOf(join(modules, child, scoped)); }
      catch {}
    } else await licenseOf(join(modules, child));
  }
}
await writeFile('dist/THIRD_PARTY_LICENSES.txt', [...notices.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, license]) => `${'='.repeat(72)}\n${name}\n${'='.repeat(72)}\n\n${license}`)
  .join('\n\n'));
