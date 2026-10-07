import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location('serverless_handler', Path(__file__).resolve().parents[1] / 'serverless_handler.py')
handler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handler)


class ServerlessHandler(unittest.TestCase):
    def run_with(self, wait):
        process = MagicMock(pid=4242, returncode=-15)
        process.wait.side_effect = wait
        with patch.object(handler.subprocess, 'Popen', return_value=process) as popen, \
             patch.object(handler.os, 'killpg') as killpg:
            result = handler.handler({'id': 'j', 'input': {'tourId': '../../evil', 'token': 'x'}})
        return result, popen, killpg

    def test_runs_one_cycle_and_returns_only_status(self):
        result, popen, _ = self.run_with([0])
        self.assertEqual(result, {'status': 'ok', 'exitCode': 0})
        args = popen.call_args.args[0]
        self.assertEqual(args[-2:], [str(handler.WORKER_DIR / 'main.py'), '--once'])
        self.assertNotIn('../../evil', ' '.join(args))
        self.assertTrue(popen.call_args.kwargs['start_new_session'])

    def test_failure_exit_code(self):
        result, _, _ = self.run_with([1])
        self.assertEqual(result, {'status': 'failed', 'exitCode': 1})

    def test_timeout_terminates_process_group(self):
        result, _, killpg = self.run_with([subprocess.TimeoutExpired('x', 1), -15])
        killpg.assert_called_once_with(4242, handler.signal.SIGTERM)
        self.assertEqual(result, {'status': 'timeout', 'exitCode': -15})


if __name__ == '__main__':
    unittest.main()
