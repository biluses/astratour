import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { css, js } from '@playcanvas/supersplat-viewer';

// The published package exports a complete, self-hostable bundle, not a React API.
// Keep generated vendor files out of Git; npm ci + prebuild reproduces them.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.resolve('@playcanvas/supersplat-viewer'))), '..');
const pkg = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
if (pkg.version !== '1.31.2') throw new Error('Review the viewer integration before upgrading SuperSplat Viewer.');
const output = fileURLToPath(new URL(`../public/viewer/${pkg.version}/`, import.meta.url));
const license = await readFile(resolve(packageRoot, 'LICENSE'), 'utf8');
await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(resolve(output, 'index.js'), js),
  writeFile(resolve(output, 'index.css'), css),
  writeFile(resolve(output, 'LICENSE.txt'), license),
  writeFile(resolve(output, 'NOTICE.txt'), [
    `SuperSplat Viewer ${pkg.version} — https://github.com/playcanvas/supersplat-viewer`,
    'Includes PlayCanvas Engine 2.22.1 — https://github.com/playcanvas/engine',
    'Both are copyright (c) 2011-2026 PlayCanvas Ltd. and MIT licensed.',
    'The full copyright and permission notice is distributed in LICENSE.txt.',
    'No scene files, user data or credentials are included in these public assets.',
    '',
  ].join('\n')),
]);
console.log(`Prepared self-hosted SuperSplat Viewer ${pkg.version}.`);
