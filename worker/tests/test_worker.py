"""CPU-only contract tests. These do NOT establish GPU reconstruction quality."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('worker_main', Path(__file__).resolve().parents[1] / 'main.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def job():
    identifiers = {key: str(uuid.uuid4()) for key in ('id', 'tourId', 'userId', 'token')}
    images = []
    for index in range(20):
        uid = str(uuid.uuid4())
        images.append({'id': uid, 'path': f"sources/{identifiers['userId']}/{identifiers['tourId']}/{uid}.jpg",
                       'name': '../../untrusted.jpg', 'contentType': 'image/jpeg', 'sizeBytes': 1234, 'ordinal': index})
    return {**identifiers, 'outputPrefix': f"generated/{identifiers['userId']}/{identifiers['tourId']}/{identifiers['token']}", 'images': images}


class WorkerContracts(unittest.TestCase):
    def test_valid_job_ignores_original_names_for_paths(self):
        value = job()
        self.assertIs(worker.validate_job(value), value)

    def test_rejects_path_traversal_and_cross_owner_sources(self):
        for value in ('../../secret', 'sources/other/image.jpg', 'https://attacker.invalid/payload'):
            value_job = job()
            value_job['images'][0]['path'] = value
            with self.assertRaises(ValueError):
                worker.validate_job(value_job)

    def test_rejects_fake_lease_identifiers(self):
        value = job()
        value['token'] = '../token'
        with self.assertRaises(ValueError):
            worker.validate_job(value)

    def test_rejects_output_from_another_lease(self):
        value = job()
        value['outputPrefix'] += '/extra'
        with self.assertRaises(ValueError):
            worker.validate_job(value)

    def test_rejects_too_few_photos(self):
        value = job()
        value['images'] = value['images'][:3]
        with self.assertRaises(worker.JobError):
            worker.validate_job(value)

    def test_rejects_oversized_image(self):
        value = job()
        value['images'][0]['sizeBytes'] = worker.MAX_FILE + 1
        with self.assertRaises(worker.JobError):
            worker.validate_job(value)

    def test_rejects_unsupported_mime(self):
        value = job()
        value['images'][0]['contentType'] = 'image/svg+xml'
        with self.assertRaises(worker.JobError):
            worker.validate_job(value)

    def test_rejects_duplicate_ids(self):
        value = job()
        value['images'][1] = value['images'][0].copy()
        with self.assertRaises(ValueError):
            worker.validate_job(value)

    def test_registration_quality_is_not_just_success_exit_code(self):
        with tempfile.TemporaryDirectory() as directory:
            dataset = Path(directory)
            (dataset / 'transforms.json').write_text(json.dumps({'frames': [{'file_path': f'images/{i}.jpg'} for i in range(20)]}))
            self.assertEqual(worker.capture_quality(dataset, 20, 20, 0.8), 20)
            with self.assertRaises(worker.JobError):
                worker.capture_quality(dataset, 100, 20, 0.8)

    def test_duplicate_registered_frames_do_not_inflate_quality(self):
        with tempfile.TemporaryDirectory() as directory:
            dataset = Path(directory)
            (dataset / 'transforms.json').write_text(json.dumps({'frames': [{'file_path': 'images/same.jpg'}] * 20}))
            with self.assertRaises(worker.JobError):
                worker.capture_quality(dataset, 20, 20, 0.8)

    def test_api_rejects_remote_http_and_embedded_credentials(self):
        for origin in ('http://api.example.com', 'https://user:pass@example.com', 'https://example.com/path'):
            with patch.dict(worker.os.environ, {'ASTRATOUR_API_URL': origin, 'RECONSTRUCTION_WORKER_SECRET': 'a' * 40}):
                with self.assertRaises(ValueError):
                    worker.API()

    def test_numeric_configuration_is_bounded(self):
        with patch.dict(worker.os.environ, {'WORKER_MAX_ITERATIONS': '-1'}):
            with self.assertRaises(ValueError):
                worker.bounded_int('WORKER_MAX_ITERATIONS', 30000, 1000, 100000)


if __name__ == '__main__':
    unittest.main()
