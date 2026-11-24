'use strict';
(() => {
    const D = LifeDomain, app = document.querySelector('#app'), modal = document.querySelector('#modal'), toast = document.querySelector('#toast');
    const today = () => D.wall(Date.now()).slice(0, 10);
    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const color = value => /^#[a-f0-9]{3,8}$/i.test(value) ? value : '#75866c';
    const short = (date, opts = { month: 'short', day: 'numeric' }) => new Intl.DateTimeFormat('en-AU', { ...opts, timeZone: 'UTC' }).format(new Date(date + 'T12:00Z'));
    const pages = {
        planner: 'Planner', overview: 'Overview', study: 'Study', career: 'Career', radar: 'Radar', insights: 'Insights', settings: 'Settings'
    };
    const careerGroups = [
        { id: 'opportunities', title: '待考虑岗位', description: '每日摘要中的候选岗位，先筛选，再加入当日任务。', empty: '暂时没有待考虑的岗位。' },
        { id: 'followups', title: '待跟进', description: '按跟进日期排列，查看接下来需要联系或确认的事项。', empty: '暂时没有已安排日期的跟进提醒。' },
        { id: 'progress', title: '投递进度', description: '投递状态与跟进历史；状态请在 career-ops 中更新。', empty: '暂时没有投递或历史跟进记录。' }
    ];
    const careerOpenKey = 'small-plan-career-sections', careerOpen = {};
    try {
        const saved = JSON.parse(localStorage.getItem(careerOpenKey) || '{}');
        for (const group of careerGroups)
            if (typeof saved?.[group.id] === 'boolean') careerOpen[group.id] = saved[group.id];
    } catch { /* Disclosures still work when browser storage is unavailable. */ }
    const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
    let date = today(), page = 'planner', view = 'week', mobile = 'today', state, notice = '', locked = false, formHandler, proposal, discoveryJob, discovering = false, discoveryMessage = '';
    let cacheUnavailable=false;
    let replaying, retryOnTimer = true, trendPeriod = 'week';
    let routeSequence = 0, scrollTop = 9 * 64, aux = {}, timerQueue = [], lastSync = '', toastTimeout;
    const queueKey = 'small-plan-timer-operations-v2';
    try {
        timerQueue = JSON.parse(localStorage.getItem(queueKey) || '[]');
    }
    catch {
        notice = '无法读取本地计时队列。';
    }
    const saveQueue = () => localStorage.setItem(queueKey, JSON.stringify(timerQueue));
    const by = (table, id) => state[table].find(item => item.id === id);
    const category = id => by('categories', id) || { name: '未分类', color: '#918b80' };
    const attr = (key, val) => ' ' + key + '="' + esc(val) + '"';
    const authority=()=>state?.local_authority || (!state ? aux.health?.local_authority : null);
    const readOnly=()=>authority()?.mode==='cloud' && authority()?.read_only===true;
    const cacheNotice='此 Mac 显示只读缓存，请在云端修改计划。';
    const cacheActions=new Set(['nav','view','mobile','trend','today','day','prev','next','retry','close','tracker-detail',
        'queue','event-detail','session-detail','subscribe','health-import','checkin','open-local-health']);
    function cloudLink() {
        try {
            const url=new URL(authority()?.origin);
            if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash) return '';
            return '<a href="'+esc(url.origin)+'" target="_blank" rel="noopener noreferrer">打开云端 ↗</a>';
        } catch { return ''; }
    }
    function cacheBanner() {
        if (!readOnly()) return '';
        const updated=authority().updated_at;
        return '<section class="cache-banner" aria-label="缓存状态"><b>云端为主，当前是 Mac 只读缓存</b> '
            +(updated && Number.isFinite(Date.parse(updated)) ? '<span>更新于 '+esc(D.wall(updated))+' · 墨尔本时间</span> ' : '')
            +cloudLink()+(timerQueue.length?'<p>本机保留 '+timerQueue.length+' 项计时操作。请在云端核对并手动补记。 '
                +btn('queue','检查本机计时队列')+'</p>':'')+'</section>';
    }
    const btn = (action, label, id = '', cls = '', title = '') => '<button type="button" class="' + cls + '" data-do="' + action + '"' + attr('data-id', id) + (readOnly() && !cacheActions.has(action) ? ' disabled' : '') + (title ? attr('aria-label', title) + attr('title', title) : '') + '>' + label + '</button>';
    const empty = text => '<p class="empty">' + esc(text) + '</p>';
    const heading = (name, action = '') => '<div class="section-head"><h2>' + name + '</h2>' + action + '</div>';
    const dotLabels = { solid: '全部完成', partial: '部分完成', none: '未完成', na: '无应做记录' };
    function markLabel(mark) {
        if (!mark.legacy) return dotLabels[mark.status];
        const legacyLabels={solid:'已打卡',none:'未打卡',na:'无历史记录'};
        return '旧版分类打卡（只读） · '+legacyLabels[mark.status];
    }
    const dot=(mark,label)=>'<span class="dot '+mark.status+'" role="img"'
        + attr('aria-label',label+' · '+markLabel(mark)) + attr('title',label+' · '+markLabel(mark))+'></span>';

    function say(text) {
        toast.textContent = text;
        toast.classList.add('show');
        clearTimeout(toastTimeout);
        toastTimeout = setTimeout(() => toast.classList.remove('show'), 3200);
    }
    function errorText(detail) {
        if (typeof detail === 'string') return detail;
        if (Array.isArray(detail)) return detail.map(errorText).filter(Boolean).join('；');
        if (!detail || typeof detail !== 'object') return '';
        return [detail.source,errorText(detail.error || detail.message || detail.errors)].filter(Boolean).join(' · ');
    }
    const queueMessage = '请求已排队，等待 Mac 在线处理。';
    async function api(path, body, signal) {
        if(body!==undefined && readOnly() && !['/api/health-local/checkin','/api/health-local/import','/api/study/subscribe'].includes(path))
            throw new Error(cacheNotice);
        const response = await fetch(path, {
            method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', signal
        });
        const data = await response.json();
        if (!response.ok) {
            const err = new Error(errorText(data.error || data.message || data.errors) || response.statusText);
            err.status = response.status;
            throw err;
        }
        return response.status === 202 ? {...data,queued:true} : data;
    }
    function bounds() {
        const days = D.month(date);
        return '?from=' + D.week(days[0])[0] + '&to=' + D.week(days.at(-1))[6];
    }
    async function reload() {
        const seq = ++routeSequence;
        let next;
        try { next=await api('/api/v2/state'+bounds()); }
        catch(error) {
            if(error.status===503 && seq===routeSequence) {cacheUnavailable=true;state=undefined;}
            throw error;
        }
        cacheUnavailable=false;
        if (seq === routeSequence) {
            state = next;
            render();
        }
    }
    async function command(type, payload) {
        if(readOnly()) throw new Error(cacheNotice);
        const op = { type, payload, operation_id: crypto.randomUUID(), expected_revision: state.revision };
        if (type.startsWith('session.') && type !== 'session.review') {
            op.effective_at = new Date().toISOString();
            if (!timerQueue.length) {
                let committed = false;
                try {
                    await api('/api/v2/commands', op);
                    committed = true;
                }
                catch (e) {
                    if (e.status)
                        throw e;
                }
                if (committed) {
                    await reload();
                    return true;
                }
            }
            timerQueue.push(op);
            saveQueue();
            notice = '计时操作已暂存在本机，连接后会重试。';
            render();
            return false;
        }
        else {
            await api('/api/v2/commands', op);
        }
        await reload();
        return true;
    }
    function replay() {
        if (!replaying) replaying = reconcile().finally(() => { replaying = null; });
        return replaying;
    }
    async function reconcile() {
        let lastStoppedId;
        retryOnTimer = true;
        while (timerQueue.length) {
            try {
                const op = timerQueue[0];
                const latest = await api('/api/v2/state' + bounds());
                state = latest;
                if(readOnly()) { retryOnTimer=false;notice='';render();return; }
                await api('/api/v2/commands', { ...op, expected_revision: latest.revision });
                if (op.type === 'session.stop') lastStoppedId = op.payload.id;
            }
            catch (e) {
                retryOnTimer = !e.status;
                notice = (e.status ? '计时冲突，请核对服务器记录。 ' : '待同步计时操作。 ') + e.message;
                render();
                return;
            }
            timerQueue.shift();
            saveQueue();
        }
        await reload();
        notice = '';
        render();
        const stopped = lastStoppedId && by('sessions', lastStoppedId);
        if (stopped && !modal.open) {
            if (stopped.status === 'needs_review') await action('session-detail',stopped.id);
            else completion(stopped);
        }
    }
    function fail(e) {
        notice = e.message || String(e);
        if (modal.open) {
            const out = modal.querySelector('[role=alert]');
            if (out)
                out.textContent = notice;
            const refresh = modal.querySelector('[data-do=refresh-form]');
            if (refresh)
                refresh.hidden = e.status !== 409;
        }
        render();
    }
    function dialog(title, body, onSubmit, submit = '保存') {
        formHandler = onSubmit;
        modal.innerHTML = '<div class="dialog-head"><h2 id="modal-title">' + esc(title) + '</h2>' + btn('close', '×', '', 'icon', '关闭') + '</div><form>' + body + '<p class="error" role="alert"></p><button type="button" data-do="refresh-form" hidden>读取新版本，保留当前草稿</button>' + (onSubmit ? '<div class="form-foot">' + btn('close', '取消') + '<button class="primary" type="submit">' + esc(submit) + '</button></div>' : '') + '</form>';
        if (!modal.open)
            modal.showModal();
    }
    const field = (name, label, value = '', type = 'text', required = true) => '<label>' + esc(label) + '<input name="' + name + '" type="' + type + '"' + attr('value', value) + (required ? ' required' : '') + '></label>';
    const area = (name, label, value = '') => '<label>' + esc(label) + '<textarea rows="3" name="' + name + '">' + esc(value) + '</textarea></label>';
    const select = (name, label, options, current) => '<label>' + esc(label) + '<select name="' + name + '">' + options.map(([id, title]) => '<option' + attr('value', id) + (id === current ? ' selected' : '') + '>' + esc(title) + '</option>').join('') + '</select></label>';
    const categories = id => select('category_id', '分类', [['', '未分类'], ...state.categories.filter(c => !c.archived_at || c.id === id).map(c => [c.id, c.name])], id || '');
    const projected = () => D.projectTimer(state.sessions, timerQueue, p => p.task_id ? by('tasks', p.task_id) : p.occurrence_id ? by('occurrences', p.occurrence_id) : category(p.category_id));
    const active = () => (timerQueue.length ? projected() : state.sessions).find(s => ['running', 'paused', 'active'].includes(s.status));
    function timer() {
        if(readOnly()) return '<span class="meta">计时由云端管理</span>';
        const s = active();
        if (!s)
            return btn('start-category', '▷ 开始计时', '', 'timer-button');
        return '<div class="timer-live"><b>' + esc(s.title || category(s.category_id).name) + '</b><time data-tick></time>' + btn(s.status === 'paused' ? 'resume' : 'pause', s.status === 'paused' ? '继续' : '暂停', s.id) + btn('stop', '停止', s.id) + '</div>';
    }
    function tick() {
        const t = document.querySelector('[data-tick]');
        if (!t || !state) return;
        const s = active();
        if (!s)
            return;
        const secs = Math.max(0, Math.floor(s.segments.reduce((n, x) => n + (x.end ? Date.parse(x.end) : Date.now()) - Date.parse(x.start), 0) / 1000));
        t.textContent = [Math.floor(secs / 3600), Math.floor(secs / 60) % 60, secs % 60].map(n => String(n).padStart(2, '0')).join(':');
    }
    function taskRow(r, kind) {
        const id = esc(r.id), done = r.status === 'done', k = kind === 'task' ? 'task' : 'occurrence';
        return '<article class="task-row"><div class="task-line">' + btn('toggle-' + k, done ? '✓' : '', id, 'check ' + (done ? 'checked' : ''), (done ? '撤销完成 ' : '完成 ') + r.title) + btn('edit-' + k, esc(r.title), id, 'text task-title ' + (done ? 'finished' : '')) + '<button type="button" class="grip" data-grip="' + k + '"' + attr('data-id', r.id) + attr('aria-label', '拖动安排 ' + r.title) + '>⠿</button></div><div class="row-tools">' + (k === 'task' ? '<span>' + esc(r.estimate_minutes || 30) + ' min</span>' : '') + btn('arrange-' + k, '安排', id) + btn('start-' + k, '▷ 计时', id) + (k === 'occurrence' ? btn('skip', r.status === 'skipped' ? '恢复' : '跳过', id) : '') + '</div></article>';
    }
    function left() {
        const n = state.daily_notes.find(x => x.local_date === date), tasks = state.tasks.filter(t => t.local_date === date);
        const deadlines = state.assessments.filter(a => !['done', 'archived'].includes(a.status)).sort((a, b) => a.due_at.localeCompare(b.due_at)).slice(0, 4);
        return '<aside class="left rail" data-mobile="today"><section class="focus">' + heading('Focus', btn('note', '✎', '', 'icon', '编辑今日重点与笔记')) + '<p>' + esc(n?.focus || '今天，最想完成什么？') + '</p>' + (n?.note_md ? '<div class="note">' + esc(n.note_md) + '</div>' : '') + '</section><section>' + heading('To-do', btn('edit-task', '＋', '', 'icon', '添加任务')) + '<div class="meta">' + tasks.filter(t => t.status === 'done').length + ' / ' + tasks.length + ' 已完成</div>' + (tasks.map(t => taskRow(t, 'task')).join('') || empty('今天还没有任务。')) + '</section><section>' + heading('Deadlines', btn('nav', '查看', 'study', 'text')) + (deadlines.map(a => btn('assessment', '<small>' + esc(String(a.due_at).slice(0, 10)) + '</small>' + esc(a.title), a.id, 'deadline')).join('') || empty('暂无待办截止日期。')) + '</section></aside>';
    }
    function groups() {
        const days=D.month(date),first=D.week(days[0])[0],last=D.week(days.at(-1))[6];
        const historicalCategories=new Set((state.category_checks||[]).filter(check=>
            check.local_date<state.rollout_date && check.local_date>=first && check.local_date<=last).map(check=>check.category_id));
        const result = state.categories.filter(c=>!c.archived_at || historicalCategories.has(c.id) || state.occurrences.some(o=>o.category_id===c.id));
        if (state.occurrences.some(o => !o.category_id) || state.routines.some(r => !r.category_id))
            result.push({ id: null, name: '未分类', color: '#948b7e' });
        return result;
    }
    function tracker() {
        const days = D.week(date);
        const groupsHtml = groups().map(c => {
            const due = state.occurrences.filter(o => o.local_date === date && (o.category_id || null) === c.id);
            const weeklyDots = days.map(day => {
                const status = D.categoryDay(state,day,c.id);
                const dueForDay=status.status==='partial'?state.occurrences.filter(o=>o.local_date===day && (o.category_id||null)===c.id):[];
                const count=dueForDay.length ? dueForDay.filter(o=>o.status==='done').length+'/'+dueForDay.length : '';
                return btn('tracker-detail',dot(status,day)+(count?'<small>'+count+'</small>':''),day+'|'+(c.id||''),'dot-detail',
                    c.name+' · '+day+' · '+markLabel(status)+(count?' '+count:'')+' · 查看记录');
            }).join('');
            const otherRoutines = state.routines.filter(r => r.active && (r.category_id || null) === c.id && !due.some(o => o.routine_id === r.id));
            const upcoming = otherRoutines.map(r => btn('edit-routine',
                esc(r.title) + '<small>周' + r.days_of_week.map(day => weekdays[day]).join('、') + '</small>',
                r.id, 'deadline')).join('');
            return '<div class="routine-group" style="--category:' + color(c.color) + '">'
                + '<div class="group-head"><h3><i></i>' + esc(c.name) + '</h3>'
                + btn('category-timer','▷ 计时',c.id||'','text','开始'+c.name+'计时')+'</div><div class="dot-row">' + weeklyDots + '</div>'
                + due.map(o => taskRow(o, 'occurrence')).join('') + upcoming + '</div>';
        }).join('');
        const labels = days.map(d => '<span>' + short(d, {weekday:'narrow'}) + '</span>').join('');
        return '<aside class="right rail" data-mobile="routines"><section>'
            + heading('Weekly tracker', btn('manage','管理','','text')) + '<div class="week-key">' + labels + '</div>'
            + (groupsHtml || empty('添加分类和习惯，即可开始追踪。')) + btn('edit-routine','＋ 新习惯','','wide')
            + '</section></aside>';
    }
    function segments(date) {
        return D.actual(state.sessions, date).map(x => ({
            title: x.session.title || category(x.session.category_id).name, color: category(x.session.category_id).color, start: D.minutes(D.wall(x.start).slice(11)), end: x.end === D.midnight(D.add(date, 1)) ? 1440 : D.minutes(D.wall(x.end).slice(11)), type: 'actual', id: x.session.id
        }));
    }
    function dayBlocks(day) {
        const result = [];
        for (const b of state.time_blocks) {
            const endDate = b.end_date || b.local_date;
            if (day < b.local_date || day > endDate)
                continue;
            const start = day > b.local_date ? 0 : D.minutes(b.start_local), end = day < endDate ? 1440 : D.minutes(b.end_local);
            if (end <= start)
                continue;
            const subject = (b.task_id && by('tasks', b.task_id)) || (b.occurrence_id && by('occurrences', b.occurrence_id)) || {};
            result.push({
                start, end, type: 'planned', id: b.id, title: b.title || subject.title || '计划', color: category(b.category_id || subject.category_id).color, time: b.start_local
            });
        }
        for (const e of state.external_events) {
            if (!e.start_at || !e.end_at)
                continue;
            const start = Math.max(Date.parse(e.start_at), D.midnight(day)), end = Math.min(Date.parse(e.end_at), D.midnight(D.add(day, 1)));
            if (end <= start)
                continue;
            result.push({
                type: 'external', id: e.id, start: D.minutes(D.wall(start).slice(11)), end: end === D.midnight(D.add(day, 1)) ? 1440 : D.minutes(D.wall(end).slice(11)), title: e.title || 'Calendar', color: '#8099a7'
            });
        }
        return D.lanes(result).concat(segments(day));
    }
    function grid() {
        const days = view === 'week' ? D.week(date) : [date];
        const headers = days.map(d => btn('day', short(d, { weekday: 'short' }) + ' <b>' + Number(d.slice(-2)) + '</b>', d, d === date ? 'selected' : '')).join('');
        const columns = days.map(day => '<div class="day-column" data-day="' + day + '">' + dayBlocks(day).map(b => '<button type="button" class="event ' + b.type + '"' + attr('data-do', b.type === 'planned' ? 'block' : b.type === 'actual' ? 'session-detail' : 'event-detail') + attr('data-id', b.id) + attr('aria-label', b.title + ' ' + D.clock(b.start)) + ' style="--category:' + color(b.color) + (b.type === 'actual' ? '' : ';left:' + (2 + 74 * b.lane / b.count) + '%;width:' + (74 / b.count - 1) + '%') + ';top:' + b.start / 14.4 + '%;height:' + Math.max(0.5, (b.end - b.start) / 14.4) + '%">' + (b.type === 'planned' ? '<span class="block-grip" data-grip="block"' + attr('data-id', b.id) + '>⠿</span>' : '') + '<b>' + esc(b.title) + '</b><small>' + D.clock(b.start) + '</small>' + (b.type === 'planned' ? '<span class="resize" data-grip="resize"' + attr('data-id', b.id) + '></span>' : '') + '</button>').join('') + '</div>').join('');
        return '<div class="day-head" style="--days:' + days.length + '"><span></span>' + headers + '</div><div class="grid-scroll"><div class="time-grid" style="--days:' + days.length + '"><div class="hours">' + Array.from({ length: 24 }, (_, i) => '<time>' + String(i).padStart(2, '0') + ':00</time>').join('') + '</div>' + columns + '</div></div><div class="legend"><span>▧ 计划</span><span>▮ 实际</span><span>▱ 外部日历</span></div>';
    }
    function month() {
        const days = D.month(date), start = D.week(days[0])[0], end = D.week(days.at(-1))[6], cells = [];
        for (let d = start; d <= end; d = D.add(d, 1)) {
            cells.push(btn('day', Number(d.slice(-2)) + '<span class="month-dots">' + groups().map(c => '<i style="--category:' + color(c.color) + '">' + dot(D.categoryDay(state,d,c.id), c.name) + '</i>').join('') + '</span>', d, (d === date ? 'selected ' : '') + (d.slice(0, 7) !== date.slice(0, 7) ? 'outside' : '')));
        }
        return '<div class="month-grid">' + weekdays.map(w => '<b>' + w + '</b>').join('') + cells.join('') + '</div>';
    }
    function planner() {
        return '<div class="dashboard" data-tab="' + mobile + '">' + left() + '<section class="calendar card" data-mobile="calendar">' + heading('Calendar', '<div class="segments">' + ['day', 'week', 'month'].map(v => btn('view', ({ day: '日', week: '周', month: '月' })[v], v, view === v ? 'selected' : '')).join('') + '</div>') + (view === 'month' ? month() : grid()) + '</section>' + tracker() + '</div>';
    }
    function actualTrends(stats,days) {
        if (!stats?.by_day) return '';
        const todayDate=today();
        const rows=D.trend(days,stats.by_day,trendPeriod,todayDate);
        function chart(bars) {
            const max=Math.max(1,...bars.map(row=>row.minutes));
            return '<div class="activity-bars">'+bars.map(row=>{
                const period=trendPeriod==='day' && row.start===row.end ? row.start.slice(-2)+' 日'
                    : row.start.slice(5)+' 至 '+row.end.slice(5);
                const label=row.future?'未开始':row.minutes>0 && row.minutes<1?'不足 1 分钟':Math.round(row.minutes)+' 分钟';
                return '<div><span>'+esc(period)+(row.partial&&!row.future?' · 部分时段':'')+'</span><i aria-hidden="true"><b style="width:'
                    +(100*row.minutes/max)+'%"></b></i><strong>'+esc(label)+'</strong></div>';
            }).join('')+'</div>';
        }
        const shares=Object.entries(stats.by_category||{}).filter(([,r])=>r.actual_minutes>0).sort((a,b)=>b[1].actual_minutes-a[1].actual_minutes);
        const total=shares.reduce((sum,[,r])=>sum+r.actual_minutes,0);
        const shareBars=shares.map(([id,r])=>{
            const percent=100*r.actual_minutes/total;
            return '<div><span>'+esc(category(id).name)+'</span><i aria-hidden="true"><b style="background:'+color(category(id).color)
                +';width:'+percent+'%"></b></i><strong>'+percent.toFixed(1)+'%</strong></div>';
        }).join('');
        const previous=aux.previousOverview;
        const monthly=previous?.by_day ? D.trend([...Object.keys(previous.by_day).sort(),...days],{...previous.by_day,...stats.by_day},'month',todayDate):[];
        return '<section class="card">'+heading('实际活动占比')+(total?'<div class="activity-bars">'+shareBars+'</div>':empty('本月暂无已记录的活动时长。'))
            +'</section><section class="card">'+heading('月度对比')+(monthly.length?chart(monthly):empty('暂无月度对比数据。'))
            +'</section><section class="card span">'+heading('实际活动趋势','<div class="segments">'+['day','week'].map(p=>btn('trend',p==='day'?'按日':'按周',p,p===trendPeriod?'selected':'')).join('')+'</div>')
            +chart(rows)+'</section>';
    }
    function overview() {
        const days = D.month(date), stats = aux.overview, actual = D.actual(state.sessions.filter(s => s.status === 'stopped'), date), dayStart = D.midnight(date), dayEnd = D.midnight(D.add(date, 1)), available = Math.max(0, Math.min(dayEnd, Date.now()) - dayStart) / 60000;
        const recorded = actual.reduce((total,segment)=>total+segment.minutes,0);
        const recordedLabel = recorded > 0 && recorded < 1 ? '不足 1' : Math.round(recorded);
        const count = Math.ceil((dayEnd - dayStart) / 600000);
        const pixels = Array.from({ length: count }, (_, i) => {
            const start = dayStart + i * 600000, s = actual.find(a => a.start < start + 600000 && a.end > start);
            return '<i style="--pixel:' + color(s ? category(s.session.category_id).color : '#eeeee8') + '"' + attr('title', D.wall(start).slice(11) + ' · ' + (s ? s.session.title : '未记录')) + '></i>';
        }).join('');
        return '<div class="secondary"><section class="card">' + heading('Month at a glance') + month() + '</section><section class="card">' + heading('Recorded time') + '<p>' + esc(date) + ' · 每格 10 分钟</p><div class="pixels">' + pixels + '</div><p>' + recordedLabel + ' 分钟已记录 · ' + Math.max(0, Math.round(available - recorded)) + ' 分钟未记录</p></section><section class="card span">' + heading('Routine matrix') + '<p class="meta">● 全部完成　◐ 部分完成　○ 未完成　– 无应做记录</p><div class="table-scroll"><table><thead><tr><th>分类</th>' + days.map(d => '<th>' + Number(d.slice(-2)) + '</th>').join('') + '</tr></thead><tbody>' + groups().map(c => '<tr style="--category:' + color(c.color) + '"><th>' + esc(c.name) + '</th>' + days.map(d => '<td>' + dot(D.categoryDay(state,d,c.id), d) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div></section><section class="card span">' + heading('Category hours') + (stats?.by_category ? '<table><tr><th>分类</th><th>计划小时</th><th>实际小时</th></tr>' + Object.entries(stats.by_category).map(([id, s]) => '<tr><td>' + esc(category(id).name) + '</td><td>' + (s.planned_minutes / 60).toFixed(1) + '</td><td>' + (s.actual_minutes / 60).toFixed(1) + '</td></tr>').join('') + '</table>' : empty(aux.loading ? '正在读取统计…' : '暂无分类统计。')) + '</section>' + actualTrends(stats,days) + '</div>';
    }
    function study() {
        const courses = state.courses.map(c => btn('course', esc(c.name), c.id, 'list-item')).join('');
        const assessments = state.assessments.map(a => btn('assessment', '<small>' + esc(a.due_at) + '</small>'
            + esc(a.title) + ' · ' + esc(a.status)
            + (a.deadline_changed ? '<small class="changed">截止时间已变更' + (a.previous_due_at ? ' · 原定 ' + esc(a.previous_due_at) : '')
                + '。已确认的时间块保留原安排。</small>' : ''), a.id, 'deadline')).join('');
        const remote = aux.cloud || aux.study?.local_subscription_setup;
        const subscriptionAction = !aux.integrationReady ? '' : remote ? btn('refresh-study','请求刷新') : btn('subscribe','添加订阅');
        const subscriptions = (aux.study?.subscriptions || []).map(s => {
            const course = by('courses', s.course_id);
            return '<article class="feed"><h3>' + esc(course?.name || 'ICS 订阅') + '</h3><p>'
                + esc(errorText(s.error) || (s.last_synced_at ? '上次同步 · ' + s.last_synced_at : '等待首次同步')) + '</p></article>';
        }).join('');
        return '<div class="secondary"><section class="card">' + heading('Courses',btn('course','＋ 课程'))
            + (courses || empty('尚未添加课程。')) + '</section><section class="card">' + heading('Assessments',btn('assessment','＋ 截止事项'))
            + (assessments || empty('暂无课程截止事项。')) + '</section><section class="card">' + heading('Study planning')
            + '<div class="actions">' + btn('study-import','导入 CSV / ICS') + btn('suggest','预览排程建议','','primary')
            + '</div></section><section class="card">' + heading('ICS subscriptions',subscriptionAction) + (remote ? empty('私有订阅链接请在 Mac 的 Small Plan 中配置。') : '')
            + (subscriptions || empty(aux.study?.message || (aux.loading ? '正在读取订阅…' : '暂无课程日历订阅。'))) + '</section></div>';
    }
    function feedCard(item,picked=false) {
        const career = ['job','followup'].includes(item.kind);
        const label = career ? (item.kind==='followup'
            ? item.source_id?.startsWith('followup-log:') || item.status==='Logged' ? '跟进记录' : '跟进提醒'
            : item.source_id?.startsWith('digest:') ? '岗位推荐' : '投递记录')+' · '+item.source : item.source+' · '+item.kind;
        const statusNames = { applied:'已投递', rejected:'未通过', interview:'面试中', interviewing:'面试中', offer:'已收到 Offer',
            scheduled:'待跟进', logged:'已记录', recommended:'待考虑', withdrawn:'已撤回', closed:'已结束', hired:'已录用' };
        const translated = career && statusNames[String(item.status || '').toLowerCase()];
        const status = translated ? translated+' · '+item.status : item.status;
        const sourceSummaries = ['Application tracker','Internship digest','Follow-up history','Scheduled follow-up'];
        const summary = career && sourceSummaries.includes(item.summary) ? '' : item.summary;
        const sourceReasons = ['Listed in the Career Ops source of truth.','Recorded in Career Ops.','Career Ops has an explicit next date.'];
        const explanation = career && sourceReasons.includes(item.reason) ? '' : item.reason;
        const topics=picked ? D.radarTopics(item) : [];
        const dateLabel=item.source==='career-ops' || ['job','followup'].includes(item.kind) ? '记录日期' : item.kind==='repository' ? '更新' : '发布';
        const times=[[dateLabel,item.published_at],['读取',item.fetched_at]].filter(([,value])=>value)
            .map(([label,value])=>label+' '+(Number.isFinite(Date.parse(value)) && String(value).length>10 ? D.wall(value) : value)).join(' · ');
        const reason=picked ? '<p class="meta">精选依据 · '+esc(topics.length ? topics.join('、')+'，按日期排序' : '按日期排序')+'</p>' : '';
        return '<article class="feed"><small>'+esc(label)+'</small><h3>'+esc(item.title)+'</h3>'
            +(times?'<small>'+esc(times)+'</small>':'')+(summary?'<p>'+esc(summary)+'</p>':'')+reason
            +(explanation && explanation!==summary?'<p>'+esc(explanation)+'</p>':'')
            +(status||item.deadline?'<p>'+esc([status,item.deadline && (career ? (item.kind==='followup'?'跟进日期 ':'截止日期 ') : '')+item.deadline].filter(Boolean).join(' · '))+'</p>':'')
            +'<div class="actions">'+(/^https?:\/\//i.test(item.url)?'<a target="_blank" rel="noopener noreferrer"'+attr('href',item.url)+'>查看来源 ↗</a>':'')
            +btn('external-task','加入当日任务',item.id)+'</div></article>';
    }
    function careerFeed(rows) {
        const groups = Object.fromEntries(careerGroups.map(group=>[group.id,[]]));
        const progressed = new Set(['applied','rejected','interview','interviewing','offer','withdrawn','closed','hired']);
        for (const item of rows) {
            const status=String(item.status || '').trim().toLowerCase();
            const group=item.kind==='followup'
                ? item.deadline && !item.source_id?.startsWith('followup-log:') && status!=='logged' ? 'followups' : 'progress'
                : item.source_id?.startsWith('digest:') && !progressed.has(status) ? 'opportunities' : 'progress';
            groups[group].push(item);
        }
        const recorded=item=>Date.parse(item.published_at||item.fetched_at)||0;
        const sections=careerGroups.map(group=>{
            const items=groups[group.id].sort((a,b)=>group.id==='followups'
                ? a.deadline.localeCompare(b.deadline) : recorded(b)-recorded(a));
            return '<details class="career-group"'+attr('data-career-group',group.id)+(careerOpen[group.id]?' open':'')+'>'
                +'<summary><span class="career-chevron" aria-hidden="true">▶</span><span class="career-group-heading">'
                +'<strong>'+group.title+'</strong><small>'+group.description+'</small></span>'
                +'<span class="career-count"'+attr('aria-label',items.length+' 条')+'>'+items.length+'</span></summary>'
                +'<div class="career-group-content">'+(items.map(item=>feedCard(item)).join('')||empty(group.empty))+'</div></details>';
        }).join('');
        return '<section class="card career-inbox">'+heading('求职总览',btn('refresh-feed','刷新来源'))
            +'<p class="career-intro">点击三角形或类别标题展开／收起列表。同一岗位可能同时有投递记录和跟进提醒。</p>'
            +(aux.loading?empty('正在读取来源状态…'):'')+(aux.integrationText?empty(aux.integrationText):'')+sections+'</section>';
    }
    function feed() {
        const career=page==='career',rows=state.external_items.filter(i=>career?['job','followup'].includes(i.kind):['news','repository'].includes(i.kind));
        if (career) return careerFeed(rows);
        const {picks,rest}=D.radarPicks(rows,date);
        const articles='<h3>每日精选 · '+esc(date)+'</h3><p class="meta">从当日读取的内容中，优先选择发布日期较近的条目；同日优先数据分析和 AI 主题。缺少发布日期时使用读取日期。</p>'
                +(picks.map(i=>feedCard(i,true)).join('') || empty('当天没有读取到可精选的内容。'))
                +'<details class="feed"><summary>资料列表 · '+rest.length+'</summary>'
                +(rest.map(i=>feedCard(i)).join('')||empty('没有其他已保存条目。'))+'</details>';
        return '<section class="card">'+heading('Radar feed',btn('refresh-feed','刷新来源'))
            +(aux.radarSummary?'<details class="feed"><summary>已保存的 Radar 摘要</summary><p class="note">'+esc(aux.radarSummary)+'</p></details>':'')
            +(aux.loading?empty('正在读取来源状态…'):'')+(aux.integrationText?empty(aux.integrationText):'')+articles+'</section>';
    }
    function insights() {
        const h = aux.health;
        if (!h || h.status === 'local_only' || h.error || h.errors?.length) {
            const message=h?.status === 'local_only' ? '健康记录、导入与每日自评仅可在你的 Mac 上使用。'
                : errorText(h?.error || h?.errors) || (aux.loading ? '正在读取本机记录…' : '本机健康数据暂不可用。');
            return '<section class="card">'+heading('Local health')+empty(message)+'</section>';
        }
        const summary = h ? Number(h.total_records || 0) + ' 条记录 · ' + Number(h.baseline?.valid_days || 0) + ' 天有效基线'
            : aux.loading ? '正在读取本机记录…' : '本机健康数据暂不可用。';
        const metrics = (h?.metrics || []).map(m => '<section class="card">' + heading(esc(m.label))
            + '<strong class="metric">' + esc(m.value ?? '—') + ' ' + esc(m.unit) + '</strong>'
            + '<p>' + esc(m.coverage_days) + ' 天覆盖</p></section>').join('');
        const fields = [['date','日期'],['sleep_hours','睡眠 h'],['steps','步数'],['exercise_minutes','运动 min'],
            ['resting_heart_rate','静息心率'],['hrv_sdnn_ms','HRV ms'],['energy','精力'],['stress','压力']];
        const daily = (h?.days || []).slice().reverse().map(day => '<tr>'
            + fields.map(([key]) => '<td>' + esc(day[key] ?? '—') + '</td>').join('') + '</tr>').join('');
        const table = '<div class="table-scroll"><table><thead><tr>' + fields.map(([,label]) => '<th>' + esc(label) + '</th>').join('')
            + '</tr></thead><tbody>' + daily + '</tbody></table></div>';
        const articles = (h?.insights || []).map(i => '<h3>' + esc(i.title) + '</h3><p>' + esc(i.body) + '</p>').join('');
        return '<div class="secondary"><section class="card span">' + heading('Local health', btn('health-import','导入 Apple Health'))
            + '<p>健康记录仅保存在本机。</p><p>' + esc(summary) + '</p>' + btn('checkin','记录当日感受') + '</section>'
            + metrics + '<section class="card span">' + heading('Daily observations') + (daily ? table : empty('暂无每日观察记录。'))
            + '</section><section class="card span">' + heading('Insights') + (articles || empty('记录积累后，可在这里查看趋势。')) + '</section></div>';
    }
    function aiPanel() {
        const ai = aux.ai;
        if (!ai) return heading('AI') + empty(aux.loading ? '正在读取预算…' : 'AI 状态暂不可用。');
        const budget = ai.monthly_cap_usd == null ? '' : '<p>本月已用或预留 USD '
            + Number(ai.spent_or_reserved_usd || 0).toFixed(2) + ' / ' + Number(ai.monthly_cap_usd).toFixed(2) + '</p>';
        const actions = ai.enabled ? '<div class="actions">' + btn('summarize','生成日摘要','day')
            + btn('summarize','生成周摘要','week') + '</div>' : '';
        return heading('AI') + '<p>' + esc(ai.enabled ? '公开来源摘要已启用' : '默认使用本地规则') + '</p>'
            + (ai.reason ? empty(ai.reason) : '') + budget + actions;
    }
    function jobVersion(label,record) {
        const stamps=[record?.start_at,record?.end_at].filter(stamp=>stamp && Number.isFinite(Date.parse(stamp)));
        const time=stamps.map(stamp=>D.wall(stamp)).join(' — ');
        return '<p><b>'+esc(label)+'</b> · '+esc(record?.title||'无标题')+(time?'<br><small>'+esc(time)+' · 墨尔本时间</small>':'')+'</p>';
    }
    function jobDetails(job) {
        const planner=state.time_blocks.find(block=>block.id===job.record_id);
        const local={...planner,...job};
        return jobVersion(job.operation==='delete'?'Small Plan · 移除日历事项':'Small Plan',local)
            +(job.conflict?jobVersion('Apple Calendar',job.conflict):'');
    }
    function calendarQueue(c) {
        if (!Array.isArray(c.jobs)) return '';
        const rows=c.jobs.map(job=>{
            const action=job.confirmation_queued ? empty('已确认以 Small Plan 为准，等待同步。') : job.conflict?.token
                ? btn('resolve-calendar','以 Small Plan 为准',job.id) : job.error ? empty('请检查日历连接与授权，再点击「立即同步」。') : '';
            return '<article class="feed">'+jobDetails(job)+(job.error?'<p class="error">'+esc(errorText(job.error))+'</p>':'')+action+'</article>';
        }).join('');
        return '<section class="sync-queue"><h3>待同步队列</h3>'+(rows||empty('没有待同步项目。'))+'</section>';
    }
    function settings() {
        const c = aux.calendar || {}, status = { authorized: c.configured === true ? '已连接' : '已授权 · 等待配置', denied: '未获授权', restricted: '系统限制', pending: '等待配置', unavailable: '当前不可用', write_only: '仅有写入权限' }[c.status] || '尚未读取';
        return '<div class="secondary"><section class="card">' + heading('Apple Calendar') + (discoveryMessage ? '<p role="status">' + esc(discoveryMessage) + '</p>' : '') + '<p>' + status + (c.pending_count != null ? ' · ' + Number(c.pending_count) + ' 项待同步' : '') + '</p>' + (c.error ? empty(c.error) : '') + '<div class="actions">' + (readOnly() ? cloudLink() : btn('discover', '选择日历') + btn('sync', '立即同步')) + '</div>' + calendarQueue(c) + '</section><section class="card">' + heading('Backup & export') + '<div class="actions"><a href="/api/export/backup" download>JSON 备份</a><a href="/api/export/ics" download>ICS</a><a href="/api/export/markdown?date=' + date + '&view=week" download>Markdown</a>' + btn('restore', '恢复备份') + '</div></section><section class="card">' + heading('Timer history') + (state.sessions.slice().sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, 20).map(s => btn('session-detail', esc(s.title || '计时') + ' · ' + esc(s.status), s.id, 'list-item')).join('') || empty('暂无计时记录。')) + '</section><section class="card">' + aiPanel() + '</section></div>';
    }
    function render() {
        if (!state && cacheUnavailable && page==='insights' && aux.health?.local_authority) {
            app.innerHTML='<main id="main">'+cacheBanner()+'<h1>本机健康记录</h1>'+insights()+btn('retry','重新读取计划缓存')+'</main>';return;
        }
        if (!state) {
            app.innerHTML = '<main class="loading"><h1>small<span>.</span>plan</h1><p>' + esc(notice || '正在打开你的计划…') + '</p>' + btn('retry', '重新连接') + (cacheUnavailable?btn('open-local-health','打开本机健康记录'):'') + '</main>';
            return;
        }
        const focused = document.activeElement?.closest('[data-do]'), focusKey = focused && app.contains(focused) ? [focused.dataset.do, focused.dataset.id] : null;

        const plannerPage = page === 'planner', dateLabel = view === 'month' && plannerPage ? short(date, { month:'long',year:'numeric' }) : view === 'week' && plannerPage ? short(D.week(date)[0]) + ' – ' + short(D.week(date)[6]) : short(date, { weekday: 'long', month: 'long', day: 'numeric' });
        app.innerHTML = '<header class="appbar"><a class="wordmark" href="#" data-do="nav" data-id="planner">small<span>.</span>plan</a><nav aria-label="主导航">' + Object.entries(pages).map(([key, label]) => btn('nav', label, key, page === key ? 'current' : '')).join('') + '</nav><div class="timer">' + timer() + '</div></header><main id="main">' + cacheBanner() + '<div class="pagehead"><div><p class="kicker">' + (plannerPage ? 'MELBOURNE · ' + date.slice(0, 4) : short(date, {month:'long', year:'numeric'})) + '</p><h1>' + (plannerPage ? dateLabel : pages[page]) + '<em>.</em></h1></div><div class="heading-controls"><button type="button" class="sync-label" data-do="nav" data-id="settings"><i></i>' + esc(timerQueue.length ? (readOnly() ? '本机队列已保留' : '计时待同步') : lastSync || '本地计划') + '</button><div class="date-nav">' + btn('prev', '‹', '', 'icon', '上一个时段') + btn('today', '今天') + btn('next', '›', '', 'icon', '下一个时段') + '<input aria-label="选择日期" type="date" value="' + date + '" id="date-picker"></div></div></div>' + (notice ? '<div class="banner" role="alert">' + esc(notice) + ' ' + btn('retry', '刷新') + (timerQueue.length ? btn('queue', '检查计时队列') : '') + '</div>' : '') + (plannerPage ? '<div class="mobile-tabs">' + [['today', '今天'], ['calendar', '日历'], ['routines', '习惯']].map(([k, t]) => btn('mobile', t, k, mobile === k ? 'selected' : '')).join('') + '</div>' + planner() : page === 'overview' ? overview() : page === 'study' ? study() : page === 'insights' ? insights() : page === 'settings' ? settings() : feed()) + '</main>';
        const next = app.querySelector('.grid-scroll');
        if (next) {
            const restoreScroll = () => {
                if (next.isConnected && next.clientHeight > 0) next.scrollTop = scrollTop;
            };
            restoreScroll();
            window.requestAnimationFrame?.(restoreScroll);
            next.addEventListener('scroll', () => {
                if (next.isConnected && next.clientHeight > 0) scrollTop = next.scrollTop;
            }, {passive:true});
        }
        if (focusKey) {
            const match = Array.from(app.querySelectorAll('[data-do]')).find(e => e.dataset.do === focusKey[0] && e.dataset.id === focusKey[1]);
            match?.focus({ preventScroll: true });
        }
        tick();
    }
    async function context() {
        const where = page, day = date;
        aux = { loading: true };
        render();
        const data = {};
        try {
            if (where === 'overview') {
                const m = D.month(day);
                data.overview = await api('/api/v2/overview?from=' + m[0] + '&to=' + m.at(-1));
                if(data.overview.by_day) {
                    const previous=D.month(D.add(m[0],-1));
                    data.previousOverview=await api('/api/v2/overview?from='+previous[0]+'&to='+previous.at(-1));
                }
            }
            if (where === 'settings') {
                data.calendar = await api('/api/calendar/status');
                data.ai = await api('/api/ai/status');
                lastSync = calendarLabel(data.calendar);
            }
            if (where === 'insights')
                data.health = await api('/api/health-local/summary');
            if (['career', 'radar', 'study'].includes(where)) {
                const all = await api('/api/integrations/status');
                const s = all[where];
                data.cloud=Boolean(all.cloud);
                data.integrationReady=true;
                data.integrationText=errorText(s?.error || s?.errors) || errorText(s?.message) ||
                    (s?.status==='pending' ? queueMessage : '');
                if (where === 'study') data.study = s;
                if (where === 'radar') data.radarSummary = typeof s?.ai_summary === 'string' ? s.ai_summary : s?.ai_summary?.text;
            }
        }
        catch (e) {
            if (where === page && day === date)
                notice = e.message;
        }
        if (where === page && day === date) {
            aux = data;
            render();
        }
    }
    async function navigate(day = date, target = page) {
        const changedPage=target!==page;
        date = day;
        page = target;
        notice = '';
        aux = { loading: true };
        await reload();
        await context();
        if(changedPage) window.scrollTo?.({top:0});
    }
    function taskForm(id) {
        const r = by('tasks', id) || {};
        dialog(id ? '编辑任务' : '新任务', field('title', '任务名称', r.title) + categories(r.category_id) + field('local_date', '日期', r.local_date || date, 'date') + field('estimate_minutes', '预计分钟', r.estimate_minutes || 30, 'number') + select('priority', '优先级', [['normal', '普通'], ['high', '优先']], r.priority) + area('description_md', '备注', r.description_md) + (id ? btn('delete-task', '删除任务', id, 'danger') : ''), async (f) => command('task.upsert', {
            ...f, id: id || undefined, estimate_minutes: Number(f.estimate_minutes), category_id: f.category_id || null, status: r.status || 'todo'
        }));
    }
    function routineForm(id) {
        const r = by('routines', id) || {};
        dialog(id ? '编辑习惯' : '新习惯', (id ? '<p class="meta">更改会用于今后新生成的习惯记录。今天和过去已生成的记录保留当时的名称、分类与安排。</p>' : '') + field('title', '习惯名称', r.title) + categories(r.category_id) + '<fieldset><legend>重复日期</legend>' + weekdays.map((w, i) => '<label class="inline"><input type="checkbox" name="weekday" value="' + i + '" ' + (!id || r.days_of_week.includes(i) ? 'checked' : '') + '>周' + w + '</label>').join('') + '</fieldset>' + field('reminder_time', '提示时间', r.reminder_time, 'time', false) + area('description_md', '备注', r.description_md) + select('enabled', '状态', [['yes', '启用'], ['no', '暂停']], r.active === false ? 'no' : 'yes'), async (f, fd) => command('routine.upsert', {
            id: id || undefined, title: f.title, category_id: f.category_id || null, description_md: f.description_md, reminder_time: f.reminder_time || null, days_of_week: fd.getAll('weekday').map(Number), active: f.enabled === 'yes', sort_order: r.sort_order || 0
        }));
    }
    function manage() {
        dialog('分类与习惯', heading('分类', btn('category', '＋ 分类')) + state.categories.map(c => btn('category', esc(c.name), c.id, 'list-item')).join('') + heading('习惯', btn('edit-routine', '＋ 习惯')) + state.routines.map(r => btn('edit-routine', esc(r.title) + (r.active ? '' : ' · 已暂停'), r.id, 'list-item')).join(''));
    }
    function blockForm(kind, id, defaults = {}) {
        const b = kind === 'block' ? by('time_blocks', id) : null;
        const task = kind === 'task' ? id : b?.task_id, assessment = b?.assessment_id, occ = kind === 'occurrence' ? id : b?.occurrence_id;
        const vals = {
            local_date: b?.local_date || date, start_local: b?.start_local || '09:00', end_date: b?.end_date || b?.local_date || date, end_local: b?.end_local || '09:30', ...defaults
        };
        const options = [...state.tasks.map(t => ['t:' + t.id, t.title]), ...state.assessments.map(a => ['a:' + a.id, a.title]), ...state.occurrences.filter(o => o.local_date === vals.local_date || o.id === occ).map(o => ['o:' + o.id, o.title])];
        if (!options.length) {
            dialog('安排时间', empty('请先添加一个任务或习惯。') + btn('edit-task', '＋ 新任务'));
            return;
        }
        dialog('安排时间', select('subject', '任务或习惯', options, occ ? 'o:' + occ : assessment ? 'a:' + assessment : 't:' + task) + field('local_date', '开始日期', vals.local_date, 'date') + field('start_local', '开始时间', vals.start_local, 'time') + field('end_date', '结束日期', vals.end_date, 'date') + field('end_local', '结束时间', vals.end_local, 'time') + (b ? btn('delete-block', '移除时间块', b.id, 'danger') : ''), async (f) => {
            const { subject, ...fields } = f;
            const target = subject.slice(2);
            await command('block.upsert', {
                ...fields, id: b?.id, occurrence_id: subject.startsWith('o:') ? target : null, task_id: subject.startsWith('t:') ? target : null, assessment_id: subject.startsWith('a:') ? target : null
            });
        });
    }
    function studyForm(kind, id) {
        const r = by(kind === 'course' ? 'courses' : 'assessments', id) || {};
        if (kind === 'course') {
            dialog('课程', field('name', '课程名称', r.name) + field('color', '颜色', r.color || '#879d82', 'color'), f => command('course.upsert', { ...f, id: id || undefined }));
            return;
        }
        const allDay = r.due_at?.length === 10;
        let due = r.due_at ? (/[zZ]|[+-]\d\d:\d\d$/.test(r.due_at) ? D.wall(r.due_at).replace(' ', 'T') : r.due_at.slice(0, 16)) : date + 'T17:00';
        dialog('截止事项', field('title', '名称', r.title) + select('course_id', '课程', [['', '无课程'], ...state.courses.map(c => [c.id, c.name])], r.course_id || '') + field('due_date', '墨尔本截止日期', due.slice(0, 10), 'date') + field('due_time', '截止时间（全天可留空）', allDay ? '' : due.slice(11, 16), 'time', false) + field('estimate_minutes', '预计分钟', r.estimate_minutes || 60, 'number') + select('status', '状态', [['todo', '待办'], ['done', '完成'], ['archived', '归档']], r.status || 'todo'), f => command('assessment.upsert', {
            id: id || undefined, title: f.title, status: f.status, due_at: f.due_date + (f.due_time ? 'T' + f.due_time : ''), course_id: f.course_id || null, estimate_minutes: Number(f.estimate_minutes)
        }));
    }
    function completion(s) {
        if (!s?.task_id && !s?.occurrence_id)
            return;
        const isTask = Boolean(s.task_id), r = by(isTask ? 'tasks' : 'occurrences', s.task_id || s.occurrence_id);
        if (!r || r.status === 'done')
            return;
        dialog('要标记完成吗？', '<p>' + esc(r.title) + '</p><p>计时已停止。你可以单独记录完成状态。</p>', () => setDone(r, isTask, true), '标记完成');
    }
    function setDone(r, isTask, done) {
        return command(isTask ? 'task.upsert' : 'occurrence.set', isTask ? {
            id: r.id, title: r.title, description_md: r.description_md, category_id: r.category_id, local_date: r.local_date, priority: r.priority, estimate_minutes: r.estimate_minutes || 30, status: done ? 'done' : 'todo'
        } : { id: r.id, status: done ? 'done' : 'todo' });
    }
    async function auxPost(path, payload) {
        const result = await api(path, payload);
        if((readOnly() || (!state && cacheUnavailable)) && path.startsWith('/api/health-local/')) {
            aux.health=await api('/api/health-local/summary');render();return result;
        }
        await reload();
        await context();
        if (result.queued) say(queueMessage);
        return result;
    }
    function calendarLabel(c) {
        if (c.error)
            return '日历需要检查';
        if (c.pending_count)
            return '待同步 ' + Number(c.pending_count) + ' 项';
        if (c.status === 'authorized' && c.configured === true)
            return '日历已连接';
        return '日历待连接';
    }
    async function discoverCalendars() {
        if (discovering) return;
        discovering = true;
        const path = '/api/calendar/discover';
        const waiting = '发现请求已排队，正在等待 Mac 返回日历…';
        const pending = '请求仍在等待 Mac。请确认 Mac 在线，稍后再试。';
        try {
            let result = discoveryJob ? {queued:true,id:discoveryJob} : await api(path,{});
            if (result.queued || (result.id && result.status==='pending')) {
                discoveryJob=result.id;
                discoveryMessage=discoveryJob ? waiting : pending;
                if (page==='settings') render();
                if (!discoveryJob) return;
                const deadline=Date.now()+30000;
                for (let attempt=0; attempt<15 && Date.now()<deadline; attempt++) {
                    await new Promise(resolve=>setTimeout(resolve,Math.min(2000,Math.max(0,deadline-Date.now()))));
                    if (page!=='settings') { discoveryMessage=pending; return; }
                    const remaining=deadline-Date.now();
                    if (remaining<=0) break;
                    const signal=globalThis.AbortSignal?.timeout?.(remaining);
                    try { result=await api(path+'?id='+encodeURIComponent(discoveryJob),undefined,signal); }
                    catch (error) {
                        if(signal?.aborted) break;
                        if(error.status===404) discoveryJob=null;
                        throw error;
                    }
                    if (!result.queued && result.status!=='pending') break;
                }
                if (result.queued || result.status==='pending') {
                    discoveryMessage=pending;
                    if (page==='settings') render();
                    return;
                }
            }
            if (discoveryJob && (page!=='settings' || modal.open)) {
                discoveryMessage='Mac 已返回日历。点击「选择日历」查看。';
                if (page==='settings') render();
                return;
            }
            discoveryJob=null;
            discoveryMessage='';
            if (page!=='settings') return;
            render();
            if (!result.calendars?.length && !result.sources?.length)
                throw new Error(errorText(result.error || result.message) || '没有找到可连接的日历。请检查系统授权。');
            calendarConfig(result);
        } catch (error) {
            discoveryMessage=discoveryJob ? pending : '';
            if(page==='settings') throw error;
        } finally { discovering=false; }
    }
    function calendarConfig(d) {
        const calendars = (d.calendars || []).filter(c => !c.owned), sources = (d.sources || []).filter(s => s.type === 'icloud' && s.writable);
        dialog('连接 Apple Calendar', '<fieldset><legend>读取这些日历</legend>' + calendars.map(c => '<label class="inline"><input type="checkbox" name="calendar"' + attr('value', c.id) + ((aux.calendar?.selected_ids || []).includes(c.id) ? ' checked' : '') + '>' + esc(c.title) + '</label>').join('') + '</fieldset>' + select('source_id', 'Plan / Actual 的 iCloud 来源', [['', '请选择'], ...sources.map(s => [s.id, s.title])], aux.calendar?.source_id || ''), async (f, fd) => auxPost('/api/calendar/configure', { source_id: f.source_id, selected_ids: fd.getAll('calendar') }));
    }
    async function action(name, id, el) {
        if(readOnly() && !cacheActions.has(name)) throw new Error(cacheNotice);
        if(name==='open-local-health') {
            const health=await api('/api/health-local/summary');
            if(!health.local_authority) throw new Error('本机计划服务尚未就绪。');
            page='insights';aux={health};render();return;
        }
        if (name === 'close') {
            modal.close();
            return;
        }
        if (name === 'trend') { if(['day','week'].includes(id)) trendPeriod=id;render();return; }
        if (name === 'tracker-detail') {
            const [day,categoryId] = id.split('|');
            const historical=D.categoryDay(state,day,categoryId||null);
            if(historical.legacy) {
                dialog(category(categoryId).name+' · '+day,empty(markLabel(historical)));
                return;
            }
            const records = state.occurrences.filter(o=>o.local_date===day && (o.category_id||'')===categoryId);
            const labels = {done:'已完成',skipped:'已跳过',todo:'待完成'};
            dialog(category(categoryId).name+' · '+day, records.length
                ? '<p>'+records.filter(o=>o.status==='done').length+' / '+records.length+' 已完成</p>'
                    + records.map(o=>'<p>'+esc(o.title)+' · '+esc(labels[o.status])+'</p>').join('')
                : empty('无应做记录。'));
            return;
        }
        if (name === 'category-timer') {
            if (active()) throw new Error('请先停止当前计时。');
            await command('session.start',{id:crypto.randomUUID(),category_id:id||null,title:category(id).name});
            return;
        }
        if (name === 'refresh-form') {
            await reload();
            notice = '';
            modal.querySelector('[role=alert]').textContent = '已读取最新版本。请核对草稿后再次保存。';
            el.hidden = true;
            render();
            return;
        }
        if (name === 'retry') {
            if(readOnly() || cacheUnavailable) {await reload();await context();return;}
            await replay();
            await context();
            return;
        }
        if (name === 'nav') {
            await navigate(date, id);
            return;
        }
        if (name === 'view') {
            view = id;
            render();
            return;
        }
        if (name === 'mobile') {
            mobile = id;
            render();
            return;
        }
        if (name === 'today' || name === 'day') {
            await navigate(name === 'today' ? today() : id);
            return;
        }
        if (name === 'prev' || name === 'next') {
            const direction = name === 'next' ? 1 : -1;
            if ((view === 'month' && page === 'planner') || page === 'overview') {
                const d = new Date(date.slice(0, 7) + '-01T12:00Z');
                d.setUTCMonth(d.getUTCMonth() + direction);
                await navigate(d.toISOString().slice(0, 10));
            }
            else
                await navigate(D.add(date, direction * (view === 'week' && page === 'planner' ? 7 : 1)));
            return;
        }
        if (name === 'edit-task') {
            taskForm(id);
            return;
        }
        if (name === 'edit-routine') {
            routineForm(id);
            return;
        }
        if (name === 'edit-occurrence') {
            routineForm(by('occurrences', id).routine_id);
            return;
        }
        if (name === 'manage') {
            manage();
            return;
        }
        if (name === 'category') {
            const c = by('categories', id) || {};
            dialog('分类', field('name', '名称', c.name) + field('color', '颜色', c.color || '#83987b', 'color'), f => command('category.upsert', { ...f, id: id || undefined, sort_order: c.sort_order || 0 }));
            return;
        }
        if (name === 'note') {
            const n = state.daily_notes.find(n => n.local_date === date) || {};
            dialog('每日重点和笔记', area('focus', '今日重点', n.focus) + area('note_md', '笔记', n.note_md), f => command('note.upsert', { ...f, local_date: date }));
            return;
        }
        if (name === 'toggle-task' || name === 'toggle-occurrence') {
            const task = name === 'toggle-task', r = by(task ? 'tasks' : 'occurrences', id);
            await setDone(r, task, r.status !== 'done');
            return;
        }
        if (name === 'skip') {
            const r = by('occurrences', id);
            await command('occurrence.set', { id, status: r.status === 'skipped' ? 'todo' : 'skipped' });
            return;
        }
        if (name === 'block' || name.startsWith('arrange-')) {
            blockForm(name === 'block' ? 'block' : name.slice(8), id);
            return;
        }
        if (name === 'delete-block' || name === 'delete-task') {
            dialog('确认删除', empty(name === 'delete-block' ? '这个时间块将从日程中移除。' : '任务和关联计划块将被移除。'), () => command(name === 'delete-block' ? 'block.delete' : 'task.delete', { id }), '确认删除');
            return;
        }
        if (name.startsWith('start-')) {
            const kind = name.slice(6);
            if (active())
                throw new Error('请先停止当前计时。');
            if (kind === 'category') {
                dialog('开始计时', categories('') + field('title', '记录名称', ''), f => command('session.start', { id: crypto.randomUUID(), category_id: f.category_id || null, title: f.title }), '开始');
                return;
            }
            await command('session.start', { id: crypto.randomUUID(), [kind + '_id']: id });
            return;
        }
        if (['pause', 'resume', 'stop'].includes(name)) {
            const s = active();
            const saved = await command('session.' + name, { id });
            if (saved && name === 'stop') {
                const result = by('sessions', id);
                if (result?.status === 'needs_review')
                    await action('session-detail', id);
                else
                    completion(s);
            }
            return;
        }
        if (name === 'session-detail') {
            const s = by('sessions', id), review = !readOnly() && (s.needs_review || /review/.test(s.status));
            dialog(s.title || '计时记录', '<p>' + esc(s.status) + '</p>' + s.segments.map(x => '<p>' + esc(D.wall(x.start)) + ' → ' + (x.end ? esc(D.wall(x.end)) : '进行中') + '</p>').join('') + (review ? field('end_at', '确认结束时刻（含时区）', s.ended_at || new Date().toISOString()) : ''), review ? async (f) => {
                await command('session.review', { id, end_at: f.end_at });
                if (s.task_id || s.occurrence_id) {
                    modal.close();
                    completion(s);
                    return 'keep';
                }
            } : null, '确认时长');
            return;
        }
        if (name === 'event-detail') {
            const e = by('external_events', id);
            dialog(e.title || '外部日历', '<p>' + esc(D.wall(e.start_at)) + ' — ' + esc(D.wall(e.end_at)) + '</p>');
            return;
        }
        if (name === 'queue') {
            dialog('待同步计时操作', timerQueue.map(x => '<p>' + esc(x.type) + ' · ' + esc(x.effective_at || '') + '</p>').join('') + (readOnly()?'<p>对照以下原始操作在云端手动核对。</p><pre class="held-ops">'+esc(JSON.stringify(timerQueue,null,2))+'</pre>':btn('retry-queue', '重试') + btn('discard-queue', '放弃本机待同步操作', '', 'danger')));
            return;
        }
        if (name === 'retry-queue') {
            modal.close();
            await replay();
            return;
        }
        if (name === 'discard-queue') {
            dialog('放弃尚未同步的计时操作？', empty('服务器上的计时记录会保留。'), async () => {
                timerQueue = [];
                saveQueue();
                await reload();
                notice = '';
                render();
            }, '确认放弃');
            return;
        }
        if (name === 'course' || name === 'assessment') {
            studyForm(name, id);
            return;
        }
        if (name === 'refresh-study') {
            const result=await auxPost('/api/study/refresh',{});
            say(result.queued || result.status==='pending' ? queueMessage : '订阅已刷新');
            return;
        }
        if (name === 'subscribe') {
            if (!aux.integrationReady || aux.cloud || aux.study?.local_subscription_setup) throw new Error('请在 Mac 上配置私有订阅。');
            dialog('订阅课程日历',field('url','私有 ICS 订阅链接','','url') +
                select('course_id','课程',[['','无课程'],...state.courses.map(c=>[c.id,c.name])],''),
                f=>auxPost('/api/study/subscribe',{url:f.url,course_id:f.course_id || null}),'订阅');
            return;
        }
        if (name === 'summarize') {
            if (!aux.ai?.enabled || !['day','week'].includes(id)) throw new Error('公开来源摘要尚未启用。');
            const result=await api('/api/ai/summarize',{period:id});
            await context();
            dialog(id==='week'?'每周公开来源摘要':'每日公开来源摘要',
                (result.cached ? '<p>已保存的摘要</p>' : '') + '<p class="note">'+esc(result.text)+'</p>');
            return;
        }
        if (name === 'study-import') {
            dialog('导入课程截止事项', select('format', '文件格式', [['csv', 'CSV'], ['ics', 'ICS']], 'csv') + select('course_id', '课程', [['', '无课程'], ...state.courses.map(c => [c.id, c.name])], '') + '<label>文件<input type="file" name="file" accept=".csv,.ics" required></label>', async (f, fd) => auxPost('/api/study/import', { format: f.format, course_id: f.course_id || null, content: await fd.get('file').text() }), '导入');
            return;
        }
        if (name === 'suggest') {
            proposal = await api('/api/plan/suggest?date=' + date);
            dialog('排程建议 · ' + date, '<p>可用容量 ' + Number(proposal.capacity_minutes || 0) + ' 分钟</p>' + (proposal.items || []).map(i => '<p>' + esc(i.start_local) + ' – ' + esc(i.end_local) + ' · ' + esc(i.title || by('tasks', i.task_id)?.title || by('assessments', i.assessment_id)?.title || '计划') + '</p>').join('') + (proposal.reasons || []).map(s => '<p>' + esc(s) + '</p>').join('') + (!proposal.items?.length ? empty('当前没有可安排的事项。') : ''), proposal.items?.length ? () => command('plan.accept', { date: proposal.date, items: proposal.items }) : null, '确认加入计划');
            return;
        }
        if (name === 'refresh-feed') {
            const r = await auxPost('/api/integrations/' + page + '/refresh', {});
            if (r.errors?.length)
                throw new Error(errorText(r.errors));
            say(r.queued || r.status==='pending' ? queueMessage : '来源已刷新');
            return;
        }
        if (name === 'external-task') {
            await command('external.add_task', { id, local_date: date });
            say('已加入当日任务');
            return;
        }
        if (['health-import','checkin'].includes(name) && (!aux.health || aux.health.status==='local_only' || aux.health.error || aux.health.errors?.length))
            throw new Error('请在 Mac 上打开本机健康记录。');
        if (name === 'health-import') {
            dialog('导入本机健康记录', field('path', '本机 Apple Health 导出文件路径', ''), f => auxPost('/api/health-local/import', f), '导入');
            return;
        }
        if (name === 'checkin') {
            const scale = Array.from({ length: 5 }, (_, i) => [String(i + 1), String(i + 1)]);
            dialog('每日自评', field('local_date', '日期', date, 'date') + select('energy', '精力（1 低，5 高）', scale, '3') + select('stress', '压力（1 低，5 高）', scale, '3') + area('notes', '本机备注'), f => auxPost('/api/health-local/checkin', { ...f, energy: Number(f.energy), stress: Number(f.stress) }));
            return;
        }
        if (name === 'resolve-calendar') {
            const job=aux.calendar?.jobs?.find(j=>j.id===id);
            if(!job?.conflict?.token || job.confirmation_queued) throw new Error('请刷新队列，查看最新冲突状态。');
            const token=job.conflict.token;
            dialog('确认以 Small Plan 为准？',jobDetails(job)+'<p>下一次同步将按上面的 Small Plan 操作更新 Apple Calendar。</p>',
                async()=>{
                    await auxPost('/api/calendar/resolve',{job_id:job.id,token,action:'use_planner'});
                    say('已加入待同步队列。点击「立即同步」执行。');
                },'以 Small Plan 为准');
            return;
        }
        if (name === 'sync') {
            const r = await auxPost('/api/calendar/sync', {});
            if (r.error)
                throw new Error(errorText(r.error));
            say(r.queued || r.status==='pending' ? queueMessage : '同步已结束');
            return;
        }
        if (name === 'restore') {
            dialog('恢复计划备份', '<label>JSON 备份文件<input type="file" name="file" accept=".json" required></label>', async (f, fd) => {
                const backup = JSON.parse(await fd.get('file').text());
                if (!Array.isArray(backup.tasks))
                    throw new Error('备份没有任务清单。');
                dialog('确认替换当前计划？', '<p>备份包含 ' + backup.tasks.length + ' 个任务。恢复前会保留本地安全备份。</p>', () => auxPost('/api/restore', { backup, expected_revision: state.revision, revision: state.revision }), '确认恢复');
                return 'keep';
            }, '查看备份');
        }
    }
    let drag, suppressClickUntil = 0;
    function placement(e) {
        const c = document.elementFromPoint(e.clientX, e.clientY)?.closest('.day-column');
        if (!c)
            return null;
        const box = c.getBoundingClientRect(), position = (e.clientY - box.top) / box.height * 1440;
        return { column: c, day: c.dataset.day, position };
    }
    function clearDrag() {
        document.querySelector('.drop-marker')?.remove();
        document.body.classList.remove('dragging');
        drag = null;
    }
    document.addEventListener('pointerdown', e => {
        const grip = e.target.closest('[data-grip]');
        if (readOnly() || !grip || e.button !== 0 || e.isPrimary === false || drag || locked)
            return;
        const event = grip.closest('.event'), offset = grip.dataset.grip === 'block' && event ? (e.clientY - event.getBoundingClientRect().top) / event.closest('.day-column').getBoundingClientRect().height * 1440 : 0;
        drag = { kind: grip.dataset.grip, id: grip.dataset.id, pointer: e.pointerId, x: e.clientX, y: e.clientY, offset, started: false };
        grip.setPointerCapture(e.pointerId);
    });
    document.addEventListener('pointermove', e => {
        if (!drag || drag.pointer !== e.pointerId)
            return;
        if (!drag.started && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5)
            return;
        drag.started = true;
        document.body.classList.add('dragging');
        document.querySelector('.drop-marker')?.remove();
        const p = placement(e);
        if (!p)
            return;
        const marker = document.createElement('span');
        marker.className = 'drop-marker';
        const snapped = drag.kind === 'resize' ? Math.min(1440,Math.max(0,Math.round(p.position/15)*15))
            : D.minutes(D.slot(p.day,p.position-drag.offset,15).start_local);
        marker.style.top = Math.min(99,snapped/14.4) + '%';
        marker.textContent = snapped === 1440 ? '24:00' : D.clock(snapped);
        p.column.append(marker);
        const scroll = p.column.closest('.grid-scroll'), rect = scroll.getBoundingClientRect();
        if (e.clientY < rect.top + 28)
            scroll.scrollTop -= 16;
        else if (e.clientY > rect.bottom - 28)
            scroll.scrollTop += 16;
    });
    const cancelPointer = e => { if (drag?.pointer === e.pointerId) clearDrag(); };
    document.addEventListener('pointercancel', cancelPointer);
    document.addEventListener('lostpointercapture', cancelPointer);
    window.addEventListener('blur', clearDrag);
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape')
            clearDrag();
    });
    document.addEventListener('pointerup', async (e) => {
        if (!drag || drag.pointer !== e.pointerId)
            return;
        const d = drag, p = placement(e);
        clearDrag();
        if (!d.started)
            return;
        suppressClickUntil = Date.now() + 350;
        if (!p || locked)
            return;
        const block = ['block', 'resize'].includes(d.kind) ? by('time_blocks', d.id) : null;
        let duration = block ? (Date.parse((block.end_date || block.local_date) + 'T' + block.end_local + 'Z') - Date.parse(block.local_date + 'T' + block.start_local + 'Z')) / 60000 : by('tasks', d.id)?.estimate_minutes || 30;
        let fields = D.slot(p.day, p.position - d.offset, duration);
        if (d.kind === 'resize') {
            const snap = Math.max(0, Math.min(1440, Math.round(p.position / 15) * 15));
            fields = {
                local_date: block.local_date, start_local: block.start_local, end_date: snap === 1440 ? D.add(p.day, 1) : p.day, end_local: D.clock(snap)
            };
        }
        const payload = {
            ...fields, id: block?.id, task_id: block?.task_id || (d.kind === 'task' ? d.id : undefined), occurrence_id: block?.occurrence_id || (d.kind === 'occurrence' ? d.id : undefined)
        };
        locked = true;
        try {
            await command('block.upsert', payload);
        }
        catch (e) {
            fail(e);
        }
        finally {
            locked = false;
        }
    });
    document.addEventListener('toggle', e => {
        const target=e.target, id=target?.dataset?.careerGroup;
        if (!careerGroups.some(group=>group.id===id) || !app.contains(target)) return;
        careerOpen[id]=target.open;
        try { localStorage.setItem(careerOpenKey,JSON.stringify(careerOpen)); } catch { /* Keep the current page usable. */ }
    }, true);
    document.addEventListener('click', async (e) => {
        if (Date.now() < suppressClickUntil)
            return;
        const keyboardGrip = e.detail === 0 && e.target.closest('[data-grip]');
        if (keyboardGrip && !readOnly()) {
            const k = keyboardGrip.dataset.grip;
            blockForm(k === 'resize' ? 'block' : k, keyboardGrip.dataset.id);
            return;
        }
        const el = e.target.closest('[data-do]');
        if (!el) {
            const p = e.target.closest('.day-column') && placement(e);
            if (p && !readOnly())
                blockForm('new', '', D.slot(p.day, p.position, 30));
            return;
        }
        e.preventDefault();
        if (el.dataset.do==='discover' && !locked && !readOnly()) {
            try { await discoverCalendars(); } catch(error) { fail(error); }
            return;
        }
        if (locked)
            return;
        locked = true;
        el.setAttribute('aria-busy', 'true');
        try {
            await action(el.dataset.do, el.dataset.id, el);
        }
        catch (e) {
            fail(e);
        }
        finally {
            locked = false;
            el.removeAttribute('aria-busy');
        }
    });
    modal.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (locked || !formHandler)
            return;
        locked = true;
        const form = e.target, fd = new FormData(form), submit = form.querySelector('[type=submit]');
        submit.disabled = true;
        try {
            const result = await formHandler(Object.fromEntries(fd), fd);
            if (result !== 'keep')
                modal.close();
        }
        catch (e) {
            fail(e);
        }
        finally {
            locked = false;
            submit.disabled = false;
        }
    });
    document.addEventListener('change', async (e) => {
        if (e.target.id === 'date-picker' && e.target.value)
            try {
                await navigate(e.target.value);
            }
            catch (err) {
                fail(err);
            }
    });
    window.addEventListener('online', () => {
        if (!locked)
            replay().catch(fail);
    });
    setInterval(() => {
        if (timerQueue.length && !readOnly() && !locked && retryOnTimer && !replaying) replay().catch(fail);
    }, 30000);
    setInterval(tick, 1000);
    render();
    (async () => {
        await reload();
        if (timerQueue.length && !readOnly())
            await replay();
        const c = await api('/api/calendar/status');
        lastSync = calendarLabel(c);
        render();
    })().catch(fail);
})();
