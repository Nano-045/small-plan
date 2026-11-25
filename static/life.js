'use strict';
(() => {
    const D = LifeDomain, app = document.querySelector('#app'), modal = document.querySelector('#modal'), toast = document.querySelector('#toast');
    const today = () => D.wall(Date.now()).slice(0, 10);
    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const color = value => /^#[a-f0-9]{3,8}$/i.test(value) ? value : '#75866c';
    const short = (date, opts = { month: 'short', day: 'numeric' }) => new Intl.DateTimeFormat('en-AU', { ...opts, timeZone: 'UTC' }).format(new Date(date + 'T12:00Z'));
    const pages = {
        overview: 'Overview', study: 'Study', career: 'Career', radar: 'Radar', insights: 'Insights', settings: 'Settings'
    };
    const careerGroups = [
        { id: 'opportunities', title: '待考虑岗位', description: '每日摘要中的候选岗位，展开查看并打开原始来源。', empty: '暂时没有待考虑的岗位。' },
        { id: 'followups', title: '待跟进', description: '按跟进日期排列，查看接下来需要联系或确认的事项。', empty: '暂时没有已安排日期的跟进提醒。' },
        { id: 'progress', title: '投递进度', description: '投递状态与跟进历史；状态请在 career-ops 中更新。', empty: '暂时没有投递或历史跟进记录。' }
    ];
    const careerOpenKey = 'small-plan-career-sections', careerOpen = {};
    try {
        const saved = JSON.parse(localStorage.getItem(careerOpenKey) || '{}');
        for (const group of careerGroups)
            if (typeof saved?.[group.id] === 'boolean') careerOpen[group.id] = saved[group.id];
    } catch { /* Disclosures still work when browser storage is unavailable. */ }
    const routineOpenKey='small-plan-routine-sections';
    let routineOpen={};
    try {
        const saved=JSON.parse(localStorage.getItem(routineOpenKey)||'{}');
        if(saved && typeof saved==='object' && !Array.isArray(saved))
            routineOpen=Object.fromEntries(Object.entries(saved).filter(([,open])=>typeof open==='boolean'));
    } catch { /* Routine checks remain usable without saved disclosure preferences. */ }
    const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
    let date = today(), page = 'overview', state, notice = '', locked = false, formHandler, discoveryJob, discovering = false, discoveryMessage = '';
    let cacheUnavailable=false;
    let replaying, retryOnTimer = true, trendPeriod = 'week';
    let routeSequence = 0, aux = {}, timerQueue = [], lastSync = '', toastTimeout;
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
    const cacheActions=new Set(['nav','trend','today','day','prev','next','retry','close','tracker-detail',
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
        if (!mark.legacy) return dotLabels[mark.status]+(mark.total?' · '+mark.done+'/'+mark.total+' · '+Math.round(mark.progress*100)+'%':'');
        const legacyLabels={solid:'已打卡',none:'未打卡',na:'无历史记录'};
        return '旧版分类打卡（只读） · '+legacyLabels[mark.status];
    }
    const progressStyle=mark=>'--progress:'+((mark.progress||0)*100).toFixed(3)+'%';
    const dot=(mark,label)=>'<span class="dot '+mark.status+'" role="img"'+attr('style',progressStyle(mark))
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
                    if(page==='overview') await context();
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
        if(page==='overview') await context();
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
        if(page==='overview') await context();
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
    function groups() {
        const days=D.month(date),first=D.week(days[0])[0],last=D.week(days.at(-1))[6];
        const historicalCategories=new Set((state.category_checks||[]).filter(check=>
            check.local_date<state.rollout_date && check.local_date>=first && check.local_date<=last).map(check=>check.category_id));
        const result = state.categories.filter(c=>!c.archived_at || historicalCategories.has(c.id) || state.occurrences.some(o=>o.category_id===c.id));
        if (state.occurrences.some(o => !o.category_id) || state.routines.some(r => !r.category_id))
            result.push({ id: null, name: '未分类', color: '#948b7e' });
        return result;
    }
    function routineBoard() {
        const activeGroups=state.categories.filter(c=>!c.archived_at).sort((a,b)=>a.sort_order-b.sort_order);
        const cards=activeGroups.map(c=>{
            const due=state.occurrences.filter(o=>o.local_date===date && o.category_id===c.id)
                .sort((a,b)=>(by('routines',a.routine_id)?.sort_order||0)-(by('routines',b.routine_id)?.sort_order||0));
            const mark=D.categoryDay(state,date,c.id), percent=Math.round(mark.progress*100);
            const caption=mark.legacy?markLabel(mark):mark.total?mark.done+'/'+mark.total+' 已完成':'当天无应做项';
            const templates=state.routines.filter(r=>r.category_id===c.id);
            const notes=[...new Set(templates.map(r=>r.description_md).filter(Boolean))];
            const rows=due.map(o=>{
                const done=o.status==='done';
                return '<button type="button" class="routine-check'+(done?' finished':'')+'" role="checkbox"'
                    +attr('aria-checked',String(done))+' data-do="toggle-occurrence"'+attr('data-id',o.id)
                    +(readOnly()?' disabled':'')+'><span class="routine-checkmark" aria-hidden="true">'+(done?'✓':'')
                    +'</span><span>'+esc(o.title)+(o.status==='skipped'?'<small>已跳过 · 不计为完成</small>':'')+'</span></button>';
            }).join('');
            return '<details class="routine-card"'+attr('data-routine-group',c.id)+(routineOpen[c.id]===false?'':' open')
                +' style="--category:'+color(c.color)+'"><summary><span class="progress-ring '+mark.status+'" role="img"'
                +attr('style',progressStyle(mark))+attr('aria-label',c.name+' · '+caption+(mark.total?' · '+percent+'%':''))
                +'><b>'+(mark.total?percent+'%':'–')+'</b></span><span class="routine-card-heading"><strong>'+esc(c.name)
                +'</strong><small>'+esc(caption)+'</small></span><span class="routine-chevron" aria-hidden="true">▶</span></summary>'
                +'<div class="routine-card-content">'+(rows||empty(mark.legacy?'历史分类打卡只读。':'这一天没有需要完成的项目。'))
                +notes.map(note=>'<p class="routine-note">'+esc(note)+'</p>').join('')+'</div></details>';
        }).join('');
        return '<section class="routine-overview" aria-label="每日惯例进度">'+heading('Daily routines',
            '<span class="meta">'+esc(short(date,{weekday:'short',month:'short',day:'numeric'}))+'</span>')
            +'<p class="overview-intro">展开类别，逐项勾选。圆环按已完成项数填充；这些打卡独立保存在 Small Plan。</p>'
            +'<div class="routine-cards">'+(cards||empty('尚未添加日常惯例。'))+'</div></section>';
    }
    function month() {
        const days = D.month(date), start = D.week(days[0])[0], end = D.week(days.at(-1))[6], cells = [];
        for (let d = start; d <= end; d = D.add(d, 1)) {
            cells.push(btn('day', Number(d.slice(-2)) + '<span class="month-dots">' + groups().map(c => '<i style="--category:' + color(c.color) + '">' + dot(D.categoryDay(state,d,c.id), c.name) + '</i>').join('') + '</span>', d, (d === date ? 'selected ' : '') + (d.slice(0, 7) !== date.slice(0, 7) ? 'outside' : '')));
        }
        return '<div class="month-grid">' + weekdays.map(w => '<b>' + w + '</b>').join('') + cells.join('') + '</div>';
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
        return routineBoard()+'<div class="secondary"><section class="card">' + heading('Month at a glance') + month() + '</section><section class="card">' + heading('Recorded time') + '<p>' + esc(date) + ' · 每格 10 分钟</p><p class="meta">来自 Small Plan 计时记录；Apple Calendar 中的安排不自动计为实际活动。</p><div class="pixels">' + pixels + '</div><p>' + recordedLabel + ' 分钟已记录 · ' + Math.max(0, Math.round(available - recorded)) + ' 分钟未记录</p></section><section class="card span">' + heading('Routine matrix') + '<p class="meta">● 全部完成　◐ 部分完成　○ 未完成　– 无应做记录</p><div class="table-scroll"><table><thead><tr><th>分类</th>' + days.map(d => '<th>' + Number(d.slice(-2)) + '</th>').join('') + '</tr></thead><tbody>' + groups().map(c => '<tr style="--category:' + color(c.color) + '"><th>' + esc(c.name) + '</th>' + days.map(d => '<td>' + btn('tracker-detail',dot(D.categoryDay(state,d,c.id),d),d+'|'+(c.id||''),'dot-detail',c.name+' · '+d+' · 查看记录') + '</td>').join('') + '</tr>').join('') + '</tbody></table></div></section><section class="card span">' + heading('Category hours') + (stats?.by_category ? '<table><tr><th>分类</th><th>历史计划小时</th><th>实际小时</th></tr>' + Object.entries(stats.by_category).map(([id, s]) => '<tr><td>' + esc(category(id).name) + '</td><td>' + (s.planned_minutes / 60).toFixed(1) + '</td><td>' + (s.actual_minutes / 60).toFixed(1) + '</td></tr>').join('') + '</table>' : empty(aux.loading ? '正在读取统计…' : '暂无分类统计。')) + '</section>' + actualTrends(stats,days) + '</div>';
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
            + (assessments || empty('暂无课程截止事项。')) + '</section><section class="card">' + heading('Import coursework')
            + '<div class="actions">' + btn('study-import','导入 CSV / ICS')
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
            +'</div></article>';
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
            app.innerHTML = '<main class="loading"><h1>small<span>.</span>plan</h1><p>' + esc(notice || '正在打开生活总览…') + '</p>' + btn('retry', '重新连接') + (cacheUnavailable?btn('open-local-health','打开本机健康记录'):'') + '</main>';
            return;
        }
        const focused = document.activeElement?.closest('[data-do]'), focusKey = focused && app.contains(focused) ? [focused.dataset.do, focused.dataset.id] : null;

        app.innerHTML = '<header class="appbar"><a class="wordmark" href="#" data-do="nav" data-id="overview">small<span>.</span>plan</a><nav aria-label="主导航">'
            +Object.entries(pages).map(([key,label])=>btn('nav',label,key,page===key?'current':'')).join('')
            +'</nav><div class="timer">'+timer()+'</div></header><main id="main">'+cacheBanner()
            +'<div class="pagehead"><div><p class="kicker">'+short(date,{month:'long',year:'numeric'})+'</p><h1>'+pages[page]+'<em>.</em></h1></div>'
            +'<div class="heading-controls"><button type="button" class="sync-label" data-do="nav" data-id="settings"><i></i>'
            +esc(timerQueue.length?(readOnly()?'本机队列已保留':'计时待同步'):lastSync||'本地记录')+'</button><div class="date-nav">'
            +btn('prev','‹','','icon',page==='overview'?'上个月':'前一天')+btn('today','今天')+btn('next','›','','icon',page==='overview'?'下个月':'后一天')
            +'<input aria-label="选择日期" type="date" value="'+date+'" id="date-picker"></div></div></div>'
            +(notice?'<div class="banner" role="alert">'+esc(notice)+' '+btn('retry','刷新')+(timerQueue.length?btn('queue','检查计时队列'):'')+'</div>':'')
            +(page==='overview'?overview():page==='study'?study():page==='insights'?insights():page==='settings'?settings():feed())+'</main>';
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
        target=Object.hasOwn(pages,target)?target:'overview';
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
        if (name === 'today' || name === 'day') {
            await navigate(name === 'today' ? today() : id);
            return;
        }
        if (name === 'prev' || name === 'next') {
            const direction = name === 'next' ? 1 : -1;
            if (page === 'overview') {
                const d = new Date(date.slice(0, 7) + '-01T12:00Z');
                d.setUTCMonth(d.getUTCMonth() + direction);
                await navigate(d.toISOString().slice(0, 10));
            }
            else
                await navigate(D.add(date, direction));
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
    document.addEventListener('toggle', e => {
        const target=e.target, id=target?.dataset?.careerGroup;
        if (!app.contains(target)) return;
        const routineId=target?.dataset?.routineGroup;
        if(routineId && state.categories.some(c=>c.id===routineId)) {
            routineOpen[routineId]=target.open;
            try { localStorage.setItem(routineOpenKey,JSON.stringify(routineOpen)); } catch { /* Keep in-memory state. */ }
            return;
        }
        if (!careerGroups.some(group=>group.id===id)) return;
        careerOpen[id]=target.open;
        try { localStorage.setItem(careerOpenKey,JSON.stringify(careerOpen)); } catch { /* Keep the current page usable. */ }
    }, true);
    document.addEventListener('click', async (e) => {
        const el = e.target.closest('[data-do]');
        if (!el) return;
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
        try {
            const c = await api('/api/calendar/status');
            lastSync = calendarLabel(c);
        } catch(error) { notice=error.message; }
        await context();
    })().catch(fail);
})();
