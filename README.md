# Small Plan

**以日历为中心的个人生活面板 · A calendar-centered personal life dashboard**

[中文说明](#中文说明) · [English guide](#english-guide)

## 中文说明

以日历为中心的个人生活面板。任务、课程、惯例、计时与复盘在同一个界面；Career 复用已有 career-ops；健康数据只在本机处理。默认单用户、周一开始、Australia/Melbourne 时区。

### 打开

**[打开 Small Plan](http://127.0.0.1:8765/)**

双击 `Start Small Plan.command`，保持终端运行。也可以在本目录执行：

```sh
python3 server.py --open
```

在启动服务的终端按 Control-C 停止；重新启动后数据保留。Mac 休眠或服务停止时连接器暂停。localhost 只能在这台 Mac 使用。端口被其他应用占用时不会先迁移数据库。

### 日常操作

| 页面 | 功能 |
| --- | --- |
| Planner | 左边 Focus／Todo／截止日期，中间日周月日历，右边分组 routines 和 Weekly Tracker |
| Overview | 月度圆点矩阵、实际活动的 10 分钟色块、分类占比与日／周趋势、上月对比；计划时间单列 |
| Study | 课程、作业、预计工作量、CSV／ICS 导入、私有订阅与确认式排程 |
| Career | 现有投递记录、岗位摘要、跟进事项；从来源创建当日任务 |
| Radar | RSS／GitHub 规则精选、原始链接、发布／采集时间与资料列表 |
| Insights | 本机 Apple Health 导入、每日精力／压力自评、覆盖率与探索性关联 |
| Settings | Apple Calendar、待同步队列、计时历史、备份恢复、导出与 AI 状态 |

**安排任务／routine**：拖住每行持续显示的 `⠿` 到日历，或点「安排」填写日期和起止时间。拖动按 15 分钟吸附，表单支持精确分钟、全天 24 小时与跨午夜。拖时间块可改期，底边可调整时长。Todo 可有多个时间块；同一天的 routine 重复安排会更新已有块。

**圆点**：每项 routine 单独勾选。类别圆点只计算当天应做的 routines，全部完成才填实，部分完成显示进度；跳过不算完成，没有应做项显示短横。点击类别圆点展开明细。普通 Todo 不改变这个完成率。迁移前保留旧版手动圆点，历史只读。分类／重复规则修改影响之后生成的实例，已生成的当天和过去记录保留快照。

**计时**：任务、routine 和类别旁均可开始；顶栏暂停／继续／结束。同一时间只允许一个活动。结束先保存实际时段，再单独询问是否完成任务。刷新可恢复，暂停不计时；超过 6 小时的异常长记录要先校对才计入统计和同步。实际时长保留到秒。「未记录」只代表没有实际记录。

**断网**：已打开页面的计时操作保留时间戳和操作 ID，重连逐条同步并显示冲突。服务停止时不能重新打开网页；本版不承诺完整多设备离线编辑。不要清除待同步计时所在的浏览器存储。

### Apple Calendar

Settings →「选择日历」→ 完成 macOS 授权 → 选择要读取的日历及可写 iCloud 来源 → 保存 →「立即同步」。系统完整授权比应用使用范围更宽：应用只读取选中的日历，只修改自己创建且有所有权记录的事件。

- `Small Plan · Plan`：已确认的安排。
- `Small Plan · Actual`：已结束且通过校对的实际活动，暂停前后分段保存。在 Calflow 中仅选择 Actual 分析真实投入。
- 外部日历只读，自己的两本日历排除导入，避免重复展示。
- 未配置、离线、权限拒绝和写入失败均保留队列。重试更新同一事件。
- 受管理事件在 Apple Calendar 被修改时保留冲突。Settings 显示双方内容；只有确认「以 Small Plan 为准」才排队处理。远端再次变化会重新要求确认。丢失所有权、移动到其他日历或标记异常不能强制覆盖。

本机在线时每分钟处理同步。辅助程序需 Xcode Command Line Tools；`sh native/build.sh` 可独立构建。**保留 `native/.build/owned-calendars.json`**，这是已创建日历的所有权凭证，重新构建不会删除它。原生协议与构建已测试；真实授权及 iCloud 创建／修改／删除／重试仍需授权后的实际试用。

ICS 导出和 `/calendar.ics` 仍可使用，但不是 EventKit 的 iCloud 写入机制。启用原生同步后避免同时订阅相同计划，否则会重复展示。

### 数据来源

Career 只读现有 career-ops 的 `data/applications.md`、每日结构化摘要及跟进文件；不另建投递状态、不更改原网站、不发送邮件。服务在线时检测文件变化。请继续在原 career-ops 网站维护状态；加入当日任务不会标记 Applied。

默认来源为 `integrations.py` 中的 `~/Library/Mobile Documents/com~apple~CloudDocs/career 2026/career-ops`；在其他电脑使用时请改成自己的目录。仓库不包含求职记录。

Radar 每日获取公开 RSS／Atom 与 GitHub，默认 Hugging Face 博客及相关 data-science 仓库。按日期和关键词筛选，精选最多五条、GitHub 最多两项，其余保留在资料列表。来源错误保留旧结果。不使用 AI 也能工作。

Study 支持手动录入、CSV、非重复 ICS 截止事项及私有 ICS 订阅。CSV 示例：

```csv
title,due_at,estimate_minutes,source_id
Assignment 1,2026-12-03T17:00:00+11:00,180,course-a-assignment-1
```

`estimate_minutes` 和 `source_id` 可省略。ICS 支持 VEVENT／带日期 VTODO、UTC、IANA 时区、取消记录；重复规则会明确拒绝，请提供展开后的截止清单。每次最多 500 项、2 MB。私有订阅链接只留在 Mac，不进入普通备份或云端。订阅每日检查，截止日期改变会提示，已有安排不移动。

排程建议默认使用 09:00–18:00 空闲时段的最多 70%，根据截止日期、优先级与预计工作量排序，避开已有安排和外部约会。只在接受后写入，并再次检查冲突。

### 本机健康分析

在 iPhone 健康 App 导出 ZIP／XML，传到 Mac，在 Insights →「导入 Apple Health」输入本机文件绝对路径。支持睡眠、静息心率、HRV SDNN、步数、活动与运动；去重、不累加重复设备来源，缺失不算零。

数据保存在 `data/local-health/health.sqlite3`。健康记录、自评、汇总和分析结果不进入普通 JSON、ICS、Markdown、AI 或本应用云端同步。观察窗口为 28 天，不足 14 个有效配对日只展示描述性结果。关联不代表因果。Insights 在没有 Watch 数据时也会描述近 7 天的时间记录、惯例执行与课程／求职截止事项；不会把时间记录比例当成完成率。当前没有诊断评分、自动 Watch 采集或 RR 心搏分析，后续需真实设备验证。

### 可选 AI 与费用

日常规划、统计、规则排程、RSS 和 GitHub 不需要模型。**AI 默认关闭。** ChatGPT 订阅不作为应用 API 凭证。

核实赠送额度与账号计费条件后，才可按 [AI 配置说明](docs/AI_SETUP.md) 配置。只有手动点击摘要按钮才调用，内容缓存，最多每日／每周各一次；无自动重试或付费回退。每月上限 US$3，另有跨月累计赠送额度上限。健康数据不进入摘要。应用无法读取提供商真实账单，账号计费条件必须独立确认。

### 备份与回退

| 位置 | 内容 |
| --- | --- |
| `data/planner.sqlite3` | 本机规划数据库 |
| `data/backups/` | 升级／恢复前的备份和升级前源码 |
| `data/private/` | 私有订阅、AI 配置和预算账本，不导出 |
| `data/local-health/` | 独立健康库，需在本机另行备份 |
| `data/cloud-cache/` | 之后切换云端时的只读规划缓存 |
| `native/.build/owned-calendars.json` | 日历所有权映射，迁移 Mac 时保留 |

Settings 的 JSON 备份保留普通规划数据，兼容旧版 JSON；恢复前自动备份。旧整库 PUT 已停用，避免旧页面覆盖新字段。SQLite 升级保留原始任务、习惯、笔记和历史打卡。

回退先停止服务，保存当前数据库及其 WAL 文件、导出当前 JSON，再从对应升级前源码存档和数据库备份恢复。不要把新版数据库交给旧版服务，不要覆盖运行中的数据库。旧备份之后的编辑不会自动保留。

### 云端准备

`cloud/` 包含 TypeScript Worker＋D1 和 Cloudflare Access 验证；`cloud_bridge.py` 由 Mac 主动连接处理系统接口。切换后 D1 是唯一可编辑主库。按部署说明以 `--cache-planner` 启动桥接程序，会在验证缓存后锁定 Mac 计划编辑；本机健康分析读取云端缓存。缓存丢失不会退回旧的可编辑数据库，健康仍留本机。

**尚未发布云端地址。** 按计划先本机连续试用一周，再核验登录、免费配额、手机访问、Mac 连接和数据迁移。部署与回退步骤见 [云端实施说明](cloud/IMPLEMENTATION_REPORT.md)。

### 验证

Python 3.9+ 标准库；本机网页不需 npm 构建。云端工具需 Node 24 与 pnpm。

```sh
python3 -m unittest discover -s tests -v
node --test tests/test_life_ui.cjs tests/test_drag.cjs
sh native/build.sh --test
```

在 `cloud` 目录执行 `pnpm install --frozen-lockfile`、`pnpm typecheck`、`WRANGLER_SEND_METRICS=false pnpm test`、`WRANGLER_SEND_METRICS=false pnpm dry-run`。测试使用临时数据库，不操作真实日历。实现约定见 [LIFE_IMPLEMENTATION.md](docs/LIFE_IMPLEMENTATION.md)，结果见 [IMPLEMENTATION_PROGRESS.md](docs/IMPLEMENTATION_PROGRESS.md)。

### 仓库内容与隐私

仓库包含源码、测试、数据库迁移和产品／实施文档。`data/`、数据库、备份、密钥、依赖缓存、原生构建产物、个人截图及终端历史不上传；规则见 [.gitignore](.gitignore)。首次克隆启动会创建独立的新数据库，不含原使用者的任务、求职记录或健康数据。

公开 GitHub 仓库仅用于保存和分享项目源码，不等于已经部署网站。网页仍需本机启动；跨设备使用需完成上述云端部署。

## English guide

Small Plan brings tasks, routines, coursework, time tracking and reflection into one calendar-centered dashboard. Career reuses an existing career-ops workspace, while health data stays on the Mac. Defaults are single-user mode, a Monday-start week and the `Australia/Melbourne` time zone.

### Quick start

The local app uses **Python 3.9+ and the standard library**. Its frontend needs no npm build. Clone or download this repository, open its folder in a terminal, then run:

```sh
python3 server.py --open
```

Open **[Small Plan locally](http://127.0.0.1:8765/)**. On macOS, you can also double-click `Start Small Plan.command`. Keep the terminal running; press Control-C in that terminal to stop the server. Saved data survives restarts. Connectors pause while the Mac sleeps or the service is stopped. The localhost address works only on the computer running the app. The server checks that its port is available before migrating a database.

### Everyday features

| Page | What it does |
| --- | --- |
| Planner | Focus, Todo and deadlines on the left; a 24-hour day/week/month calendar in the center; grouped routines and the Weekly Tracker on the right |
| Overview | Monthly category-dot matrix, 10-minute activity cells, category shares, daily/weekly trends and previous-month comparison; planned time stays separate |
| Study | Courses, assessments, effort estimates, CSV/ICS imports, private subscriptions and scheduling suggestions that require confirmation |
| Career | Existing application records, job digests and follow-ups; turn a source item into a daily task |
| Radar | Rule-ranked RSS/GitHub picks with original links, publication/collection times and an archive |
| Insights | Local Apple Health imports, daily energy/stress check-ins, data coverage and exploratory associations |
| Settings | Apple Calendar, pending sync, timer history, backup/restore, exports and AI status |

**Scheduling:** drag the always-visible `⠿` handle onto the calendar, or click **Arrange** to enter the date and times. Dragging snaps to 15 minutes; forms accept exact minutes, all 24 hours and intervals crossing midnight. Move a block to reschedule it or resize its bottom edge. A Todo can have several planned blocks. Scheduling the same dated routine again updates its existing block.

**Routine dots:** check off each routine separately. A category becomes solid only when every routine due that day is complete. Partial completion shows progress, skipped items remain incomplete, and a day with no due items shows a dash. Click a category dot for details. Ordinary Todos do not change this completion rate. Pre-migration manual dots remain as read-only history. Category and recurrence edits affect newly generated occurrences; existing current-day and historical snapshots retain their original requirements.

**Timers:** start from a task, routine or category. Pause, resume or stop from the top bar. Only one activity can be active at a time. Stopping saves actual intervals first, then asks separately whether the task is complete. Refreshing restores the timer, paused time is excluded, and continuous records longer than six hours require review before entering statistics or Calendar sync. Actual duration keeps second-level precision. “Unrecorded” means only that no activity was recorded.

**Offline behavior:** an already-open page retains timer operations with their timestamps and operation IDs, then replays them on reconnection and surfaces conflicts. A stopped local server cannot serve a newly opened page. Full multi-device offline editing is not supported. Keep browser storage intact while timer operations are pending.

### Apple Calendar

Go to **Settings → Select calendars**, grant macOS access, choose the calendars to read and a writable iCloud source, save, then select **Sync now**. The OS permission is broader than the app's behavior: Small Plan reads only selected calendars and modifies only events it owns.

- **Small Plan · Plan** stores confirmed plans.
- **Small Plan · Actual** stores finished, reviewed activity segments. Pauses separate segments. Select only this calendar in Calflow when analyzing actual time.
- External calendars are read-only. The two owned calendars are excluded from imports to prevent duplicate display.
- Missing configuration, offline operation, denied permissions and failed writes leave work in the queue. Retries update the same event.
- If a managed event changes in Apple Calendar, Settings shows a conflict. Confirm **Use Small Plan** to queue an overwrite. A further remote edit requires fresh confirmation. Missing ownership, a move to another calendar or an invalid marker cannot be forcibly overridden.

The local service checks sync work every minute while online. The native helper requires macOS and Xcode Command Line Tools; build it with `sh native/build.sh`. **Keep `native/.build/owned-calendars.json` when moving or backing up your Mac**: it records calendar ownership, and rebuilding preserves it. Protocol tests and builds are available; real permission grants and iCloud create/update/delete/retry behavior still require testing in the target account.

ICS export and `/calendar.ics` remain available but are separate from native EventKit writes. Avoid subscribing to the same plans through ICS while native sync is enabled.

### Data sources and scheduling

**Career** reads an existing career-ops workspace's `data/applications.md`, structured daily digest and follow-up files. It does not create another application-status system, change the original website or send email. Continue updating statuses in career-ops; adding a task never marks a job Applied. The current default source directory is `~/Library/Mobile Documents/com~apple~CloudDocs/career 2026/career-ops` in `integrations.py`. Adapt that path to your own workspace; the repository contains no career records.

**Radar** fetches public RSS/Atom feeds and GitHub repositories daily. Defaults include the Hugging Face blog and relevant data-science repositories. Date and keyword rules select at most five featured items, including at most two repositories. Remaining items stay in the archive, and source failures preserve previous results. No AI is required.

**Study** supports manual input, CSV, non-recurring ICS deadline items and private ICS subscriptions. Example:

```csv
title,due_at,estimate_minutes,source_id
Assignment 1,2026-12-03T17:00:00+11:00,180,course-a-assignment-1
```

`estimate_minutes` and `source_id` are optional. ICS supports VEVENT, dated VTODO, UTC, IANA time zones and cancellations. Recurrence rules are rejected explicitly; supply an expanded deadline list. Each import is limited to 500 items and 2 MB. Private subscription URLs remain on the Mac and are excluded from ordinary backups and cloud sync. Daily refreshes flag changed deadlines without moving confirmed plans.

**Scheduling suggestions** use at most 70% of free time in the default 09:00–18:00 working window, ordered by deadline, priority and estimated effort. Existing plans and imported appointments are protected. Nothing is written until you accept a suggestion, and conflicts are checked again at acceptance.

### Local health and planning insights

Export XML or ZIP from the iPhone Health app, transfer it to your Mac, then enter the file's absolute path under **Insights → Import Apple Health**. Supported records include sleep, resting heart rate, HRV SDNN, steps, activity and workouts. Imports deduplicate records and overlapping device sources; missing data is not treated as zero.

Health data lives in `data/local-health/health.sqlite3`. Raw records, check-ins, summaries and derived insights are excluded from ordinary JSON/ICS/Markdown exports, AI requests and the app's cloud sync. The observation window is 28 days; fewer than 14 valid paired days produces descriptive results only. Associations are not causal or diagnostic claims.

Even without Watch data, Insights describes the last seven days of recorded time, routine completion and study/career deadlines. Recorded-time ratios are not treated as task completion rates. Automated Watch collection, diagnostic scores and RR-interval analysis are not enabled; future collection methods need real-device validation.

### Optional AI and spending controls

Planning, statistics, rule-based scheduling, RSS and GitHub work without a model. **AI is disabled by default.** A ChatGPT subscription is not an API credential for this app.

Only configure AI after independently verifying promotional credits and billing conditions; see [AI setup](docs/AI_SETUP.md). Summaries require a manual click, reuse cached content and allow at most one daily and one weekly attempt per corresponding period. There is no automatic retry or paid fallback. The application enforces a US$3 monthly cap plus a cumulative promotional-credit allocation. Health data is never sent for summaries. The app cannot verify the provider's actual billing balance or auto-recharge settings.

### Storage, backups and rollback

| Location | Contents |
| --- | --- |
| `data/planner.sqlite3` | Local planner database |
| `data/backups/` | Safety backups made before upgrades/restores; any retained pre-upgrade source archives |
| `data/private/` | Private subscriptions, AI configuration and budget ledger; excluded from exports |
| `data/local-health/` | Separate health database; back up locally and separately |
| `data/cloud-cache/` | Read-only planner cache after a future cloud cutover |
| `native/.build/owned-calendars.json` | Calendar ownership registry; retain when moving Macs |

Settings can export ordinary planner data as JSON and restore both v1 and v2 backups. Restore creates a safety backup first. The old whole-database PUT endpoint is retired to prevent stale pages from overwriting newer fields. SQLite migration retains existing tasks, routines, notes and historical checks.

For rollback, stop the service, preserve the current database and its WAL files, and export the current JSON. Restore a matching pre-upgrade source archive and database backup. Never open a new-format database with an old server or overwrite a running database. Edits made after the older backup are not retained automatically.

### Cloud deployment status

`cloud/` contains a TypeScript Worker, D1 migrations and Cloudflare Access verification. `cloud_bridge.py` connects outbound from the Mac for native integrations. After cutover, D1 becomes the only writable planner. The bridge's explicit `--cache-planner` option validates a downloaded cache before locking local planner editing. Local health analysis can read this cache; a missing cache never falls back to the old writable database.

**No hosted deployment is included or activated.** First complete a local trial, then verify authentication, free-tier limits, mobile access, the Mac bridge and data migration. Follow the [cloud deployment and rollback guide](cloud/IMPLEMENTATION_REPORT.md). Cloud health views remain local-only placeholders.

### Development and checks

Use Python 3.9+ for the local service and Node 24 with pnpm for cloud tooling. From the repository root:

```sh
python3 -m unittest discover -s tests -v
node --test tests/test_life_ui.cjs tests/test_drag.cjs
sh native/build.sh --test
```

The Swift command requires macOS and Xcode Command Line Tools. Tests use temporary databases and do not write to real calendars. For the cloud package:

```sh
cd cloud
pnpm install --frozen-lockfile
pnpm typecheck
WRANGLER_SEND_METRICS=false pnpm test
WRANGLER_SEND_METRICS=false pnpm dry-run
```

Read the [product specification](PRODUCT_SPEC.md), [implementation contract](docs/LIFE_IMPLEMENTATION.md) and [verification record](docs/IMPLEMENTATION_PROGRESS.md) for the current scope and known activation limits.

### Repository privacy

This repository contains source, tests, migrations and product/implementation documentation. [`.gitignore`](.gitignore) excludes local databases, backups, credentials, dependency caches, native build output, personal screenshots and shell history. A fresh clone creates a new database without the original user's tasks, career records or health data.

A public GitHub repository shares the source; it does not host the running dashboard. Start the local server to use it on your Mac, or complete the separate cloud deployment for access from other devices.
