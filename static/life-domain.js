'use strict';
const LifeDomain = (() => {
    const timezone = 'Australia/Melbourne';
    const local = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const wall = instant => local.format(new Date(instant));
    const iso = date => date.toISOString().slice(0, 10);
    function add(date, days) {
        const d = new Date(date + 'T12:00Z');
        d.setUTCDate(d.getUTCDate() + days);
        return iso(d);
    }
    function week(date) {
        const start = add(date, -((new Date(date + 'T12:00Z').getUTCDay() + 6) % 7));
        return Array.from({ length: 7 }, (_, i) => add(start, i));
    }
    function month(date) {
        const first = date.slice(0, 7) + '-01';
        const d = new Date(first + 'T12:00Z');
        d.setUTCMonth(d.getUTCMonth() + 1, 0);
        return Array.from({ length: d.getUTCDate() }, (_, i) => add(first, i));
    }
    const midnightCache = new Map();
    function midnight(date) {
        if (midnightCache.has(date))
            return midnightCache.get(date);
        const base = Date.parse(date + 'T00:00Z');
        const offset = Date.parse(wall(base - 12 * 3600000).replace(' ', 'T') + 'Z') - (base - 12 * 3600000);
        const result = base - offset;
        midnightCache.set(date, result);
        return result;
    }
    function dot(rows, date, category) {
        const due = rows.filter(r => r.local_date === date && (r.category_id || null) === (category || null));
        const done = due.filter(r => r.status === 'done').length;
        return !due.length ? 'na' : done === due.length ? 'solid' : done ? 'partial' : 'none';
    }
    const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
    const clock = m => [Math.floor(m / 60) % 24, m % 60].map(n => String(n).padStart(2, '0')).join(':');
    function slot(date, position, duration) {
        const start = Math.max(0, Math.min(1425, Math.round(position / 15) * 15)), end = start + duration;
        return { local_date: date, start_local: clock(start), end_date: add(date, Math.floor(end / 1440)), end_local: clock(end) };
    }
    function actual(sessions, date, now = Date.now()) {
        const lo = midnight(date), hi = midnight(add(date, 1)), result = [];
        for (const session of sessions) {
            if (!['stopped', 'paused', 'running', 'active'].includes(session.status) || session.needs_review)
                continue;
            for (const seg of session.segments) {
                const start = Math.max(lo, Date.parse(seg.start)), end = Math.min(hi, seg.end ? Date.parse(seg.end) : now);
                if (end > start)
                    result.push({ session, start, end, minutes: (end - start) / 60000 });
            }
        }
        return result;
    }
    function projectTimer(sessions, operations, lookup) {
        const projected = sessions.map(s => ({ ...s, segments: s.segments.map(segment => ({ ...segment })) }));
        for (const op of operations) {
            const p = op.payload, time = op.effective_at;
            let session = projected.find(s => s.id === p.id);
            if (op.type === 'session.start') {
                if (session)
                    continue;
                const subject = lookup(p) || {};
                projected.push({
                    ...p, title: p.title || subject.title || subject.name || 'Focus', category_id: p.category_id || subject.category_id, status: 'running', started_at: time, segments: [{ start: time, end: null }]
                });
            }
            else if (session && (!session.updated_at || Date.parse(time) >= Date.parse(session.updated_at))) {
                if (op.type === 'session.resume' && session.status === 'paused') {
                    session.segments.push({ start: time, end: null });
                    session.status = 'running';
                }
                if (op.type === 'session.pause' && session.status === 'running') {
                    session.segments.at(-1).end = time;
                    session.status = 'paused';
                }
                if (op.type === 'session.stop') {
                    if (session.status === 'running')
                        session.segments.at(-1).end = time;
                    session.status = 'stopped';
                    session.ended_at = time;
                }
                session.updated_at = time;
            }
        }
        return projected;
    }
    function lanes(events) {
        const ordered = events.slice().sort((a, b) => a.start - b.start || b.end - a.end);
        const placed = [];
        let cluster = [], ends = [], clusterEnd = -1;
        function finish() {
            placed.push(...cluster.map(event => ({ ...event, count: ends.length })));
            cluster = [];
            ends = [];
            clusterEnd = -1;
        }
        for (const event of ordered) {
            if (event.start >= clusterEnd)
                finish();
            let lane = ends.findIndex(end => end <= event.start);
            if (lane < 0)
                lane = ends.length;
            ends[lane] = event.end;
            clusterEnd = Math.max(clusterEnd, event.end);
            cluster.push({ ...event, lane });
        }
        finish();
        return placed;
    }
    function radarTopics(item) {
        const text=[item.title,item.summary,item.reason].filter(Boolean).join(' ');
        return [['数据分析',/\b(data|analytics|analysis|sql)\b|数据分析|数据科学/i],
            ['AI 与机器学习',/\b(ai|ml|machine learning|deep learning|llms?)\b|人工智能|机器学习/i]]
            .filter(([,regex])=>regex.test(text)).map(([label])=>label);
    }
    function radarPicks(rows,day) {
        const valid=stamp=>stamp && Number.isFinite(Date.parse(stamp));
        const ranked=rows.filter(item=>valid(item.fetched_at) && wall(item.fetched_at).slice(0,10)===day).map(item=>{
            const time=valid(item.published_at)?item.published_at:item.fetched_at;
            return {item,day:wall(time).slice(0,10),topics:radarTopics(item).length,time:Date.parse(time)};
        }).sort((a,b)=>b.day.localeCompare(a.day)||b.topics-a.topics||b.time-a.time);
        const picks=[];let repos=0;
        for (const {item} of ranked) {
            if (item.kind==='repository' && repos>=2) continue;
            picks.push(item);
            if (item.kind==='repository') repos++;
            if (picks.length===5) break;
        }
        const selected=new Set(picks);
        return {picks,rest:rows.filter(item=>!selected.has(item))};
    }
    function trend(days,byDay,period,today) {
        const buckets=new Map();
        for (const date of days) {
            const key=period==='week'?week(date)[0]:period==='month'?date.slice(0,7):date;
            if (!buckets.has(key)) buckets.set(key,[]);
            buckets.get(key).push(date);
        }
        return Array.from(buckets.values(),dates=>{
            const start=dates[0],end=dates.at(-1);
            return {start,end,future:start>today,
                partial:(period==='week' && dates.length<7) || (start<=today && today<=end),
                minutes:dates.reduce((sum,date)=>sum+Number(byDay[date]?.actual_minutes||0),0)};
        });
    }
    function categoryDay(state,day,category) {
        if (state.rollout_date && day<state.rollout_date) {
            const check=(state.category_checks||[]).find(r=>r.local_date===day && r.category_id===category);
            return {status:check ? (check.completed ? 'solid' : 'none') : 'na',legacy:true};
        }
        const due=state.occurrences.filter(r=>r.local_date===day && (r.category_id||null)===(category||null));
        const done=due.filter(r=>r.status==='done').length;
        return {status:dot(due,day,category),legacy:false,done,total:due.length,progress:due.length?done/due.length:0};
    }
    return { radarTopics, radarPicks, trend, categoryDay, lanes, projectTimer, wall, timezone, week, month, midnight, add, minutes, clock, slot, actual, dot };
})();
if (typeof module !== 'undefined')
    module.exports = LifeDomain;
