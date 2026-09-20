import { spawn } from 'node:child_process';
const origin = 'http://127.0.0.1:3100';
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', '3100'], { stdio: 'inherit' });
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw new Error('Preview server exited');
    try { const res = await fetch(origin, { signal: AbortSignal.timeout(500) }); ready = res.ok; } catch { /* Starting */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('Preview server did not become ready');
  const test = spawn(process.execPath, ['scripts/smoke.mjs'], { stdio: 'inherit', env: { ...process.env, SMOKE_ORIGIN: origin } });
  process.exitCode = await new Promise(resolve => test.on('exit', code => resolve(code ?? 1)));
} finally { server.kill('SIGTERM'); }
