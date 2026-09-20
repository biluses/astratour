"""Durable GPU worker. No reconstruction is performed by Vercel or by mocks.

Only this worker's own dataset and training configuration reach Nerfstudio.
All subprocess arguments are arrays, and credentials are never logged.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request
import uuid
import zipfile

ROOT = Path(__file__).resolve().parent
MAX_FILE = 10 * 1024**2
MAX_TOTAL = 2 * 1024**3


class JobError(Exception):
    def __init__(self, code, retryable=False):
        super().__init__(code)
        self.code, self.retryable = code, retryable


def bounded_int(name, default, minimum, maximum):
    value = int(os.environ.get(name, default))
    if not minimum <= value <= maximum:
        raise ValueError(f"Invalid {name}")
    return value


def validate_job(job, minimum=20):
    for key in ('id', 'tourId', 'userId', 'token'):
        if str(uuid.UUID(job[key])) != job[key]:
            raise ValueError('Invalid job identifier')
    prefix = f"generated/{job['userId']}/{job['tourId']}/{job['token']}"
    if job['outputPrefix'] != prefix:
        raise ValueError('Invalid output prefix')
    images = job['images']
    if not minimum <= len(images) <= 500:
        raise JobError('CAPTURE_COUNT_INVALID')
    seen = set()
    total = 0
    for ordinal, image in enumerate(images):
        uid = str(uuid.UUID(image['id']))
        if uid != image['id'] or uid in seen or image['ordinal'] != ordinal:
            raise ValueError('Invalid image identifier/order')
        seen.add(uid)
        mime = image['contentType']
        if mime not in ('image/jpeg', 'image/png'):
            raise JobError('IMAGE_TYPE_INVALID')
        extension = 'png' if mime == 'image/png' else 'jpg'
        if image['path'] != f"sources/{job['userId']}/{job['tourId']}/{uid}.{extension}":
            raise ValueError('Invalid private source path')
        size = image['sizeBytes']
        if isinstance(size, bool) or not isinstance(size, int) or not 0 < size <= MAX_FILE:
            raise JobError('IMAGE_SIZE_INVALID')
        total += size
    if total > MAX_TOTAL:
        raise JobError('CAPTURE_SIZE_INVALID')
    return job


class API:
    def __init__(self):
        self.origin = os.environ['ASTRATOUR_API_URL'].rstrip('/')
        parsed = urlparse(self.origin)
        if parsed.path or parsed.query or parsed.fragment or parsed.username or parsed.password:
            raise ValueError('ASTRATOUR_API_URL must be an origin')
        if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1')):
            raise ValueError('ASTRATOUR_API_URL must use HTTPS')
        self.secret = os.environ['RECONSTRUCTION_WORKER_SECRET']
        if len(self.secret) < 32:
            raise ValueError('Worker secret must contain at least 32 characters')

    def post(self, endpoint, payload):
        headers = {'Authorization': f'Bearer {self.secret}', 'Content-Type': 'application/json'}
        bypass = os.getenv('VERCEL_AUTOMATION_BYPASS_SECRET')
        if bypass:
            headers['x-vercel-protection-bypass'] = bypass
        req = Request(f'{self.origin}/api/internal/reconstruction/{endpoint}',
                      data=json.dumps(payload).encode(), headers=headers, method='POST')
        try:
            # Never follow redirects with an Authorization header to another host.
            from urllib.request import HTTPRedirectHandler, build_opener
            class NoRedirect(HTTPRedirectHandler):
                def redirect_request(self, *args):
                    return None
            with build_opener(NoRedirect).open(req, timeout=30) as response:
                return json.loads(response.read(512 * 1024))
        except HTTPError as error:
            if error.code == 409:
                raise JobError('LEASE_LOST') from None
            raise JobError('API_UNAVAILABLE', error.code >= 500 or error.code == 429) from None
        except (URLError, TimeoutError, json.JSONDecodeError):
            raise JobError('API_UNAVAILABLE', True) from None


class Lease:
    def __init__(self, api, job):
        self.api, self.job = api, job
        self.progress, self.stage = 0, 'download'
        self.stopped = threading.Event()
        self.lost = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.last_success = time.monotonic()

    def set(self, progress, stage):
        self.progress, self.stage = progress, stage
        self.pulse()

    def pulse(self):
        self.api.post(f"{self.job['id']}/heartbeat", {
            'token': self.job['token'], 'progress': self.progress, 'stage': self.stage,
        })
        self.last_success = time.monotonic()

    def run(self):
        while not self.stopped.wait(45):
            try:
                self.pulse()
            except JobError as error:
                if not error.retryable or time.monotonic() - self.last_success > 180:
                    self.lost.set()
                    return

    def check(self):
        if self.lost.is_set():
            raise JobError('LEASE_LOST')

    def close(self):
        self.stopped.set()
        self.thread.join(timeout=35)


def run_command(arguments, timeout, lease, work, deadline, max_disk):
    """Kill the entire subprocess group on a timeout, expired lease or disk bound."""
    # Child applications do not need the API or Blob credentials (only bridge does).
    environment = dict(os.environ)
    if Path(str(arguments[1]) if len(arguments) > 1 else '').name != 'bridge.mjs':
        for key in ('RECONSTRUCTION_WORKER_SECRET', 'BLOB_READ_WRITE_TOKEN', 'VERCEL_AUTOMATION_BYPASS_SECRET'):
            environment.pop(key, None)
    log = work / 'private-process.log'
    with log.open('ab') as output:
        process = subprocess.Popen([str(value) for value in arguments], cwd=ROOT,
                                   stdout=output, stderr=subprocess.STDOUT, env=environment, start_new_session=True)
        started = time.monotonic()
        next_disk_check = started
        try:
            while process.poll() is None:
                lease.check()
                now = time.monotonic()
                if now > deadline or now - started > timeout:
                    raise JobError('PROCESS_TIMEOUT')
                if now >= next_disk_check:
                    total = sum(p.stat().st_size for p in work.rglob('*') if p.is_file())
                    if total > max_disk or shutil.disk_usage(work).free < 2 * 1024**3:
                        raise JobError('DISK_LIMIT')
                    next_disk_check = now + 15
                time.sleep(1)
            if process.returncode:
                raise JobError('PROCESS_FAILED')
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
    lease.check()


def write_json(path, content):
    with path.open('x', encoding='utf8') as handle:
        json.dump(content, handle)
    path.chmod(0o600)


def capture_quality(dataset, expected, minimum, ratio):
    frames = json.loads((dataset / 'transforms.json').read_text())['frames']
    names = {Path(frame['file_path']).name for frame in frames}
    if len(names) < minimum or len(names) / expected < ratio:
        raise JobError('INSUFFICIENT_CAMERA_REGISTRATION')
    return len(names)


def execute_job(api, job):
    minimum = bounded_int('WORKER_MIN_IMAGES', 20, 3, 500)
    validate_job(job, minimum)
    workspace = Path(os.environ.get('WORKER_WORK_DIR', '/work')).resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    max_disk = bounded_int('WORKER_MAX_DISK_GIB', 40, 10, 500) * 1024**3
    if shutil.disk_usage(workspace).free < max_disk:
        raise JobError('INSUFFICIENT_DISK', True)
    lease = Lease(api, job)
    lease.pulse()
    lease.thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix=f"job-{job['id']}-", dir=workspace) as temp:
            work = Path(temp)
            deadline = time.monotonic() + bounded_int('WORKER_JOB_TIMEOUT_SECONDS', 14400, 60, 14400)
            def run(args, timeout=1800):
                run_command(args, timeout, lease, work, deadline, max_disk)
            raw, normalized, dataset, trained, exported, delivery = [work / name for name in ('raw', 'normalized', 'dataset', 'trained', 'exported', 'delivery')]
            for folder in (raw, normalized, delivery):
                folder.mkdir()
            records = [{**image, 'localPath': str(raw / f"{image['id']}.input"),
                        'normalizedPath': str(normalized / f"{image['id']}.jpg"),
                        'frameName': f"{image['id']}.jpg"} for image in job['images']]
            # ns-process-data 1.1.5 copies sorted input names to frame_00001.jpg, etc.
            for index, record in enumerate(sorted(records, key=lambda item: item['normalizedPath'])):
                record['frameName'] = f'frame_{index + 1:05d}.jpg'
            manifest = work / 'input.json'
            write_json(manifest, {'files': records})
            run(['node', ROOT / 'bridge.mjs', 'download', manifest])
            lease.set(5, 'validation')
            run([sys.executable, ROOT / 'images.py', manifest], 600)
            lease.set(10, 'colmap')
            run(['ns-process-data', 'images', '--data', normalized, '--output-dir', dataset,
                 '--matching-method', 'exhaustive', '--sfm-tool', 'colmap', '--num-downscales', '2'],
                bounded_int('WORKER_COLMAP_TIMEOUT_SECONDS', 3600, 60, 7200))
            ratio = float(os.environ.get('WORKER_MIN_REGISTERED_RATIO', '0.8'))
            if not 0.5 <= ratio <= 1:
                raise JobError('WORKER_CONFIGURATION_INVALID')
            registered = capture_quality(dataset, len(records), minimum, ratio)
            lease.set(30, 'training')
            iterations = bounded_int('WORKER_MAX_ITERATIONS', 30000, 1000, 100000)
            run(['ns-train', 'splatfacto', '--data', dataset, '--output-dir', trained,
                 '--experiment-name', 'astratour', '--timestamp', 'run', '--vis', 'tensorboard',
                 '--max-num-iterations', str(iterations), '--pipeline.datamanager.cache-images', 'cpu', '--pipeline.datamanager.cache-images-type', 'uint8'],
                bounded_int('WORKER_TRAIN_TIMEOUT_SECONDS', 7200, 60, 10800))
            configs = list(trained.rglob('config.yml'))
            if len(configs) != 1:
                raise JobError('TRAINING_OUTPUT_INVALID')
            lease.set(75, 'export')
            run(['ns-export', 'gaussian-splat', '--load-config', configs[0], '--output-dir', exported],
                bounded_int('WORKER_EXPORT_TIMEOUT_SECONDS', 1800, 60, 3600))
            ply = exported / 'splat.ply'
            if not ply.is_file() or ply.stat().st_size < 256:
                raise JobError('MODEL_OUTPUT_INVALID')
            lease.set(80, 'rendering')
            renders = work / 'renders'
            run([sys.executable, ROOT / 'render_previews.py', configs[0], manifest, renders,
                 str(bounded_int('WORKER_PREVIEW_COUNT', 8, 1, 12))])
            previews = json.loads((renders / 'manifest.json').read_text())
            lease.set(87, 'packaging')
            transform = ROOT / 'node_modules' / '.bin' / 'splat-transform'
            model = delivery / 'scene.sog'
            # Nerfstudio PLY exports z-up. Rotate BOTH scene and camera Rx(-90).
            # CPU SOG encoding avoids relying on a second WebGPU driver stack on CUDA servers.
            run([transform, '--gpu', 'cpu', ply, '--filter-nan', '--rotate', '-90,0,0', model])
            settings_manifest = work / 'settings-manifest.json'
            settings = work / 'viewer-settings.json'
            write_json(settings_manifest, {'camera': previews['camera'], 'output': str(settings)})
            run(['node', ROOT / 'bridge.mjs', 'settings', settings_manifest])
            run([transform, '--gpu', 'cpu', '--viewer-settings', settings, model, delivery / 'index.html'])
            write_json(delivery / 'manifest.json', {'version': 1, 'is3D': True,
                'engine': 'Nerfstudio 1.1.5 / Splatfacto', 'viewer': 'SuperSplat 1.31.2',
                'inputImages': len(records), 'registeredImages': registered, 'iterations': iterations,
                'measurementAccuracy': 'not validated', 'camera': previews['camera']})
            (delivery / 'README.txt').write_text('AstraTour Express\nAbre index.html en un navegador moderno con aceleracion grafica.\nEl HTML incluye el modelo y no necesita conexion. scene.sog puede importarse en SuperSplat.\nGaussian Splatting es una representacion visual: no es una malla ni una medicion certificada.\n')
            licenses = delivery / 'licenses'
            licenses.mkdir()
            for package in ('supersplat-viewer', 'splat-transform'):
                shutil.copyfile(ROOT / 'node_modules' / '@playcanvas' / package / 'LICENSE', licenses / f'{package}.txt')
            archive = work / 'astratour-pack.zip'
            with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_STORED) as bundle:
                for file in sorted(delivery.rglob('*')):
                    if file.is_file():
                        bundle.write(file, file.relative_to(delivery))
            prefix = job['outputPrefix']
            output_files = [
                {'localPath': str(model), 'path': f'{prefix}/scene.sog', 'contentType': 'application/octet-stream', 'maxBytes': MAX_TOTAL},
                {'localPath': str(archive), 'path': f'{prefix}/astratour-pack.zip', 'contentType': 'application/zip', 'maxBytes': MAX_TOTAL},
            ]
            result_previews = []
            for preview in previews['previews']:
                image_id = preview['imageId']
                if image_id not in {image['id'] for image in job['images']}:
                    raise JobError('PREVIEW_OUTPUT_INVALID')
                path = f'{prefix}/previews/{image_id}.jpg'
                output_files.append({'localPath': str(renders / f'{image_id}.jpg'), 'path': path,
                                     'contentType': 'image/jpeg', 'maxBytes': 5 * 1024**2})
                result_previews.append({'imageId': image_id, 'path': path})
            output_manifest = work / 'output.json'
            write_json(output_manifest, {'files': output_files})
            lease.set(95, 'uploading')
            run(['node', ROOT / 'bridge.mjs', 'upload', output_manifest])
            payload = {'token': job['token'], 'modelPath': f'{prefix}/scene.sog', 'archivePath': f'{prefix}/astratour-pack.zip',
                       'camera': previews['camera'], 'previews': result_previews}
            for attempt in range(3):
                try:
                    api.post(f"{job['id']}/complete", payload)
                    break
                except JobError as error:
                    if not error.retryable or attempt == 2:
                        raise
                    time.sleep(5)
    finally:
        lease.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--once', action='store_true', help='Claim at most one job, then exit')
    args = parser.parse_args()
    api = API()
    if not os.getenv('BLOB_READ_WRITE_TOKEN'):
        raise ValueError('BLOB_READ_WRITE_TOKEN is required')
    worker_id = os.environ.get('WORKER_ID', 'gpu-01')
    if not 1 <= len(worker_id) <= 100:
        raise ValueError('Invalid WORKER_ID')
    poll = bounded_int('WORKER_POLL_SECONDS', 15, 5, 300)
    while True:
        job = None
        try:
            job = api.post('claim', {'workerId': worker_id})['job']
            if job:
                execute_job(api, job)
                print('Reconstruction completed.', flush=True)
        except Exception as error:
            code = error.code if isinstance(error, JobError) else 'WORKER_FAILED'
            retryable = isinstance(error, JobError) and error.retryable
            # Never include subprocess stderr, source names, URLs or credentials.
            print(f'Worker status: {code}', file=sys.stderr, flush=True)
            if job and code != 'LEASE_LOST':
                try:
                    api.post(f"{job['id']}/fail", {'token': job['token'], 'code': code,
                             'message': code, 'retryable': retryable})
                except Exception:
                    pass  # Expired lease will be recovered server-side; never publish without ownership.
            if args.once:
                return 1
        if args.once:
            return 0
        time.sleep(poll)


if __name__ == '__main__':
    # Unwind finally blocks so SIGTERM stops CUDA/COLMAP process groups and removes local captures.
    def stop(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
