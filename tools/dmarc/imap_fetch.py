"""
DMARC aggregate-report IMAP fetcher — stdlib only.

Connects to Gmail IMAP, fetches UNSEEN messages from configured senders,
decompresses .gz or .zip attachments, and returns raw XML bytes.
Marks each processed message as seen (does not delete).

Auth: reads DMARC_IMAP_PASSWORD from env var, then falls back to
      tools/dmarc/.secrets (gitignored, format: DMARC_IMAP_PASSWORD=<value>).
"""

import email
import email.policy
import gzip
import imaplib
import io
import json
import os
import pathlib
import ssl
import zipfile

_CONFIG_PATH = pathlib.Path(__file__).parent / "config.json"
_SECRETS_PATH = pathlib.Path(__file__).parent / ".secrets"


def _load_config() -> dict:
    return json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))


def _load_password() -> str:
    pw = os.environ.get("DMARC_IMAP_PASSWORD", "").strip()
    if pw:
        return pw
    if _SECRETS_PATH.exists():
        for line in _SECRETS_PATH.read_text(encoding="utf-8").splitlines():
            if line.startswith("DMARC_IMAP_PASSWORD="):
                return line.split("=", 1)[1].strip()
    raise RuntimeError(
        "DMARC_IMAP_PASSWORD not set. "
        "Export the env var or write it to tools/dmarc/.secrets."
    )


def _decompress_attachment(data: bytes, filename: str) -> bytes:
    """Return raw XML bytes from a .gz or .zip attachment."""
    name_lower = filename.lower()
    if name_lower.endswith(".gz") or name_lower.endswith(".xml.gz"):
        return gzip.decompress(data)
    if name_lower.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            # take the first XML member
            for member in zf.namelist():
                if member.lower().endswith(".xml"):
                    return zf.read(member)
            raise ValueError(f"No .xml entry found in zip: {filename}")
    # assume raw XML
    return data


def fetch_reports(config: dict | None = None) -> list[bytes]:
    """
    Connect to Gmail IMAP, fetch UNSEEN DMARC reports, decompress, and return
    a list of raw XML byte strings (one per report).

    Side-effect: marks each fetched message as \\Seen.
    """
    if config is None:
        config = _load_config()

    host = config.get("imap_host", "imap.gmail.com")
    port = int(config.get("imap_port", 993))
    user = config["imap_user"]
    senders = config.get("reporter_senders", [])
    password = _load_password()

    ctx = ssl.create_default_context()
    conn = imaplib.IMAP4_SSL(host, port, ssl_context=ctx)
    conn.login(user, password)
    conn.select("INBOX")

    xml_reports: list[bytes] = []

    for sender in senders:
        search_criteria = f'(UNSEEN FROM "{sender}")'
        _status, msg_ids_raw = conn.search(None, search_criteria)
        msg_ids = (msg_ids_raw[0] or b"").split()

        for msg_id in msg_ids:
            _status, msg_data = conn.fetch(msg_id, "(RFC822)")
            if not msg_data or not msg_data[0]:
                continue
            raw = msg_data[0][1] if isinstance(msg_data[0], tuple) else msg_data[0]
            msg = email.message_from_bytes(raw, policy=email.policy.default)

            for part in msg.walk():
                content_type = part.get_content_type()
                filename = part.get_filename() or ""
                is_attachment = part.get_content_disposition() == "attachment"

                if not filename and not is_attachment:
                    continue
                if content_type in ("application/gzip", "application/zip",
                                    "application/xml", "text/xml") or filename:
                    payload = part.get_payload(decode=True)
                    if payload:
                        try:
                            xml_bytes = _decompress_attachment(payload, filename)
                            xml_reports.append(xml_bytes)
                        except Exception as exc:
                            print(f"[DMARC] Skipping attachment {filename!r}: {exc}")

            # mark seen
            conn.store(msg_id, "+FLAGS", "\\Seen")

    conn.logout()
    return xml_reports
