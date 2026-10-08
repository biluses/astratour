"""Runpod Serverless entrypoint: one claim-and-process cycle per Runpod job.

The Runpod request carries no job data. main.py claims through the authenticated claim
endpoint, so an extra or duplicate run finds no job and exits cleanly.
"""
import os
import shutil
import signal
import subprocess
import sys
from pathlib import Path

WORKER_DIR = Path(os.environ.get('ASTRATOUR_WORKER_DIR', Path(__file__).resolve().parent))
# Must stay below the Runpod execution timeout (90 min) so cleanup runs before the hard kill.
CYCLE_SECONDS = int(os.environ.get('WORKER_CYCLE_SECONDS', 85 * 60))
GRACE_SECONDS = 60
# main.py must give up first: a clean PROCESS_TIMEOUT fails the tour at once, while a hard kill at the
# cycle limit leaves the lease to expire and the job to be retried (up to 3x) by the daily cron.
JOB_MARGIN_SECONDS = 5 * 60


def command():
    python = os.environ.get('WORKER_PYTHON', sys.executable)
    base = [python, str(WORKER_DIR / 'main.py'), '--once']
    xvfb = shutil.which('xvfb-run')
    return [xvfb, '-a', *base] if xvfb else base


def handler(job):
    del job  # Input is ignored by design; never trust job data from the Runpod request.
    env = dict(os.environ)
    env.setdefault('WORKER_ID', f"runpod-{os.environ.get('RUNPOD_POD_ID', 'serverless')}"[:100])
    env.setdefault('QT_QPA_PLATFORM', 'offscreen')
    env.setdefault('TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD', '1')
    job_limit = max(60, CYCLE_SECONDS - JOB_MARGIN_SECONDS)
    env['WORKER_JOB_TIMEOUT_SECONDS'] = str(min(int(env.get('WORKER_JOB_TIMEOUT_SECONDS') or job_limit), job_limit))
    # stdout/stderr go to Runpod logs; main.py never prints secrets. Nothing is returned from them.
    process = subprocess.Popen(command(), cwd=WORKER_DIR, env=env, start_new_session=True)
    try:
        code = process.wait(timeout=CYCLE_SECONDS)
    except subprocess.TimeoutExpired:
        # SIGTERM lets main.py unwind and stop COLMAP/CUDA children; the lease then expires server-side.
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        return {'status': 'timeout', 'exitCode': process.returncode}
    return {'status': 'ok' if code == 0 else 'failed', 'exitCode': code}


if __name__ == '__main__':
    import runpod  # Imported here so unit tests do not need the SDK.
    runpod.serverless.start({'handler': handler})
