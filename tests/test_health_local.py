import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from health_local import HealthStore, HealthError


def sample(kind, value, start='2026-11-22 22:00:00 +1100', end='2026-11-23 06:00:00 +1100', source='Apple Watch', unit=''):
    return '<Record type="%s" value="%s" startDate="%s" endDate="%s" sourceName="%s" unit="%s"/>' % (kind, value, start, end, source, unit)


class HealthTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = HealthStore(self.root / 'private' / 'health.sqlite3')

    def tearDown(self):
        self.tmp.cleanup()

    def xml(self, body):
        path = self.root / 'export.xml'
        path.write_text('<HealthData>' + body + '</HealthData>')
        return path

    def test_reimport_is_idempotent_and_sleep_overlaps_are_not_double_counted(self):
        body = sample('HKCategoryTypeIdentifierSleepAnalysis', 'HKCategoryValueSleepAnalysisAsleepCore')
        body += sample('HKCategoryTypeIdentifierSleepAnalysis', 'HKCategoryValueSleepAnalysisAsleepREM', '2026-11-23 04:00:00 +1100')
        path = self.xml(body)
        self.assertEqual(self.store.import_file(path)['added'], 2)
        self.assertEqual(self.store.import_file(path)['added'], 0)
        result = self.store.summary(today='2026-11-23')
        day = next(d for d in result['days'] if d['date'] == '2026-11-23')
        self.assertEqual(day['sleep_hours'], 8)
        self.assertNotIn('hrv_sdnn_ms', day)
        self.assertTrue(result['local_only'])

    def test_zip_native_export_and_source_priority_do_not_add_phone_and_watch_steps(self):
        xml = self.xml(sample('HKQuantityTypeIdentifierStepCount', 1000, unit='count') + sample('HKQuantityTypeIdentifierStepCount', 900, source='iPhone', unit='count'))
        archive = self.root / 'apple.zip'
        with zipfile.ZipFile(archive, 'w') as z:
            z.write(xml, 'apple_health_export/export.xml')
        self.store.import_file(archive)
        days = self.store.summary(today='2026-11-23')['days']
        self.assertEqual(next(d for d in days if d['date'] == '2026-11-22')['steps'], 1000)

    def test_bad_import_rolls_back_and_does_not_overwrite_prior_data(self):
        self.store.import_file(self.xml(sample('HKQuantityTypeIdentifierHeartRateVariabilitySDNN', 35, unit='ms')))
        bad = self.root / 'bad.xml'
        bad.write_text('<HealthData>' + sample('HKQuantityTypeIdentifierStepCount', 22) + '<broken>')
        with self.assertRaises(HealthError):
            self.store.import_file(bad)
        self.assertEqual(self.store.summary(today='2026-11-23')['total_records'], 1)

    def test_entity_declaration_is_rejected(self):
        path = self.root / 'bad.xml'
        path.write_text('<!DOCTYPE a [<!ENTITY x "boom">]><HealthData>&x;</HealthData>')
        with self.assertRaises(HealthError):
            self.store.import_file(path)

    def test_native_structural_doctype_is_allowed_but_external_dtd_is_rejected(self):
        path = self.root / 'native.xml'
        path.write_text('<!DOCTYPE HealthData [<!ELEMENT HealthData (Record*)><!ELEMENT Record EMPTY>]><HealthData>' + sample('HKQuantityTypeIdentifierStepCount', 15, unit='count') + '</HealthData>')
        self.assertEqual(self.store.import_file(path)['added'], 1)
        path.write_text('<!DOCTYPE HealthData SYSTEM "file:///etc/passwd"><HealthData/>')
        with self.assertRaises(HealthError):
            self.store.import_file(path)

    def test_checkins_stay_private_and_insufficient_data_has_no_causal_claim(self):
        self.store.checkin('2026-11-23', 3, 4, 'exam week')
        result = self.store.summary(today='2026-11-23')
        self.assertEqual(result['checkins'][0]['stress'], 4)
        self.assertFalse(any(i['kind'] == 'association' for i in result['insights']))
        self.assertNotIn('health.sqlite3', json.dumps(result))
        with self.assertRaises(HealthError):
            self.store.checkin('2026-11-23', 9, 4)

    def test_inbed_is_not_asleep_and_units_are_normalized(self):
        path = self.xml(sample('HKCategoryTypeIdentifierSleepAnalysis', 'HKCategoryValueSleepAnalysisInBed') + sample('HKQuantityTypeIdentifierHeartRateVariabilitySDNN', .035, unit='s'))
        self.store.import_file(path)
        days = self.store.summary(today='2026-11-23')['days']
        self.assertFalse(any('sleep_hours' in d for d in days))
        self.assertEqual(next(d for d in days if 'hrv_sdnn_ms' in d)['hrv_sdnn_ms'], 35)


if __name__ == '__main__':
    unittest.main()
