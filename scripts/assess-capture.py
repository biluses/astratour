"""Local-only CPU capture diagnostic. Not the production GPU worker.

Install pycolmap==4.2.0 and Pillow==12.1.0 in an isolated virtual environment.
Output includes private filenames/images: use an ignored, private directory.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import sqlite3
import time
import warnings

from PIL import Image, ImageOps
import pycolmap


def assess(source, output):
    output.mkdir(parents=True, exist_ok=False)
    output.chmod(0o700)
    images = output / 'images'
    images.mkdir(mode=0o700)
    Image.MAX_IMAGE_PIXELS = 40_000_000
    warnings.simplefilter('error', Image.DecompressionBombWarning)
    files = sorted(p for p in source.iterdir() if p.is_file() and p.suffix.lower() in ('.jpg', '.jpeg', '.png'))
    if not 2 <= len(files) <= 500:
        raise ValueError('Diagnostic supports 2–500 JPG/PNG images')
    records = []
    for index, path in enumerate(files):
        with Image.open(path) as original:
            image = ImageOps.exif_transpose(original).convert('RGB')
            image.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
            name = f'frame_{index + 1:05d}.jpg'
            image.save(images / name, 'JPEG', quality=95)
            records.append({'original': path.name, 'normalized': name, 'dimensions': list(image.size),
                            'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    (output / 'private-files.json').write_text(json.dumps(records, indent=2))
    started = time.monotonic()
    db = output / 'database.db'
    extraction = pycolmap.FeatureExtractionOptions()
    extraction.num_threads = 4
    extraction.max_image_size = 2048
    extraction.sift.max_num_features = 8192
    reader = pycolmap.ImageReaderOptions()
    reader.camera_model = 'SIMPLE_RADIAL'
    # Diagnostic accepts edited/rotated images with separate unknown intrinsics.
    # This deliberately differs from the stricter single-camera production worker.
    pycolmap.extract_features(db, images, camera_mode=pycolmap.CameraMode.PER_IMAGE,
                              reader_options=reader, extraction_options=extraction, device=pycolmap.Device.cpu)
    matching = pycolmap.FeatureMatchingOptions()
    matching.num_threads = 4
    pycolmap.match_exhaustive(db, matching_options=matching, device=pycolmap.Device.cpu)
    options = pycolmap.IncrementalPipelineOptions()
    options.num_threads = 4
    options.mapper.num_threads = 4
    options.max_runtime_seconds = 300
    options.min_model_size = 3
    options.max_num_models = 10
    options.random_seed = 0
    models = pycolmap.incremental_mapping(db, images, output / 'sparse', options=options)
    components = []
    for key, model in models.items():
        ids = model.reg_image_ids()
        components.append({'model': key, 'registeredImages': model.num_reg_images(),
                           'points3D': model.num_points3D(),
                           'meanReprojectionError': model.compute_mean_reprojection_error(),
                           'images': [model.images[i].name for i in ids]})
    connection = sqlite3.connect(db)
    verified_pairs = connection.execute('SELECT COUNT(*) FROM two_view_geometries WHERE rows >= 15 AND config > 0').fetchone()[0]
    connection.close()
    dimensions = Counter(f"{r['dimensions'][0]}x{r['dimensions'][1]}" for r in records)
    largest = max((m['registeredImages'] for m in components), default=0)
    report = {'tool': f'PyCOLMAP {pycolmap.__version__} CPU diagnostic (not production GPU)',
              'inputImages': len(files), 'normalizedDimensions': dict(dimensions),
              'exactDuplicateCount': len(records) - len({r['sha256'] for r in records}),
              'verifiedImagePairs': verified_pairs, 'models': components,
              'largestConnectedReconstruction': largest, 'largestFraction': largest / len(files),
              'productionSingleCameraCompatible': len(dimensions) == 1,
              'meetsDefaultRegistrationGate': largest >= 20 and largest / len(files) >= 0.8,
              'elapsedSeconds': round(time.monotonic() - started, 2),
              'trainedGaussianModel': False}
    (output / 'report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps({k:v for k,v in report.items() if k != 'models'}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path, help='New private directory; never place in tracked public assets')
    args = parser.parse_args()
    assess(args.source.resolve(), args.output.resolve())
