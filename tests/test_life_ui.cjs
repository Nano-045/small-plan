const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const D = fs.existsSync('./static/life-domain.js') ? require('../static/life-domain.js') : {};
test('Monday week crosses year boundary', () => assert.deepEqual(D.week('2027-01-01'), ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']));
test('group dots keep skipped in denominator and empty days unknown', () => {
    const rows = ['done', 'skipped'].map(status => ({ status, local_date: '2026-11-23', category_id: null }));
    assert.equal(D.dot(rows, '2026-11-23', null), 'partial');
    assert.equal(D.dot(rows, '2026-11-24', null), 'na');
});
test('last grid quarter can cross into following day', () => assert.deepEqual(D.slot('2026-11-23', 1439, 30), { local_date: '2026-11-23', start_local: '23:45', end_date: '2026-11-24', end_local: '00:15' }));
test('DST days preserve elapsed minutes and repeated hour', () => {
    assert.equal((D.midnight('2026-10-05') - D.midnight('2026-10-04')) / 60000, 1380);
    assert.equal((D.midnight('2026-04-06') - D.midnight('2026-04-05')) / 60000, 1500);
});
test('segment clips to local day and excludes unresolved reviews', () => {
    const r = { status: 'stopped', category_id: 'a', segments: [{ start: '2026-11-23T12:55:00Z', end: '2026-11-23T13:08:00Z' }] };
    assert.equal(D.actual([r], '2026-11-24')[0].minutes, 8);
    assert.deepEqual(D.actual([{ ...r, status: 'needs_review' }], '2026-11-24'), []);
});
test('offline timer projects four transitions using original timestamps without changing saved sessions', () => {
    const op = (type, time, payload = { id: 's' }) => ({ type: 'session.' + type, payload, effective_at: '2026-11-23T' + time + ':00Z' });
    const queued = [op('start', '10:00', { id: 's', task_id: 't' }), op('pause', '10:05'), op('resume', '10:20'), op('stop', '10:26')];
    const sessions = [], projected = D.projectTimer(sessions, queued, p => ({ title: 'Study', category_id: 'work' }));
    assert.equal(projected[0].status, 'stopped');
    assert.equal(projected[0].title, 'Study');
    assert.equal(projected[0].segments.length, 2);
    assert.equal(projected[0].segments[0].end, queued[1].effective_at);
    assert.equal(sessions.length, 0);
});
const vm = require('node:vm');
function dashboardHarness(routes = {}, statuses = {}, initialStorage = {}) {
    const listeners = {}, storage = new Map(Object.entries(initialStorage)), elements = {}, requests = [], errors = [];
    const makeElement = () => ({
        innerHTML: '', dataset: {}, open: false, classList: { add() {
            }, remove() {
            } }, contains() {
            return false;
        }, querySelector() {
            return null;
        }, querySelectorAll() {
            return [];
        }, addEventListener(type, fn) {
            listeners['modal:' + type] = fn;
        }, showModal() {
            this.open = true;
        }, close() {
            this.open = false;
        }
    });
    for (const id of ['#app', '#modal', '#toast'])
        elements[id] = makeElement();
    const now = D.wall(Date.now()).slice(0, 10);
    const saved = {
        revision: 0, tasks: [{ id: 't', title: 'Practice', local_date: now, status: 'todo', category_id: null }], categories: [], routines: [], occurrences: [], daily_notes: [], assessments: [], courses: [], external_items: [], external_events: [], sessions: [], time_blocks: []
    };
    const flags = { offline: false };
    const context = {
        console, Intl, Date, URL, FormData, crypto: require('node:crypto').webcrypto, fetch: async (path, opts) => {
            requests.push({ path, body: opts.body && JSON.parse(opts.body) });
            if (flags.offline)
                throw new TypeError('offline');
            const data = routes[path] ?? (path.startsWith('/api/v2/state') ? saved : path.includes('/api/health') ? { metrics: [], insights: [] } : path.includes('/calendar/status') ? { status: 'pending' } : {});
            const status=statuses[path] || 200;
            return { status,ok:status<400,json:async()=>structuredClone(data) };
        }, localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) }, setInterval() {
        }, setTimeout() {
        }, clearTimeout() {
        },
        document: { querySelector: q => elements[q] || null, addEventListener: (k, f) => listeners[k] = f }, window: { addEventListener: (k, f) => listeners['window:' + k] = f }
    };
    vm.createContext(context);
    for (const file of ['life-domain', 'life'])
        vm.runInContext(fs.readFileSync('static/' + file + '.js', 'utf8'), context);
    async function click(action, id = '') {
        const target = { dataset: { do: action, id }, closest: q => q === '[data-do]' ? target : null, setAttribute() {
            }, removeAttribute() {
            } };
        await listeners.click({ target, detail: 1, preventDefault() {
            } });
    }
    return { saved, elements, requests, context, listeners, errors, click, flags, storage, online:()=>listeners['window:online'](), settle: () => new Promise(r => setImmediate(r)) };
}
test('every page renders real empty states and all mobile tabs are reachable', async () => {
    const h = dashboardHarness();
    await h.settle();
    assert.match(h.elements['#app'].innerHTML, /Practice/);
    for (const page of ['overview', 'study', 'career', 'radar', 'insights', 'settings', 'planner']) {
        await h.click('nav', page);
        assert.match(h.elements['#app'].innerHTML, /<main id="main">/);
        assert.doesNotMatch(h.elements['#app'].innerHTML, /class="banner"/);
    }
    for (const tab of ['routines', 'calendar', 'today']) {
        await h.click('mobile', tab);
        assert.match(h.elements['#app'].innerHTML, new RegExp('data-tab="' + tab + '"'));
    }
});
test('offline start and pause retain operation UUIDs and original effective times', async () => {
    const h = dashboardHarness();
    await h.settle();
    h.flags.offline = true;
    await h.click('start-task', 't');
    let queue = JSON.parse([...h.storage.values()][0]);
    assert.equal(queue[0].type, 'session.start');
    assert.match(h.elements['#app'].innerHTML, /data-do="pause"/);
    await h.click('pause', queue[0].payload.id);
    queue = JSON.parse([...h.storage.values()][0]);
    assert.equal(queue.length, 2);
    assert.equal(queue[1].type, 'session.pause');
    assert.notEqual(queue[0].operation_id, queue[1].operation_id);
    assert.ok(Date.parse(queue[1].effective_at) >= Date.parse(queue[0].effective_at));
    assert.match(h.elements['#app'].innerHTML, /data-do="resume"/);
});
test('ordered timer operations at the same timestamp may resume after pause', () => {
    const t = '2026-11-23T10:00:00Z', ops = ['start', 'pause', 'resume'].map(action => ({ type: 'session.' + action, payload: { id: 's' }, effective_at: t }));
    const [s] = D.projectTimer([], ops, () => ({}));
    assert.equal(s.status, 'running');
    assert.equal(s.segments.length, 2);
});
test('form errors keep the user draft available and offer an explicit revision refresh', async () => {
    const h = dashboardHarness();
    await h.settle();
    await h.click('edit-task', 't');
    assert.match(h.elements['#modal'].innerHTML, /data-do="refresh-form"/);
});
test('overlapping plan and appointment remain individually selectable while later blocks regain full width', () => {
    const events = [{ id: 'a', type: 'planned', start: 540, end: 600 }, { id: 'b', type: 'external', start: 570, end: 615 }, { id: 'c', type: 'planned', start: 615, end: 645 }];
    const placed = D.lanes(events);
    assert.equal(placed[0].count, 2);
    assert.equal(placed[1].lane, 1);
    assert.equal(placed[2].count, 1);
});
test('Study can subscribe to a private ICS URL without displaying saved source links',async()=>{
 const h=dashboardHarness({'/api/integrations/status':{study:{subscriptions:[{last_synced_at:'2026-11-23',course_id:null,id:'s',url:'private-ics-secret'}]}}});
 await h.settle();await h.click('nav','study');
 assert.match(h.elements['#app'].innerHTML,/2026-11-23/);assert.doesNotMatch(h.elements['#app'].innerHTML,/private-ics-secret/);
 await h.click('subscribe');assert.match(h.elements['#modal'].innerHTML,/name="url"/);
});
test('AI gate shows reason and budget, offers an explicit action only when enabled',async()=>{
 for(const enabled of [false,true]){
 const h=dashboardHarness({'/api/ai/status':{enabled,reason:enabled?null:'No grant',monthly_cap_usd:3,spent_or_reserved_usd:.25}});
 await h.settle();await h.click('nav','settings');const body=h.elements['#app'].innerHTML;
 assert.match(body,/0\.25/);
 if(enabled)assert.match(body,/data-do="summarize"/);else{assert.match(body,/No grant/);assert.doesNotMatch(body,/data-do="summarize"/);}
 assert.equal(h.requests.some(r=>r.path==='/api/ai/summarize'),false);
 }
});
test('simultaneous reconnect signals deliver the original queued actions in order',async()=>{
 const h=dashboardHarness();await h.settle();h.flags.offline=true;
 await h.click('start-task','t');const [first]=JSON.parse([...h.storage.values()][0]);
 await h.click('pause',first.payload.id);h.flags.offline=false;const offset=h.requests.length;
 h.online();h.online();await h.settle();
 assert.deepEqual(h.requests.slice(offset).filter(r=>r.path==='/api/v2/commands').map(r=>r.body.type),['session.start','session.pause']);
});
test('captured task drag ignores an unrelated pointer cancellation and posts the snapped destination once',async()=>{
 const h=dashboardHarness();await h.settle();
 const column={dataset:{day:'2026-11-23'},closest:s=>s==='.day-column'?column:{getBoundingClientRect:()=>({top:0,bottom:1440})},getBoundingClientRect:()=>({top:0,height:1440}),append(){}};
 h.context.document.elementFromPoint=()=>column;
 h.context.document.createElement=()=>({style:{}});
 h.context.document.body={classList:{add(){},remove(){}}};
 const grip={dataset:{grip:'task',id:'t'},setPointerCapture(){},closest:s=>s==='[data-grip]'?grip:null};
 const e={pointerId:1,isPrimary:true,target:grip,button:0,clientX:12,clientY:100};
 h.listeners.pointerdown(e);h.listeners.pointermove({...e,clientY:1439});
 h.listeners.pointercancel({...e,pointerId:9});
 await h.listeners.pointerup({...e,clientY:1439});await h.listeners.pointerup({...e,clientY:1439});
 const writes=h.requests.filter(r=>r.path==='/api/v2/commands');
 assert.equal(writes.length,1);
 assert.equal(writes[0].body.payload.start_local,'23:45');assert.equal(writes[0].body.payload.end_date,'2026-11-24');
 assert.equal(writes[0].body.payload.end_local,'00:15');
});
test('tracker exposes keyboard details without toggling records and a category timer',async()=>{
 const h=dashboardHarness();await h.settle();h.saved.categories.push({id:'study',name:'学习',color:'#99aa88'});await h.click('retry');
 assert.match(h.elements['#app'].innerHTML,/data-do="tracker-detail"/);
 assert.match(h.elements['#app'].innerHTML,/data-do="category-timer" data-id="study"/);
 const date=D.wall(Date.now()).slice(0,10);await h.click('tracker-detail',date+'|study');
 assert.match(h.elements['#modal'].innerHTML,/无应做记录/);assert.equal(h.requests.filter(r=>r.path==='/api/v2/commands').length,0);
});
test('calendar opens at 09:00 and ignores a hidden grid resetting its scroll',async()=>{
 const h=dashboardHarness();await h.settle();
 const el={isConnected:true,clientHeight:500,scrollTop:0,addEventListener(type,fn){this.onScroll=fn;}};
 h.elements['#app'].querySelector=q=>q==='.grid-scroll'?el:null;
 await h.click('view','week');
 assert.equal(el.scrollTop,576);
 el.scrollTop=1120;el.onScroll();
 el.clientHeight=0;el.scrollTop=0;el.onScroll();await h.click('mobile','today');
 el.clientHeight=500;await h.click('mobile','calendar');assert.equal(el.scrollTop,1120);
});
test('cloud health and private subscription controls stay on the Mac while remote refresh is queued',async()=>{
 const routes={'/api/health-local/summary':{status:'local_only',message:'Available on your Mac.'},'/api/integrations/status':{cloud:true,study:{local_subscription_setup:true}},'/api/study/refresh':{status:'pending'}};
 const h=dashboardHarness(routes);await h.settle();await h.click('nav','insights');
 assert.match(h.elements['#app'].innerHTML,/Mac/);assert.doesNotMatch(h.elements['#app'].innerHTML,/data-do="(?:health-import|checkin)"/);
 await h.click('nav','study');assert.doesNotMatch(h.elements['#app'].innerHTML,/data-do="subscribe"/);
 await h.click('refresh-study');assert.match(h.elements['#toast'].textContent,/等待 Mac/);
 assert.deepEqual(h.requests.filter(r=>r.path==='/api/study/refresh').map(r=>r.body),[{}]);
});
test('an actual segment lasting a few seconds is visible as less than one minute',async()=>{
 const h=dashboardHarness();await h.settle();const day=D.wall(Date.now()).slice(0,10),start=D.midnight(day);
 h.saved.sessions.push({id:'s',title:'Reading',status:'stopped',segments:[{start:new Date(start).toISOString(),end:new Date(start+5000).toISOString()}]});
 await h.click('nav','overview');assert.match(h.elements['#app'].innerHTML,/不足 1 分钟已记录/);
});
test('structured radar failures name the source and underlying error',async()=>{
 const h=dashboardHarness({'/api/integrations/status':{radar:{errors:[{source:'RSS',error:'Timed out'}]}}});await h.settle();await h.click('nav','radar');assert.match(h.elements['#app'].innerHTML,/RSS · Timed out/);
});
test('HTTP 202 is reported as queued even without a pending string in the response',async()=>{
 const path='/api/integrations/radar/refresh',h=dashboardHarness({[path]:{id:'remote-job'}},{[path]:202});
 await h.settle();await h.click('nav','radar');await h.click('refresh-feed');assert.match(h.elements['#toast'].textContent,/等待 Mac/);
});
test('health endpoint errors render the structured reason and hide private input forms',async()=>{
 const path='/api/health-local/summary',h=dashboardHarness({[path]:{error:{source:'Health',message:'File unavailable'}}},{[path]:503});
 await h.settle();await h.click('nav','insights');assert.match(h.elements['#app'].innerHTML,/Health · File unavailable/);assert.doesNotMatch(h.elements['#app'].innerHTML,/\[object Object\]|data-do="health-import"/);
});
test('queued calendar discovery polls its own request ID and opens the returned calendar chooser',async()=>{
 const path='/api/calendar/discover',poll=path+'?id=job1';
 const h=dashboardHarness({[path]:{id:'job1',status:'pending'},[poll]:{status:'authorized',calendars:[{id:'c',title:'Work'}],sources:[{id:'i',type:'icloud',writable:true,title:'iCloud'}]}},{[path]:202});
 await h.settle();await h.click('nav','settings');h.context.setTimeout=(f,ms)=>{if(ms===2000)setImmediate(f);};await h.click('discover');
 assert.match(h.elements['#modal'].innerHTML,/Work/);assert.equal(h.requests.filter(r=>r.path===poll).length,1);
});
test('offline Mac discovery stops polling after 30 seconds and retains a pending status',async()=>{
 const path='/api/calendar/discover',poll=path+'?id=job2';
 const h=dashboardHarness({[path]:{id:'job2',status:'pending'},[poll]:{status:'pending'}},{[path]:202,[poll]:202});
 await h.settle();await h.click('nav','settings');h.context.setTimeout=(f,ms)=>{if(ms===2000)setImmediate(f);};await h.click('discover');
 assert.equal(h.requests.filter(r=>r.path===poll).length,15);assert.match(h.elements['#app'].innerHTML,/稍后再试/);assert.doesNotMatch(h.elements['#app'].innerHTML,/没有找到可连接的日历/);
});
test('local calendar discovery opens immediately without polling',async()=>{
 const path='/api/calendar/discover';
 const h=dashboardHarness({[path]:{status:'authorized',calendars:[{id:'local',title:'Local calendar'}],sources:[]}});
 await h.settle();await h.click('nav','settings');await h.click('discover');
 assert.match(h.elements['#modal'].innerHTML,/Local calendar/);assert.equal(h.requests.filter(r=>r.path.startsWith(path+'?')).length,0);
});
test('historical category marks retain explicit true and false, while rollout uses only due routines',()=>{
 const state={rollout_date:'2026-11-23',category_checks:['2026-11-21','2026-11-22','2026-11-23'].map((day,i)=>({category_id:'a',local_date:day,completed:i!==1})),occurrences:[]};
 assert.deepEqual(D.categoryDay(state,'2026-11-21','a'),{status:'solid',legacy:true});
 assert.deepEqual(D.categoryDay(state,'2026-11-22','a'),{status:'none',legacy:true});
 assert.deepEqual(D.categoryDay(state,'2026-11-23','a'),{status:'na',legacy:false});
});
test('calendar overrides require confirmation for a specific resolvable job and observed token',async()=>{
 const jobs=[{id:'j',title:'My plan',start_at:'2026-11-23T01:00:00Z',end_at:'2026-11-23T02:00:00Z',operation:'upsert',error:'Changed remotely',conflict:{token:'secret-token',title:'Remote edition',start_at:'2026-11-23T02:30:00Z',end_at:'2026-11-23T03:00:00Z'}},{id:'k',title:'Another task',operation:'upsert',error:'Missing calendar'}];
 const h=dashboardHarness({'/api/calendar/status':{jobs,pending_count:2}});await h.settle();await h.click('nav','settings');
 const page=h.elements['#app'].innerHTML;assert.match(page,/Changed remotely/);assert.match(page,/Missing calendar/);assert.match(page,/Remote edition/);assert.match(page,/13:30/);assert.match(page,/12:00/);assert.doesNotMatch(page,/data-do="resolve-calendar" data-id="k"|secret-token/);
 await h.click('resolve-calendar','j');assert.match(h.elements['#modal'].innerHTML,/以 Small Plan 为准/);
 assert.equal(h.requests.some(r=>r.path==='/api/calendar/resolve'),false);
 await h.click('close');assert.equal(h.requests.some(r=>r.path==='/api/calendar/resolve'),false);
 await h.click('resolve-calendar','j');h.context.FormData=class extends Map {constructor(){super();}};
 await h.listeners['modal:submit']({preventDefault(){},target:{querySelector:()=>({})}});
 assert.deepEqual(h.requests.filter(r=>r.path==='/api/calendar/resolve').map(r=>r.body),[{job_id:'j',token:'secret-token',action:'use_planner'}]);
});
test('Radar selects five items from the dated snapshot, caps repositories at two and retains overflow',()=>{
 const day='2026-11-23',kinds=['repository','repository','repository','news','news','news','news'];
 const rows=kinds.map((kind,i)=>({id:String(i),kind,fetched_at:day+'T01:00:00Z'}));
 rows.unshift({id:'old',kind:'news',fetched_at:'2026-11-20T00:00:00Z'});
 const {picks,rest}=D.radarPicks(rows,day);
 assert.deepEqual(picks.map(r=>r.id),['0','1','3','4','5']);assert.deepEqual(rest.map(r=>r.id),['old','2','6']);
});
test('weekly trend counts stopped actual minutes only and marks calendar-boundary weeks',()=>{
 const dates=D.month('2026-11-23'),byDay=Object.fromEntries(dates.map(date=>[date,{planned_minutes:900,actual_minutes:10}]));
 const bars=D.trend(dates,byDay,'week','2026-11-23');
 assert.equal(bars[0].minutes,10);assert.equal(bars[0].partial,true);
 assert.equal(bars[1].minutes,70);assert.equal(bars[1].partial,false);
 assert.equal(bars.at(-1).future,true);
});
test('Radar rules prioritize recent publication days and break same-day ties by topical relevance',()=>{
 const items=[['old','AI tips','2026-11-19'],['ordinary','Product talk','2026-11-22'],['topical','Data analytics','2026-11-22'],['new','General news','2026-11-23']].map(([id,title,published_at])=>({id,title,published_at,kind:'news',fetched_at:'2026-11-23T02:00:00Z'}));
 assert.deepEqual(D.radarPicks(items,'2026-11-23').picks.map(r=>r.id),['new','topical','ordinary','old']);
});
test('legacy mark detail remains read-only even when the category is archived and no routines were due',async()=>{
 const h=dashboardHarness();await h.settle();const day=D.wall(Date.now()).slice(0,10);
 h.saved.rollout_date=D.add(day,1);h.saved.categories=[{id:'c',name:'Archive',archived_at:'past'}];
 h.saved.category_checks=[{category_id:'c',local_date:day,completed:true}];
 await h.click('retry');assert.match(h.elements['#app'].innerHTML,/旧版分类打卡（只读） · 已打卡/);
 await h.click('tracker-detail',day+'|c');assert.match(h.elements['#modal'].innerHTML,/旧版分类打卡（只读） · 已打卡/);assert.doesNotMatch(h.elements['#modal'].innerHTML,/type="submit"|data-do="toggle/);
});
test('overview category shares use actuals only and support a daily trend and prior-month comparison',async()=>{
 const day=D.wall(Date.now()).slice(0,10),m=D.month(day),previous=D.month(D.add(m[0],-1)),url=days=>'/api/v2/overview?from='+days[0]+'&to='+days.at(-1);
 const h=dashboardHarness({[url(m)]:{by_category:{a:{actual_minutes:45,planned_minutes:500},b:{actual_minutes:15,planned_minutes:5}},by_day:{[day]:{actual_minutes:60,planned_minutes:505}}},[url(previous)]:{by_day:{[previous[0]]:{actual_minutes:130,planned_minutes:5}}}});
 await h.settle();await h.click('nav','overview');assert.match(h.elements['#app'].innerHTML,/75\.0%/);assert.match(h.elements['#app'].innerHTML,/25\.0%/);assert.match(h.elements['#app'].innerHTML,/130 分钟/);
 await h.click('trend','day');assert.match(h.elements['#app'].innerHTML,/实际活动趋势/);assert.match(h.elements['#app'].innerHTML,/60 分钟/);
});
test('Mac cache shows validated cloud origin, blocks planner actions and preserves local authoring surfaces',async()=>{
 const h=dashboardHarness({'/api/integrations/status':{study:{subscriptions:[]}}});await h.settle();
 h.saved.local_authority={mode:'cloud',read_only:true,origin:'https://planner.example',updated_at:'2026-11-23T01:00:00Z'};
 await h.click('retry');const html=h.elements['#app'].innerHTML;
 assert.match(html,/Mac 只读缓存/);assert.match(html,/href="https:\/\/planner.example/);
 for(const action of ['start-task','toggle-task','edit-task','discover','resolve-calendar','restore'])await h.click(action,'t');
 assert.equal(h.requests.filter(r=>r.body).length,0);assert.equal(h.elements['#modal'].open,false);
 await h.click('nav','insights');await h.click('checkin');assert.match(h.elements['#modal'].innerHTML,/name="energy"/);
 await h.click('close');await h.click('nav','study');await h.click('subscribe');assert.match(h.elements['#modal'].innerHTML,/私有 ICS/);
 h.saved.local_authority.origin='javascript:alert(1)';await h.click('close');await h.click('retry');assert.doesNotMatch(h.elements['#app'].innerHTML,/href="javascript|href="data:/);
});
test('a pending local timer survives a change to cloud authority without replay or projection',async()=>{
 const h=dashboardHarness();await h.settle();h.flags.offline=true;await h.click('start-task','t');
 const pending=[...h.storage.values()][0];h.flags.offline=false;
 h.saved.local_authority={mode:'cloud',read_only:true,origin:'https://planner.example'};
 const since=h.requests.length;h.online();await h.settle();
 assert.equal(h.requests.slice(since).some(r=>r.path==='/api/v2/commands'),false);
 assert.equal([...h.storage.values()][0],pending);assert.doesNotMatch(h.elements['#app'].innerHTML,/data-do="pause"/);
 await h.click('queue');assert.match(h.elements['#modal'].innerHTML,/session.start/);assert.doesNotMatch(h.elements['#modal'].innerHTML,/data-do="retry-queue"|data-do="discard-queue"/);
});
test('missing cloud cache leaves local health accessible without fabricating planner state',async()=>{
 const day=D.wall(Date.now()).slice(0,10),days=D.month(day),path='/api/v2/state?from='+D.week(days[0])[0]+'&to='+D.week(days.at(-1))[6];
 const h=dashboardHarness({[path]:{error:'Cache unavailable'},'/api/health-local/summary':{local_only:true,local_authority:{mode:'cloud',read_only:true,origin:'https://planner.example'},metrics:[],insights:[]}},{[path]:503});
 await h.settle();assert.match(h.elements['#app'].innerHTML,/打开本机健康记录/);await h.click('open-local-health');
 assert.match(h.elements['#app'].innerHTML,/data-do="checkin"/);assert.doesNotMatch(h.elements['#app'].innerHTML,/class="dashboard"/);
});
test('partial dots expose the visible done/due ratio, page navigation resets window scroll without changing calendar scroll',async()=>{
 const h=dashboardHarness();await h.settle();const day=D.wall(Date.now()).slice(0,10);
 h.saved.categories.push({id:'c',name:'Reading',color:'#779977'});
 h.saved.occurrences=['done','done','todo'].map((status,i)=>({id:'o'+i,local_date:day,category_id:'c',title:'r'+i,status}));
 await h.click('retry');assert.match(h.elements['#app'].innerHTML,/<small>2\/3<\/small>/);
 let resets=0;h.context.window.scrollTo=({top})=>{if(top===0)resets++;};
 await h.click('nav','overview');await h.click('nav','planner');assert.equal(resets,2);
});
test('Career shows recent digest jobs then nearest scheduled followups then application history, and timestamps describe each source',async()=>{
 const h=dashboardHarness();await h.settle();
 const row=(title,source_id,published_at,extra={})=>({id:title,title,source_id,kind:'job',source:'career-ops',published_at,fetched_at:'2026-11-23',...extra});
 h.saved.external_items=[row('Old application','application:1','2026-09-18',{status:'Interview'}),row('Older digest','digest:d','2026-11-17'),row('Later followup','followup-next:2',null,{kind:'followup',deadline:'2026-12-03'}),row('Nearest followup','followup-next:1',null,{kind:'followup',deadline:'2026-11-25'}),row('Latest digest','digest:e','2026-11-23'),row('Code repo','github:1','2026-11-20',{kind:'repository',source:'GitHub'}),row('Feed news','news:1','2026-11-22',{kind:'news',source:'Feed'})];
 await h.click('nav','career');const html=h.elements['#app'].innerHTML;
 assert.deepEqual([...html.matchAll(/<article class="feed"><small>[^<]*<\/small><h3>([^<]+)<\/h3>/g)].map(match=>match[1]),['Latest digest','Older digest','Nearest followup','Later followup','Old application']);
 assert.match(html,/记录日期 2026-09-18/);assert.match(html,/Interview/);assert.match(html,/读取 2026-11-23/);
 await h.click('nav','radar');assert.match(h.elements['#app'].innerHTML,/更新 2026-11-20/);assert.match(h.elements['#app'].innerHTML,/发布 2026-11-22/);
});

function careerSections(html) {
 return [...html.matchAll(/<details\b([^>]*\bdata-career-group="([^"]+)"[^>]*)>([\s\S]*?)<\/details>/g)]
  .map(([,attributes,id,body])=>({id,open:/\bopen(?:\s|$|=)/.test(attributes),body,
   titles:[...body.matchAll(/<h3>([^<]+)<\/h3>/g)].map(m=>m[1])}));
}
test('Career separates recommendations, upcoming followups and progress without losing history or treating applied digest jobs as new',async()=>{
 const h=dashboardHarness();await h.settle();
 const row=(id,kind,source_id,extra={})=>({id,title:id,kind,source_id,source:'career-ops',fetched_at:'2026-11-24',...extra});
 h.saved.external_items=[
  row('Earlier recommendation','job','digest:old',{published_at:'2026-11-20'}),
  row('Recent recommendation','job','digest:new',{published_at:'2026-11-23'}),
  row('Later followup','followup','followup-next:2',{deadline:'2026-12-03',status:'Scheduled'}),
  row('Next followup','followup','followup-next:1',{deadline:'2026-11-25',status:'Scheduled'}),
  row('Submitted application','job','application:1',{status:'Applied',published_at:'2026-11-22'}),
  row('Already applied digest','job','digest:applied',{status:'Applied',published_at:'2026-11-21'}),
  row('Past followup','followup','followup-log:1',{status:'Logged',published_at:'2026-11-19'}),
  row('Hidden news','news','news:1')
 ];
 await h.click('nav','career');const groups=careerSections(h.elements['#app'].innerHTML);
 assert.deepEqual(groups.map(g=>[g.id,g.titles]),[
  ['opportunities',['Recent recommendation','Earlier recommendation']],
  ['followups',['Next followup','Later followup']],
  ['progress',['Submitted application','Already applied digest','Past followup']]
 ]);
 assert.ok(groups.every(g=>!g.open),'Groups should initially show a compact overview.');
 assert.doesNotMatch(h.elements['#app'].innerHTML,/Hidden news/);
});
test('Career disclosure choices survive task actions, navigation and reload independently without writing planner records',async()=>{
 const h=dashboardHarness();await h.settle();await h.click('nav','career');
 assert.equal(careerSections(h.elements['#app'].innerHTML).length,3);
 const toggle=(id,open,attached=true)=>{
  const target={dataset:{careerGroup:id},open};
  h.elements['#app'].contains=node=>attached && node===target;
  h.listeners.toggle({target});
 };
 const writes=()=>h.requests.filter(r=>r.path==='/api/v2/commands');
 toggle('opportunities',true);toggle('followups',true);toggle('opportunities',false);
 toggle('progress',true,false); // A queued event from a replaced DOM must not change the saved choice.
 assert.equal(writes().length,0);
 await h.click('external-task','job-to-plan');
 assert.deepEqual(writes().map(r=>[r.body.type,r.body.payload.id]),[['external.add_task','job-to-plan']]);
 assert.deepEqual(careerSections(h.elements['#app'].innerHTML).map(g=>g.open),[false,true,false]);
 await h.click('nav','planner');await h.click('nav','career');
 assert.deepEqual(careerSections(h.elements['#app'].innerHTML).map(g=>g.open),[false,true,false]);
 const restarted=dashboardHarness({}, {}, Object.fromEntries(h.storage));
 await restarted.settle();await restarted.click('nav','career');
 assert.deepEqual(careerSections(restarted.elements['#app'].innerHTML).map(g=>g.open),[false,true,false]);
});
