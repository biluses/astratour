# Worker de reconstrucción AstraTour

**Implementado, pendiente de commissioning en GPU real.** Los tests de contratos y de empaquetado sintético no prueban que la imagen Docker entrene correctamente ni que una captura inmobiliaria resulte utilizable.

## Requisitos y aislamiento

- Host Linux x86_64 con GPU NVIDIA compatible con CUDA 11.8, driver y NVIDIA Container Toolkit.
- Orientación inicial: 16–24 GiB VRAM, suficiente RAM para el dataset y ≥40 GiB libres por trabajo. Medir con la captura objetivo antes de fijar el dimensionamiento/SLA.
- Salida HTTPS hacia la aplicación y el Blob dedicado. No necesita puertos entrantes ni servidor de visor abierto.
- Un trabajo concurrente por proceso; cada worker con `WORKER_ID` único. Compartir el secreto solo con workers autorizados.
- No arrancar recursos de pago hasta acordar presupuesto, apagado automático y responsable.

La imagen fija por digest Node, Nerfstudio 1.1.5, CUDA y COLMAP; los paquetes JavaScript están fijados en el lockfile. La compilación Docker y compatibilidad con el host siguen siendo criterios de aceptación pendientes.

## Construcción y ejecución

Desde la raíz:

```bash
docker build --platform linux/amd64 -t astratour-worker:1 ./worker
cp worker/.env.example worker/.env.local
chmod 600 worker/.env.local
# Rellenar URL canónica y secretos; jamás usar los de otro proyecto.
docker run --rm --gpus all --init --shm-size=8g \
  --env-file worker/.env.local \
  --mount type=volume,source=astratour-work,target=/work \
  astratour-worker:1 --once
```

El proceso corre como UID/GID 10001. El volumen debe permitirle escribir; no ampliar permisos del host indiscriminadamente. Se recomienda `--once` con infraestructura bajo demanda que se apague al salir, no mantener una GPU encendida esperando indefinidamente.

`ASTRATOUR_API_URL` debe ser el origen HTTPS canónico (sin ruta ni redirección). `RECONSTRUCTION_WORKER_SECRET` debe coincidir con Vercel. `BLOB_READ_WRITE_TOKEN` da acceso al **almacén dedicado completo**: el worker es un componente de confianza, no se distribuye al navegador.

## Runpod prebuilt image

`ghcr.io/biluses/astratour-worker` (tags `sha-<short>` and the branch name, e.g. `main`) is built by `.github/workflows/worker-image.yml` from `Dockerfile.runpod`: the `runpod-once.sh` stack (CUDA 12.8, torch, COLMAP, Node 22, Nerfstudio 1.1.5 in `/opt/ns`) plus gsplat 1.4.0 kernels compiled ahead of time for sm_86/89/90/120, so jobs skip the ~10 min install and the ~5 min first-run gsplat compile.

- Container start command (keeps Jupyter/SSH/web terminal from `/start.sh`):
  `bash -c "nohup /opt/astratour/run-once.sh > /workspace/worker.log 2>&1 & exec /start.sh"`
- `run-once.sh` runs `xvfb-run -a python main.py --once`, then stops the pod on exit; a 90 min wall-clock guard (`WORKER_POD_MAX_SECONDS`) also stops it.
- Env: `RECONSTRUCTION_WORKER_SECRET={{ RUNPOD_SECRET_astratour_worker_secret }}` and `BLOB_READ_WRITE_TOKEN={{ RUNPOD_SECRET_astratour_blob_token }}`. `ASTRATOUR_API_URL` defaults to production.
- Container disk: at least 40 GB.
- Warning: in our test the deploy page "Set overrides" silently did not apply the start command or env. Configure them via pod ⋮ → Edit Pod, then verify in the web terminal with `tr '\0' ' ' < /proc/1/cmdline` and `tr '\0' '\n' < /proc/1/environ | cut -d= -f1` (names only, never print values); `pgrep -af run-once` confirms the worker started.

## Tubería

1. Reclamar trabajo con lease y token; descargar únicamente las rutas reservadas.
2. Verificar bytes/MIME reales, límites, orientación EXIF y resolución; eliminar metadatos al normalizar.
3. COLMAP sobre la secuencia normalizada; exigir ≥40 cámaras y ≥80 % de registro por defecto.
4. Entrenar Splatfacto; exportar el PLY. Límite total de intento: cuatro horas.
5. Renderizar el modelo entrenado con cámaras registradas; incrustar marca de agua en los píxeles.
6. Rotar escena y cámara de z-up a y-up; convertir a SOG con codificación CPU.
7. Generar HTML autónomo, ZIP, manifiesto y licencias; subir a rutas exclusivas del token.
8. Publicar atómicamente mediante `/complete`. Reintentos tardíos no publican con leases caducados.

Una pérdida de lease, timeout o límite de disco detiene todo el grupo de subprocesos. SIGTERM desenrolla la limpieza. El directorio temporal con originales, checkpoints y logs se elimina al terminar. Los mensajes remotos no incluyen secretos, rutas ni stderr de herramientas.

## Aceptación pendiente

- Construir imagen; comprobar CUDA, COLMAP, `ns-train`, `ns-export` y dependencias en el host real.
- Captura autorizada de una estancia con suficiente solapamiento; registrar porcentaje de cámaras, VRAM/RAM/disco, duración y coste.
- Verificar orientación/cámara, fidelidad visual y que los renders proceden del modelo, no de originales.
- Interrumpir un worker: confirmar recuperación, fencing, límite de intentos y limpieza.
- Comprobar end-to-end Google → carga → GPU → previsualización → Checkout test → webhook → visor/ZIP.
- Solo entonces activar `RECONSTRUCTION_ENABLED=true` para el piloto. Cobros live requieren una decisión e implementación independientes.
