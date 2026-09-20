# Captura y diagnóstico previo a GPU

## Captura aceptada por este piloto

- Una estancia o recorrido conectado, no una selección de fotografías comerciales de zonas independientes.
- Misma cámara/lente, resolución y orientación. Sin recortes ni versiones retocadas del mismo encuadre.
- JPG o PNG, 20–500 imágenes, 10 MiB por archivo, 2 GiB por captura. El mínimo es un control operativo, no una promesa de calidad.
- Mantener aproximadamente 70–80 % de solapamiento y desplazarse entre tomas. Cubrir paredes, esquinas y pasos entre espacios con fotografías intermedias.
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

El worker exige por defecto al menos 20 cámaras registradas y el 80 % de las imágenes en una reconstrucción. Entrenar una representación visual sobre un registro insuficiente no recupera zonas nunca observadas.

Si el diagnóstico falla, preparar una captura continua antes de contratar GPU. No sustituir el resultado por un slideshow o una escena inventada y etiquetarlo como reconstrucción real.
