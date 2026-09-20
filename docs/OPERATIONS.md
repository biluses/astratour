# Operación y despliegue

## Fronteras de entorno

- GitHub: `biluses/astratour`.
- Vercel: `astratour`, equipo `biluses-projects`; dominio público canónico `https://astratour.vercel.app`.
- Blob privado: `astratour-private`, Frankfurt.
- Neon: `astratour-db`, Frankfurt. Development y production comparten actualmente el piloto; crear una rama/base independiente antes de operaciones comerciales.
- El alias largo `astratour-biluses-projects.vercel.app` está protegido por Vercel SSO. No utilizarlo para callbacks/webhooks ni desactivar la protección de los deployments.
- Google: proyecto `strong-retina-509120-t0`, cliente web AstraTour, audiencia de pruebas.
- Stripe: únicamente sandbox AstraTour. Nunca usar la configuración CLI por defecto del ordenador: pertenece a otro proyecto.

## Despliegue reproducible

1. `npm ci`, `npm run check`, `npm run build`; ejecutar UI y visor con Chromium instalado.
2. Revisar `.env.example` y `npm run env:check` sin imprimir valores.
3. Ejecutar `npm run db:migrate` una vez por base. El script registra migraciones aplicadas. No correr dos migradores simultáneamente; no se ejecuta automáticamente en el build.
4. Confirmar `vercel project inspect astratour` y Git remote antes de desplegar.
5. GitHub CI comprueba código sin secretos. `vercel --prod` publica el canal production, **no activa GPU ni cobros reales**.
6. Verificar alias, HTTP 200, cabeceras, callback Google exacto, webhook test y estado de despliegue. Los cambios de variables requieren redeploy.

No habilitar previews con credenciales compartidas del piloto: deben usar ramas, almacenes y sandbox de pruebas propios. El origen canónico es fijo para evitar redirecciones basadas en Host no confiable.

## Recuperación

- **GPU desconectada**: el lease dura cinco minutos. El siguiente claim recupera trabajos expirados; máximo tres intentos. El cron diario es un respaldo, no el mecanismo primario de cola.
- **Proceso agotado**: el tour queda en error; revisar captura y recursos antes de crear una captura nueva. No modificar tokens/estados manualmente para publicar artefactos.
- **Carga incierta**: reintentar en la misma sesión. El servidor reconcilia tamaño/MIME y propietario. Recargar durante una carga incompleta no restaura archivos del dispositivo; seleccionar una captura nueva si falta material.
- **Webhook retrasado**: la vuelta de Checkout no acredita pago. Consultar entrega del evento y repetir su envío desde el sandbox; la aplicación es idempotente. No marcar `pagado` manualmente.
- **Rollback**: volver a un despliegue compatible y mantener `RECONSTRUCTION_ENABLED=false`. No revertir SQL destructivamente.

## Límites conocidos antes del lanzamiento comercial

No hay borrado de tours ni política automática de retención de Blob. Los artefactos de intentos abortados pueden permanecer en el almacén privado. Antes de una beta abierta hay que implementar cuota acumulada por usuario, expiración y borrado auditable, métricas/alertas y límites de coste. El rate limit actual controla frecuencia, no presupuesto total. No efectuar limpiezas masivas sobre otros almacenes.

El plan Hobby de Vercel y las cuentas gratuitas son para esta validación; revisar condiciones y capacidad antes de uso comercial. Auth.js v5 sigue fijado a una beta. No existe evaluación completa de accesibilidad, carga ni compatibilidad de todas las GPU/navegadores.
