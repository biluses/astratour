// Validate configuration without ever echoing secrets or connection strings.
const env = process.env;
const failures = [];
const check = (ok, label) => { console.log(`${ok ? 'OK' : 'ERROR'} ${label}`); if (!ok) failures.push(label); };
for (const key of ['AUTH_GOOGLE_ID', 'AUTH_GOOGLE_SECRET', 'BLOB_READ_WRITE_TOKEN']) check(Boolean(env[key]?.trim()), key);
for (const key of ['AUTH_SECRET', 'CRON_SECRET', 'RECONSTRUCTION_WORKER_SECRET']) check((env[key]?.length ?? 0) >= 32, `${key} (>=32 caracteres)`);
let origin;
try {
  const url = new URL(env.APP_URL);
  origin = url.origin;
  check(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/' &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))), 'APP_URL origen HTTPS (HTTP solo local)');
} catch { check(false, 'APP_URL'); }
check(Boolean(origin && env.AUTH_URL === origin), 'AUTH_URL coincide con APP_URL');
try {
  const db = new URL(env.DATABASE_URL || env.POSTGRES_URL);
  check(['postgres:', 'postgresql:'].includes(db.protocol) && db.searchParams.get('sslmode') === 'require', 'Postgres con SSL');
} catch { check(false, 'DATABASE_URL'); }
check(/^sk_test_\S+$/.test(env.STRIPE_SECRET_KEY || ''), 'STRIPE_SECRET_KEY exclusivamente test');
check(/^whsec_\S+$/.test(env.STRIPE_WEBHOOK_SECRET || ''), 'STRIPE_WEBHOOK_SECRET');
check(['true', 'false'].includes(env.RECONSTRUCTION_ENABLED), 'RECONSTRUCTION_ENABLED explícito');
const minimum = Number(env.RECONSTRUCTION_MIN_IMAGES ?? 20);
check(Number.isInteger(minimum) && minimum >= 3 && minimum <= 500, 'RECONSTRUCTION_MIN_IMAGES (3–500)');
if (env.RECONSTRUCTION_ENABLED === 'false') console.log('INFO Captura y reconstrucción deshabilitadas: pendiente de puesta en servicio GPU.');
console.log(failures.length ? `${failures.length} comprobaciones fallidas.` : 'Configuración válida. Esto no prueba conectividad ni reconstrucción.');
process.exitCode = failures.length ? 1 : 0;
