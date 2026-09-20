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
| Neon remoto | Consulta real de schema_migrations: 001 y 002 verificadas |
| Blob privado remoto | Escritura, lectura exacta y eliminación de un objeto temporal propio verificadas |
| GitHub | Commit d44245f publicado en main, SHA local/remota coincidentes |
| GitHub Actions | [Run 35510643767](https://github.com/biluses/astratour/actions/runs/35510643767) correcto, incluidos UI y visor en Linux |
| Vercel | Deployment dpl_CGYkt4m1V7LZwZoi2JdzNtHhrEck READY; funciones fra1 |
| Web pública | https://astratour.vercel.app HTTP 200, UI desktop/móvil correcta |
| APIs desplegadas sin sesión | Modelo, visor, ZIP, worker y mantenimiento devuelven 401; webhook sin firma 400 |
| Gate de GPU remoto | Worker autenticado rechazado con 503 mientras la reconstrucción está deshabilitada |

## Qué se prueba y qué no

Los tests SQL usan el esquema real y PGlite. Se ejercitan separación de propietarios, descarga/modelo/visor bloqueados antes de pago, origen de solicitudes, archivos privados, token de worker, jobs únicos, leases expirados, publicación atómica e idempotencia de Stripe. Las firmas de Stripe se verifican con el SDK; las sesiones son fixtures y las llamadas remotas de Checkout/Blob se sustituyen por mocks.

La prueba del visor sí ejecuta SplatTransform y Chromium reales, pero su entrada es una esfera sintética creada para el test. No representa un inmueble ni fotos reconstruidas. El render offline prueba el formato de entrega sin dependencia de una sesión de AstraTour.

## Pendiente de verificación integrada

- Google OAuth: sustituir el callback del alias largo protegido por el dominio público (pendiente de confirmación), comprobar login y persistencia del usuario.
- Reclamar el sandbox Stripe exclusivo creado (caduca el 27/09/2026 si no se reclama), obtener clave permanente, crear webhook y verificar Checkout completo de pruebas. Pendiente de elección de cuenta contenedora.
- Construir/ejecutar Docker NVIDIA y procesar una captura real autorizada.
- Confirmar calidad, cámara/orientación, consumo, duración y coste reales; validar recuperación con interrupción de GPU.
- Recorrido completo de propietario: fotos → GPU → renders → pago test → SOG/HTML/ZIP.

Se mantiene `RECONSTRUCTION_ENABLED=false` y el rechazo de claves live. No hay SLA, evaluación de carga, auditoría exhaustiva de accesibilidad ni compatibilidad universal de navegador/GPU. No declarar el producto listo para cobros reales con estos resultados.
