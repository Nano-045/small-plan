# Optional AI summaries

AI is disabled by default and has not been activated. Core planning and raw feeds need no API. Before enabling, independently verify the API organization's actual promotional balance, expiry, absence of paid balance and disabled auto recharge. A ChatGPT login is not an API key. A configuration flag is not evidence of eligibility. If these conditions cannot be confirmed, keep AI off.

Use a dedicated organization/key for this app. Supply the key privately through `SMALL_PLAN_OPENAI_API_KEY` in the Mac service environment. Never put it in frontend files, cloud bindings, source control, ordinary backups or printed commands.

Private configuration is `data/private/ai.json`. Start disabled:

```json
{
  "enabled": false,
  "promotional_only_confirmed": false,
  "has_paid_balance": false,
  "auto_recharge": false,
  "grant_expires_at": "",
  "grant_budget_usd": 0,
  "monthly_cap_usd": 3
}
```

After verification, set the real expiry with a timezone offset, allocate an amount no greater than the available grant, and enable the two confirmation/enable flags. Restart the service. No active configuration or invented expiry is supplied here.

`grant_budget_usd` is the cumulative total allocated to this app's existing ledger, not a monthly refill or a live provider balance. Prior actual/reserved usage in `data/private/ai-budget.sqlite3` is subtracted across all months. Preserve the ledger across restarts and migration. If credits are spent elsewhere, reduce this allocation or disable the feature. Additional verified grants may increase the total; never reset the ledger to obtain a new budget.

Every request needs capacity in both the monthly cap (maximum US$3) and cumulative grant. Reservation happens before the network call. Timeouts keep reservations; there is no automatic retry, paid fallback or paid search tool. Identical content is cached with at most one daily and one weekly attempt. All calls require an explicit button click.

Model and accounting rates are fixed in `ai_budget.py`; verify current provider documentation before enabling/changing them. Local limits are a second guard, not an authoritative billing meter. Only allowlisted short public news/repository/job fields enter requests. Health, private notes, subscription URLs and raw email content are excluded.
