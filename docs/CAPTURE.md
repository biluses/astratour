# Captura y diagnóstico previo a GPU

## Captura aceptada por este piloto

- Una estancia o recorrido conectado, no una selección de fotografías comerciales de zonas independientes.
- Misma cámara/lente, resolución y orientación. Sin recortes ni versiones retocadas del mismo encuadre.
- JPG o PNG, 40–500 imágenes (bloqueante por debajo de 40; recomendadas 60–80 por estancia), 10 MiB por archivo, 2 GiB por captura. El mínimo es un control operativo, no una promesa de calidad.
- Girar como máximo unos 20° entre fotos consecutivas (≈ un tercio del encuadre, ~70 % de solapamiento) y que cada zona aparezca en al menos 3 fotos. Recorrer el perímetro mirando hacia dentro y cubrir alrededor del centro mirando hacia fuera, a dos alturas, desplazándose ~0,5 m entre posiciones; no girar sobre un punto fijo (sin paralaje).
- Guía para usuarios: `/guia-captura`.

## Comprobaciones en el navegador antes de subir

`src/lib/capture-checks.ts` analiza cada foto (orientación EXIF aplicada, copia reducida a 512 px de lado largo):

- **Bloquean:** más de un tamaño/orientación en la captura (el worker asume una sola cámara), lado corto < 720 px, archivos duplicados (SHA-256).
- **Avisan:** fotos que el navegador no puede analizar, lado corto < 1080 px, varianza del laplaciano < 60 (posible desenfoque; calibrado, ver Evidencia), luminancia media < 40/255 (una foto oscura no se marca además como desenfocada), menos de 60 fotos (recomendado).
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
- Desenfoque: varianza del laplaciano a 512 px de lado largo. En 52 fotos reales nítidas, percentil 5 = 88; con desenfoque gaussiano de 1 px, percentil 95 = 47. Umbral de aviso: 60 (solo aviso: paredes lisas pueden puntuar bajo).
- No verificado empíricamente: la regla de no girar sobre uno mismo sin desplazarse se basa en la geometría (sin paralaje no hay triangulación), no en este benchmark.
- Límite: capturas de cámara réflex con tomas espaciadas; deben revalidarse con capturas reales de móvil de viviendas.
