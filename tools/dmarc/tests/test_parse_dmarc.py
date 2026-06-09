"""
pytest suite for parse_dmarc.py and imap_fetch.py decompression.

Runs fully offline — no live credentials required.
"""

import gzip
import io
import pathlib
import sys
import unittest.mock
import zipfile

import pytest

# make tools/dmarc importable when run from repo root
_DMARC_DIR = pathlib.Path(__file__).parent.parent
sys.path.insert(0, str(_DMARC_DIR))

import parse_dmarc  # noqa: E402
from imap_fetch import _decompress_attachment  # noqa: E402

FIXTURES = pathlib.Path(__file__).parent / "fixtures"


# ---------------------------------------------------------------------------
# parse_dmarc — pass fixture
# ---------------------------------------------------------------------------

def test_parse_pass_fixture_records():
    xml_bytes = gzip.decompress((FIXTURES / "sample_pass.xml.gz").read_bytes())
    result = parse_dmarc.parse_report(xml_bytes)
    assert result["rollup"]["n_records"] == 2
    assert result["rollup"]["total_messages"] == 8  # 5 + 3


def test_parse_pass_fixture_all_pass():
    xml_bytes = gzip.decompress((FIXTURES / "sample_pass.xml.gz").read_bytes())
    result = parse_dmarc.parse_report(xml_bytes)
    assert result["rollup"]["all_pass"] is True


def test_parse_pass_fixture_rollup_counts():
    xml_bytes = gzip.decompress((FIXTURES / "sample_pass.xml.gz").read_bytes())
    result = parse_dmarc.parse_report(xml_bytes)
    rollup = result["rollup"]
    assert rollup["spf_pass"] == 8
    assert rollup["dkim_pass"] == 8
    assert rollup["non_none_dispositions"] == 0


def test_parse_pass_fixture_metadata():
    xml_bytes = gzip.decompress((FIXTURES / "sample_pass.xml.gz").read_bytes())
    result = parse_dmarc.parse_report(xml_bytes)
    meta = result["report_metadata"]
    assert meta["report_id"] == "abc123-pass-fixture"
    assert meta["org_name"] == "Microsoft Corporation"


def test_parse_pass_fixture_record_fields():
    xml_bytes = gzip.decompress((FIXTURES / "sample_pass.xml.gz").read_bytes())
    result = parse_dmarc.parse_report(xml_bytes)
    rec = result["records"][0]
    assert rec["source_ip"] == "209.85.220.41"
    assert rec["count"] == 5
    assert rec["disposition"] == "none"
    assert rec["dkim"] == "pass"
    assert rec["spf"] == "pass"
    assert rec["header_from"] == "tryotterquote.com"
    assert rec["aligned"] is True


# ---------------------------------------------------------------------------
# parse_dmarc — fail fixture
# ---------------------------------------------------------------------------

def test_parse_fail_fixture_not_all_pass():
    xml_bytes = gzip.decompress((FIXTURES / "sample_fail.xml.gz").read_bytes())
    result = parse_dmarc.parse_report(xml_bytes)
    assert result["rollup"]["all_pass"] is False


def test_parse_fail_fixture_failure_row_detected():
    xml_bytes = gzip.decompress((FIXTURES / "sample_fail.xml.gz").read_bytes())
    result = parse_dmarc.parse_report(xml_bytes)
    fail_rows = [r for r in result["records"] if parse_dmarc.is_failure_row(r)]
    assert len(fail_rows) == 1
    assert fail_rows[0]["source_ip"] == "198.51.100.42"


def test_parse_fail_fixture_disposition():
    xml_bytes = gzip.decompress((FIXTURES / "sample_fail.xml.gz").read_bytes())
    result = parse_dmarc.parse_report(xml_bytes)
    assert result["rollup"]["non_none_dispositions"] == 2  # count=2, disposition=reject


# ---------------------------------------------------------------------------
# Decompression paths
# ---------------------------------------------------------------------------

def test_gz_decompression():
    original = b"<feedback><record/></feedback>"
    compressed = gzip.compress(original)
    result = _decompress_attachment(compressed, "report.xml.gz")
    assert result == original


def test_zip_decompression():
    original = b"<feedback><record/></feedback>"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("report.xml", original)
    result = _decompress_attachment(buf.getvalue(), "report.zip")
    assert result == original


def test_raw_xml_passthrough():
    original = b"<feedback/>"
    result = _decompress_attachment(original, "report.xml")
    assert result == original


# ---------------------------------------------------------------------------
# IMAP fetch — mocked (no live credentials required)
# ---------------------------------------------------------------------------

def _make_mock_email(xml_bytes: bytes, filename: str = "report.xml.gz") -> bytes:
    import email.mime.multipart
    import email.mime.base
    from email import encoders

    msg = email.mime.multipart.MIMEMultipart()
    msg["From"] = "dmarcreport@microsoft.com"
    msg["To"] = "dustinstohler1@gmail.com"
    msg["Subject"] = "DMARC Report"

    part = email.mime.base.MIMEBase("application", "gzip")
    part.set_payload(xml_bytes)
    encoders.encode_base64(part)
    part.add_header("Content-Disposition", "attachment", filename=filename)
    msg.attach(part)
    return msg.as_bytes()


def test_imap_fetch_mock():
    """fetch_reports should return decoded XML bytes from mocked IMAP."""
    import imap_fetch

    xml_bytes = gzip.decompress((FIXTURES / "sample_pass.xml.gz").read_bytes())
    compressed = gzip.compress(xml_bytes)
    raw_email = _make_mock_email(compressed, "report.xml.gz")

    config = {
        "imap_host": "imap.gmail.com",
        "imap_port": 993,
        "imap_user": "test@example.com",
        "reporter_senders": ["dmarcreport@microsoft.com"],
    }

    mock_conn = unittest.mock.MagicMock()
    mock_conn.search.return_value = ("OK", [b"1"])
    mock_conn.fetch.return_value = ("OK", [(b"1 (RFC822 {...})", raw_email)])
    mock_conn.store.return_value = ("OK", [])

    with (
        unittest.mock.patch("imap_fetch.imaplib.IMAP4_SSL", return_value=mock_conn),
        unittest.mock.patch("imap_fetch._load_password", return_value="fake-app-pw"),
    ):
        reports = imap_fetch.fetch_reports(config)

    assert len(reports) == 1
    parsed = parse_dmarc.parse_report(reports[0])
    assert parsed["rollup"]["all_pass"] is True


# ---------------------------------------------------------------------------
# ClickUp escalation path
# ---------------------------------------------------------------------------

def test_all_pass_no_failure_rows():
    """Pass fixture produces zero failure rows — no ClickUp task needed."""
    xml_bytes = gzip.decompress((FIXTURES / "sample_pass.xml.gz").read_bytes())
    result = parse_dmarc.parse_report(xml_bytes)
    fail_rows = [r for r in result["records"] if parse_dmarc.is_failure_row(r)]
    assert len(fail_rows) == 0, "Pass fixture must not trigger escalation"


def test_fail_triggers_escalation_mock():
    """Fail fixture triggers is_failure_row for the bad record."""
    xml_bytes = gzip.decompress((FIXTURES / "sample_fail.xml.gz").read_bytes())
    result = parse_dmarc.parse_report(xml_bytes)
    fail_rows = [r for r in result["records"] if parse_dmarc.is_failure_row(r)]
    assert len(fail_rows) > 0, "Fail fixture must contain at least one failure row"
    # Simulate the ClickUp call that would be made in the runner
    clickup_calls = []

    def mock_create_clickup_task(row, domain):
        clickup_calls.append({"row": row, "domain": domain})

    for row in fail_rows:
        mock_create_clickup_task(row, "tryotterquote.com")

    assert len(clickup_calls) == 1
    assert clickup_calls[0]["row"]["source_ip"] == "198.51.100.42"
