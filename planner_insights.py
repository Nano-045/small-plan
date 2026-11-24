"""Local, descriptive planning observations; no model or health diagnosis."""

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

ZONE = ZoneInfo('Australia/Melbourne')


def _day(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        if len(value) == 10:
            return date.fromisoformat(value)
        instant = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if instant.tzinfo is None:
            return None
        return instant.astimezone(ZONE).date()
    except (ValueError, OverflowError):
        return None


def observations(state, days, today):
    first, until = today - timedelta(days=6), today + timedelta(days=7)
    recent = [value for key, value in days.items() if first.isoformat() <= key <= today.isoformat()]
    planned = sum(row.get('planned_minutes', 0) for row in recent)
    actual = sum(row.get('actual_minutes', 0) for row in recent)
    recorded_days = sum(row.get('actual_minutes', 0) > 0 for row in recent)
    result = [{
        'kind': 'planning_time', 'title': '近 7 天的时间记录', 'n': recorded_days,
        'body': '%s 至 %s：%.1f 小时计划，%.1f 小时已记录实际活动，%s 天有实际记录。未计时活动不在统计内，二者的比例不能作为完成率；也不能把差额解释为休息或浪费。'
                % (first.isoformat(), today.isoformat(), planned / 60, actual / 60, recorded_days),
    }]
    cutoff = max(first.isoformat(), state['rollout_date'])
    due = [r for r in state['occurrences'] if cutoff <= r['local_date'] <= today.isoformat()]
    done = sum(r['status'] == 'done' for r in due)
    skipped = sum(r['status'] == 'skipped' for r in due)
    result.append({
        'kind': 'planning_routines', 'title': '惯例执行情况', 'n': len(due),
        'body': ('本观察窗口的新规则记录已完成 %s/%s 项，其中 %s 项跳过仍计为未完成。只计算当时应做的惯例，不含普通 Todo。'
                 % (done, len(due), skipped)) if due else '本观察窗口暂无新规则的惯例记录；旧版类别打卡不换算成新的完成率。',
    })
    assessments = [a for a in state['assessments'] if a['status'] not in ('done', 'archived')]
    dated = [(a, _day(a.get('due_at'))) for a in assessments]
    active = [(a, deadline) for a, deadline in dated if deadline is not None and deadline < until]
    if active:
        overdue = sum(deadline < today for _, deadline in active)
        upcoming = len(active) - overdue
        hours = sum(a.get('estimate_minutes', 0) for a, _ in active) / 60
        examples = '、'.join(a['title'] for a, _ in sorted(active, key=lambda pair: pair[1])[:3])
        result.append({
            'kind': 'planning_deadlines', 'title': '课程工作量线索', 'n': len(active),
            'body': '今天起 7 个日历日内有 %s 项课程截止，另有 %s 项截止日期早于今天的未完成作业。待处理事项包括 %s。这些作业填写的总预估为 %.1f 小时，不等于剩余工时。可在 Study 检查拆分与缓冲；这里只描述事项集中程度，不判断它是否导致压力。'
                    % (upcoming, overdue, examples, hours),
        })
    career = []
    inactive = {'applied', 'rejected', 'withdrawn', 'closed', 'offer', 'done', 'completed', '已投递', '已完成'}
    for item in state['external_items']:
        if item['kind'] not in ('job', 'followup') or str(item.get('status', '')).strip().casefold() in inactive:
            continue
        deadline = _day(item.get('deadline'))
        if deadline is not None and today <= deadline < until:
            career.append(item)
    if career:
        result.append({
            'kind': 'planning_career', 'title': '近期求职事项', 'n': len(career),
            'body': '已同步资料中有 %s 项岗位截止或跟进日期落在未来 7 天。结合课程截止安排处理时段；此数字依赖最近的 career-ops 快照，不会改变投递状态，也不代表必须申请这些岗位。' % len(career),
        })
    return result
