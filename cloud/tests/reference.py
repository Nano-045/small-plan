"""Make a disposable canonical fixture; never opens the user's planner."""
import json
from pathlib import Path
import sys
import tempfile
import uuid
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from planner_store import Store
from life_store import LifeStore, today
from life_exports import ics_export, markdown_export

with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / 'test.db'
    legacy = Store(path).get_state()
    store = LifeStore(path)
    task_id = str(uuid.uuid4())
    def cmd(kind, **payload):
        return store.command(kind, payload, str(uuid.uuid4()))
    cmd('task.upsert', id=task_id, local_date=today(), title='Write brief')
    cmd('block.upsert', task_id=task_id, local_date=today(), start_local='13:17', end_local='13:41')
    print(json.dumps(dict(v1=legacy, v2=store.export_backup(), projection=store.get_state(today(),today()),
                          ics=ics_export(store.get_state()), markdown=markdown_export(store.get_state(today(), today()), today(), 'day'),
                          overview=store.overview(today(),today()), plan=store.suggest_plan(today()), date=today())))
