"""A fresh managed-Jev process must honor the shared capture boundary."""
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jev_runner import Journal, capture


class RecoveryBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.run_id = 'r_' + 'a' * 32
        self.directory = Path(self.temp.name) / 'runs' / self.run_id
        self.directory.mkdir(parents=True)
        self.task = {
            'steps': [{'kind': 'fill', 'selector': '#token', 'valueFromEnv': 'SYNTHETIC_INPUT'}],
            'recovery': {'fields': [{'key': 'public', 'selector': '#public'}]},
        }
        self.write_meta()
        (self.directory / 'events.jsonl').write_text('')
        self.journal = Journal(self.temp.name, self.run_id)
        self.page = Mock()
        self.page.evaluate.return_value = {'value': 'public', 'matches': False}

    def write_meta(self):
        (self.directory / 'task.json').write_text(json.dumps({
            'version': 2, 'expiresAt': time.time() * 1000 + 60_000, 'task': self.task,
        }))

    def test_suspension_survives_new_journal_and_skips_model_generated_intents(self):
        self.journal.append('recovery.capture_suspended', reason='environment boundary')
        fresh = Journal(self.temp.name, self.run_id)
        capture(self.page, fresh)
        capture(self.page, fresh, {'kind': 'fill', 'node': 1}, 'model-generated')
        self.page.evaluate.assert_not_called()
        self.assertFalse((self.directory / 'recovery.json').exists())

    def test_legacy_playwright_receipt_is_not_assumed_public(self):
        self.journal.append('action.start', engine='playwright', id='old')
        capture(self.page, self.journal)
        capture(self.page, Journal(self.temp.name, self.run_id))
        self.page.evaluate.assert_not_called()
        self.assertEqual(sum(e['type'] == 'recovery.capture_suspended' for e in self.journal.events()), 1)

    def test_guarded_public_dispatch_does_not_disable_capture(self):
        self.journal.append('action.start', engine='playwright', id='public', recoveryGuarded=True)
        capture(self.page, self.journal)
        self.page.evaluate.assert_called_once()
        self.assertEqual(json.loads((self.directory / 'recovery.json').read_text())['public']['value'], 'public')

    def test_legacy_run_without_environment_steps_still_captures(self):
        self.task['steps'] = [{'kind': 'click', 'selector': '#open'}]
        self.write_meta()
        self.journal.append('action.start', engine='playwright', id='old-public')
        capture(self.page, Journal(self.temp.name, self.run_id))
        self.page.evaluate.assert_called_once()


if __name__ == '__main__':
    unittest.main()
