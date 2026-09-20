# Verificación de AstraTour

Corte: **20 de septiembre de 2026**. Las comprobaciones sintéticas no acreditan una reconstrucción inmobiliaria real.

| Comprobación ejecutada | Resultado |
|---|---|
| TypeScript | Sin errores |
| Vitest + PostgreSQL/PGlite | 31 pruebas correctas: ownership, pago, límites, cola, fencing, visor y recuperación de cargas |
| Python worker | 12 pruebas de contratos correctas; no CUDA ni COLMAP |
| Next.js 15.5.25 build | Correcto, Node 22, JavaScript inicial estimado 156 kB |
| UI Chromium | Desktop 1440×1000 y móvil 390×844: HTTP 200, cuatro pasos, sin overflow ni errores de ejecución |
| Conversión real CPU sintética | 1024 gaussianas PLY → SOG → HTML autónomo con SplatTransform 3.4.2 |
| SuperSplat 1.31.2 alojado | Primer frame con CSP de producción, sin recursos externos ni errores de ejecución |
| Pack HTML sin conexión | Primer frame desde file:// con contexto offline |
| Auditoría dependencias runtime | 0 vulnerabilidades conocidas en aplicación y worker al corte |
| Neon remoto | Migraciones 001 y 002 aplicadas previamente; volver a comprobar tras despliegue |

## Qué se prueba y qué no

Los tests SQL usan el esquema real y PGlite. Se ejercitan separación de propietarios, descarga/modelo/visor bloqueados antes de pago, origen de solicitudes, archivos privados, token de worker, jobs únicos, leases expirados, publicación atómica e idempotencia de Stripe. Las firmas de Stripe se verifican con el SDK; las sesiones son fixtures y las llamadas remotas de Checkout/Blob se sustituyen por mocks.

La prueba del visor sí ejecuta SplatTransform y Chromium reales, pero su entrada es una esfera sintética creada para el test. No representa un inmueble ni fotos reconstruidas. El render offline prueba el formato de entrega sin dependencia de una sesión de AstraTour.

## Pendiente de verificación integrada

- GitHub push, CI remota, despliegue Vercel y alias canónico: registrar evidencia al completarlos.
- Google OAuth desplegado, escritura del usuario en Neon y acceso privado a Blob.
- Reclamar sandbox Stripe exclusivo; crear webhook y verificar Checkout completo de pruebas.
- Construir/ejecutar Docker NVIDIA y procesar una captura real autorizada.
- Confirmar calidad, cámara/orientación, consumo, duración y coste reales; validar recuperación con interrupción de GPU.
- Recorrido completo de propietario: fotos → GPU → renders → pago test → SOG/HTML/ZIP.

Se mantiene `RECONSTRUCTION_ENABLED=false` y el rechazo de claves live. No hay SLA, evaluación de carga, auditoría exhaustiva de accesibilidad ni compatibilidad universal de navegador/GPU. No declarar el producto listo para cobros reales con estos resultados.
