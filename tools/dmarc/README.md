# DMARC Aggregate Report Pipeline

Stdlib-only DMARC parser for OtterQuote. Fetches aggregate reports via Gmail IMAP, decompresses `.gz` / `.zip` attachments, parses the XML, and escalates failures to ClickUp.

## Quick start

```bash
# install test deps only
pip install pytest

# run tests (no credentials required)
cd otterquote-platform
python -m pytest tools/dmarc/tests/ -v
```

---

## 1. Generate a Gmail App Password

1. Sign in at **myaccount.google.com** as `dustinstohler1@gmail.com`.
2. Go to **Security → 2-Step Verification → App passwords**.
3. App name: `DMARC Pipeline`. Click **Create**.
4. Copy the 16-character password (no spaces).

---

## 2. Set `DMARC_IMAP_PASSWORD`

**Option A — env var (recommended for scripts/CI):**

```bash
export DMARC_IMAP_PASSWORD="xxxx xxxx xxxx xxxx"
```

**Option B — gitignored secrets file:**

Create `tools/dmarc/.secrets` (never committed):

```
DMARC_IMAP_PASSWORD=xxxx xxxx xxxx xxxx
```

The pipeline tries the env var first, then falls back to the file.

---

## 3. Enable the daily schedule

The Lane-2 task [86e1rga78] covers scheduling. Once the Gmail app password is set:

```bash
# one-off test run
python tools/dmarc/run_pipeline.py
```

For automation, wire `run_pipeline.py` into the Windows Task Scheduler (alongside other nightly jobs). Recommended run time: 06:00 UTC (after Microsoft reports arrive at ~05:25 UTC).

---

## 4. Adding a new domain or reporter

Edit `tools/dmarc/config.json`:

```json
{
  "domains": ["tryotterquote.com", "otterquote.com", "yournewdomain.com"],
  "reporter_senders": [
    "dmarcreport@microsoft.com",
    "noreply-dmarc-support@google.com",
    "dmarc@anotherprovider.com"
  ]
}
```

No code changes required — the pipeline iterates over all configured senders.

---

## Architecture

| Module | Role |
|--------|------|
| `parse_dmarc.py` | XML parser — `parse_report(xml_bytes) -> dict` |
| `imap_fetch.py` | Gmail IMAP fetch + decompression |
| `config.json` | Domain/sender/path configuration |
| `tests/` | pytest suite (runs fully offline) |
| `results/` | Output directory (gitignored) |

### Output format

For each report, the pipeline writes:
- `tools/dmarc/results/<domain>/<report_id>.json` — full parsed data
- `tools/dmarc/results/<domain>/<report_id>.csv` — per-record summary
- Appends a run summary line to `handoffs/dmarc-run-log.md`

### Failure escalation

If any record has `disposition=reject` **and** `dkim=fail` or `spf=fail`, or if alignment fails, the pipeline creates a ClickUp task in list `901711730553` tagged `sec-sweep, triage-needed`. If all records pass, no task is created.
