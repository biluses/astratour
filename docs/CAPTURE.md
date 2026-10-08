# Captura y diagnóstico previo a GPU

## Captura aceptada por este piloto

- Una estancia o recorrido conectado, no una selección de fotografías comerciales de zonas independientes.
- Misma cámara/lente, resolución y orientación. Sin recortes ni versiones retocadas del mismo encuadre.
- JPG o PNG, 40–500 imágenes (bloqueante por debajo de 40; recomendadas 60–80 por estancia), 10 MiB por archivo, 2 GiB por captura. El mínimo es un control operativo, no una promesa de calidad.
- Girar como máximo unos 20° entre fotos consecutivas (≈ un tercio del encuadre, ~70 % de solapamiento) y que cada zona aparezca en al menos 3 fotos. Recorrer el perímetro mirando hacia dentro y cubrir alrededor del centro mirando hacia fuera, a dos alturas, desplazándose ~0,5 m entre posiciones; no girar sobre un punto fijo (sin paralaje).
- Guía para usuarios: `/guia-captura`.

## Comprobaciones en el navegador antes de subir

`src/lib/capture-checks.ts` analiza cada foto (orientación EXIF aplicada, copias reducidas a 1024 y 512 px de lado largo):

- **Bloquean:** más de un tamaño/orientación en la captura (el worker asume una sola cámara), lado corto < 720 px, archivos duplicados (SHA-256). Las fotos causantes se marcan en rojo en las miniaturas y un botón las quita de una vez (se conserva la orientación mayoritaria y la primera copia).
- **Avisan:** fotos que el navegador no puede analizar, lado corto < 1080 px, nitidez < 0,20 (posible desenfoque: varianza del laplaciano a 1024 px dividida por la de 512 px; calibrado, ver Evidencia), luminancia media < 40/255 (una foto oscura no se marca además como desenfocada), menos de 60 fotos (recomendado).
- Iluminación consistente, imágenes nítidas y escena estática. Evitar basar la captura en espejos y reflejos.

La [guía de PlayCanvas](https://developer.playcanvas.com/user-manual/gaussian-splatting/creating/taking-photos/) describe estas condiciones y orienta a cientos de fotos para escenas grandes. El pipeline actual no admite vídeo ni HEIC directamente.

## Diagnóstico local sin costes de nube

Herramienta opcional; no cambia los originales ni envía fotos a terceros. Python 3.10+ y un entorno virtual separado:

```bash
python3 -m venv .secrets/capture-tools
.secrets/capture-tools/bin/pip install pycolmap==4.2.0 Pillow==12.1.0
.secrets/capture-tools/bin/python scripts/assess-capture.py \
  '/ruta/a/las/fotos' '.secrets/diagnostico-nuevo'
```

El directorio de salida debe ser nuevo. Contiene copias de fotos, nombres, correspondencias y geometría de la vivienda: **mantenerlo privado y fuera de Git**. La implementación usa PyCOLMAP 4.2.0 en CPU, cámaras independientes por imagen y SIFT exhaustivo. Es un diagnóstico exploratorio, no sustituye la prueba del contenedor de producción con COLMAP 3.9.1/Nerfstudio 1.1.5.

El script limita el mapper a cinco minutos y cuatro hilos; si se ejecuta externamente conviene acotar también el tiempo total. No baja los umbrales del worker de producción ni habilita la entrega de modelos parciales como tours terminados.

## Interpretación

`largestConnectedReconstruction` indica cuántas cámaras entraron en el mayor modelo recuperado; no es una métrica de fidelidad visual. `verifiedImagePairs` cuenta pares con geometría verificada y tampoco garantiza una escena completa. Revisar ambos junto con la geometría y la captura.

El worker exige por defecto al menos 40 fotos, 40 cámaras registradas y el 80 % de las imágenes en una reconstrucción. Entrenar una representación visual sobre un registro insuficiente no recupera zonas nunca observadas.

Si el diagnóstico falla, preparar una captura continua antes de contratar GPU. No sustituir el resultado por un slideshow o una escena inventada y etiquetarlo como reconstrucción real.

## Evidencia

Benchmark local (sin GPU de pago), reproducible con los scripts privados de `.secrets/capture-study/`. Escenas públicas de Deep Blending (repositorio oficial de 3D Gaussian Splatting, INRIA): *playroom* (una estancia, 225 fotos) y *drjohnson* (casa con varias estancias, 263 fotos). Submuestreo uniforme de N fotos.

**Registro de cámaras** (PyCOLMAP 4.2, SIFT + emparejamiento exhaustivo, igual que el worker; % de fotos en el mayor modelo conectado):

| Fotos | 8 | 12 | 16 | 20 | 24 | 30 | 40 | 60 | 90 |
|---|---|---|---|---|---|---|---|---|---|
| Una estancia | 0 % | 25 % | 25 % | 45 % | 25 % | 80 % | 72 % | 95 % | 99 % |
| Varias estancias | 0 % | 17 % | 25 % | 20 % | 21 % | 20 % | 55 % | 38 % | 98 % |

**Calidad en vistas no usadas para entrenar** (PSNR dB sobre 8 vistas fijas reservadas; poses de referencia, Brush 0.3, 5000 pasos, 640 px, SH1; sirve para comparar N, no como calidad final):

| Fotos | 8 | 16 | 24 | 32 | 48 | 64 | 96 | 144 |
|---|---|---|---|---|---|---|---|---|
| Una estancia | 14,6 | 19,7 | 19,9 | 22,4 | 23,8 | 25,4 | 27,7 | 27,7 |
| Varias estancias | — | 17,3 | — | 19,2 | 22,4 | 23,5 | 25,8 | 26,3 |

**Regla por foto** (una estancia): según el giro respecto a su segunda foto más parecida (FOV horizontal ≈ 63°): ≤ 30° → 94–100 % registradas; 30–40° → 78 %; 40–60° → 50 %; > 60° → 27 %. De ahí la regla de ≤ 20° entre tomas y cada zona en ≥ 3 fotos.

**Conclusiones aplicadas:**
- Mínimo bloqueante **40**: con menos de 30 fotos se registra menos del 50 % en ambas escenas y entre 30 y 40 el resultado es inestable (20–80 %). `RECONSTRUCTION_MIN_IMAGES` y `WORKER_MIN_IMAGES` solo pueden subirlo: un valor menor se eleva a 40.
- Recomendado **60–80 por estancia** (registro ≥ 95 %); la calidad deja de mejorar hacia **90–100**. Varias estancias conectadas: ~90 o más en total.
- Desenfoque (métrica anterior, sustituida el 08/10/2026): varianza del laplaciano a 512 px de lado largo, umbral 60, calibrada con 52 fotos de interior de réflex. Ver la recalibración más abajo.
- No verificado empíricamente: la regla de no girar sobre uno mismo sin desplazarse se basa en la geometría (sin paralaje no hay triangulación), no en este benchmark.
- Límite: capturas de cámara réflex con tomas espaciadas; deben revalidarse con capturas reales de móvil de viviendas.

### Alternativas para usar menos fotos (27/09/2026, GPU en la nube)

Cámaras registradas y error frente a las poses de referencia (mediana de giro; posición en % de la dispersión de cámaras). COLMAP incremental, una sola cámara:

| Escena · fotos | SIFT (producción) | ALIKED + LightGlue |
|---|---|---|
| Una estancia · 24 | 6 · 0,4° | 8 · 1,1° |
| Una estancia · 30 | 21 · 0,2° | 23 · 2,7° (posición 19 %) |
| Una estancia · 40 | 24 · 0,2° | **34 · 0,3°** |
| Varias estancias · 24–40 | 6–19 · 1,5–5,5° | 18–35 · **105–144° (poses erróneas)** |

- ALIKED + LightGlue (licencias comerciales: ALIKED BSD-3, LightGlue Apache-2.0) mejora una estancia con 40 fotos, pero en viviendas con varias estancias empareja zonas parecidas y produce poses falsas. El control actual (porcentaje de cámaras registradas) no detecta poses falsas. No se adopta.
- El mapeador global de COLMAP registra todas las fotos con 16–40 imágenes, pero con poses erróneas (7–147°). No se adopta.
- MapAnything (pesos Apache) sin COLMAP: 14–16 dB frente a 20–22 dB con poses de referencia. No se adopta.
- Generar vistas con IA: ganancias publicadas pequeñas (~0,3 dB) y licencias mayoritariamente no comerciales. No se adopta.

**Pipeline de producción en GPU (RTX 4090, playroom, 60 fotos):** COLMAP 3.9.1 (CPU) 6,5 min (extracción 20 s, emparejamiento exhaustivo 5,5 min); 49/60 cámaras en el mayor modelo; splatfacto 30.000 iteraciones 19 min (incluye ~5 min de compilación JIT de gsplat en el primer uso); evaluación en vistas reservadas PSNR 25,5 dB, SSIM 0,83, LPIPS 0,28; exportación 510.809 gaussianas (127 MB PLY). Coste de GPU ≈ 0,3 USD por estancia a 0,74 USD/h. Con COLMAP con CUDA y gsplat precompilado en la imagen, el tiempo baja.

**Corrección del worker:** COLMAP puede dividir una captura en varios modelos y `ns-process-data` 1.1.5 convierte siempre `sparse/0`. Con 60 fotos de una estancia, `sparse/0` tenía 2 cámaras y `sparse/1`, 49. El worker ahora promueve el modelo con más cámaras antes de comprobar el registro.

### Captura real de móvil en el navegador (08/10/2026)

Prueba en Chromium con 41 fotos de iPhone 7 (12 MP, exterior; dataset público `alicevision/dataset_monstree`), sesión local y reconstrucción deshabilitada:

- 5 de 41 fotos salieron en horizontal y el resto en vertical: la captura queda bloqueada, igual que la rechazaría el worker (`worker/images.py`). Análisis de las 41 fotos en 12 s.
- Con la métrica anterior el aviso de desenfoque solo saltaba a partir de ~12 px de desenfoque a resolución completa (varianza 3.279 nítida, 1.279 con 4 px, 231 con 8 px, 58 con 12 px), aunque el worker trabaja a 2048 px. Motivó la recalibración siguiente.

### Recalibración del aviso de desenfoque (08/10/2026)

Fotos públicas: 41 de iPhone 7 (árbol, `alicevision/dataset_monstree`) y 67 de 2736×1540 (cabeza de Buda sobre una mesa, `alicevision/dataset_buddha`). Desenfoque gaussiano σ expresado en px a 2048 de lado largo, la resolución con la que trabaja el worker.

- La varianza absoluta no sirve con un umbral fijo: a 1024 px, percentil 5 de las nítidas = 973 (árbol) y 49 (Buda); percentil 95 con σ = 2 = 232 (árbol). Una foto nítida del Buda puntúa por debajo de una corteza desenfocada.
- La proporción 1024/512 sí es comparable entre escenas (sharp/libvips): nítidas, mínimo 0,47 (árbol) y 0,25 (Buda); σ = 1,5, mediana 0,24 y 0,19; σ = 2, máximo 0,17 en ambas. Umbral de aviso: 0,20.
- En Chromium, con `analyzeFile` real: 0/108 fotos nítidas avisadas; σ = 1,5: 0/41 (árbol) y 12/67 (Buda); σ = 2: 41/41 y 64/67. Análisis de 41 fotos de 12 MP en ~11 s, igual que antes.
- Efecto en COLMAP (PyCOLMAP 4.2.0, CPU, una cámara, 1 de cada 3 fotos desenfocada): todas las fotos se registran hasta σ = 3 en ambas escenas. Lo que cae es la aportación de cada foto desenfocada (puntos 3D observados, frente a la misma foto nítida): árbol 93 % (σ = 2) y 67 % (σ = 3); Buda 67 % (σ = 1), 33 % (σ = 1,5), 18 % (σ = 2) y 9 % (σ = 3). Puntos 3D totales del Buda: 24.589 → 16.418 (σ = 1,5) → 14.992 (σ = 2).
- Lectura: con capturas densas el desenfoque no impide colocar la cámara, pero en escenas poco texturadas (lo habitual en interiores) la foto apenas aporta a partir de σ ≈ 1,5. No medido: el efecto en la calidad del Gaussian Splatting (necesita GPU).
- Límites: dos escenas, ninguna de interior de vivienda; la métrica antigua se calibró con fotos de interior que no se han repetido con la nueva. Una superficie totalmente lisa no se puede juzgar y nunca se marca como movida. Revalidar con capturas reales de viviendas.
