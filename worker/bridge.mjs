/** Private Blob streaming bridge. No token is accepted on argv or emitted in output. */
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { get, put } from '@vercel/blob';
import { defaultSettings } from '@playcanvas/supersplat-viewer/settings';

const [operation, manifestFile] = process.argv.slice(2);
try {
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (operation === 'download') {
    for (const file of manifest.files) {
      const result = await get(file.path, { access: 'private', useCache: false });
      if (!result || result.statusCode !== 200 || result.blob.size !== file.sizeBytes ||
          result.blob.contentType !== file.contentType || result.blob.pathname !== file.path) {
        throw new Error('Input object metadata mismatch');
      }
      let received = 0;
      const limiter = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          callback(received > file.sizeBytes ? new Error('Input object too large') : null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(result.stream), limiter, createWriteStream(file.localPath, { flags: 'wx', mode: 0o600 }));
      if (received !== file.sizeBytes) throw new Error('Truncated input object');
    }
  } else if (operation === 'upload') {
    for (const file of manifest.files) {
      const info = await stat(file.localPath);
      if (!info.isFile() || info.size < 1 || info.size > file.maxBytes) throw new Error('Invalid output file size');
      const result = await put(file.path, createReadStream(file.localPath), {
        access: 'private', contentType: file.contentType, addRandomSuffix: false,
        allowOverwrite: false, multipart: info.size > 50 * 1024 * 1024,
      });
      if (result.pathname !== file.path) throw new Error('Unexpected output object path');
    }
  } else if (operation === 'settings') {
    const settings = defaultSettings();
    settings.cameras = [{ initial: manifest.camera }];
    settings.startMode = 'default';
    await writeFile(manifest.output, JSON.stringify(settings), { flag: 'wx', mode: 0o600 });
  } else {
    throw new Error('Unknown bridge operation');
  }
} catch {
  // SDK errors can contain URLs or credentials: keep private implementation details out of logs.
  process.stderr.write(`Private storage bridge failed (${operation}).\n`);
  process.exitCode = 1;
}
