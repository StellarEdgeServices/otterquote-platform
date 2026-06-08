"""
DMARC aggregate-report XML parser — stdlib only (Python 3.14+).

Entry point:  parse_report(xml_bytes: bytes) -> dict
The returned dict contains:
  - records: list of per-row dicts
  - rollup: aggregate counts
  - report_metadata: org_name, report_id, date_range
  - policy_published: domain, p, sp, pct, adkim, aspf
"""

import xml.etree.ElementTree as ET


def _text(node, tag, default=""):
    child = node.find(tag)
    return child.text.strip() if child is not None and child.text else default


def parse_report(xml_bytes: bytes) -> dict:
    root = ET.fromstring(xml_bytes)

    def _find(node, tag):
        child = node.find(tag)
        return child if child is not None else ET.Element(tag)

    # --- report_metadata ---
    meta = _find(root, "report_metadata")
    date_range_node = _find(meta, "date_range")
    report_metadata = {
        "org_name": _text(meta, "org_name"),
        "email": _text(meta, "email"),
        "report_id": _text(meta, "report_id"),
        "begin": int(_text(date_range_node, "begin") or 0),
        "end": int(_text(date_range_node, "end") or 0),
    }

    # --- policy_published ---
    pub = _find(root, "policy_published")
    policy_published = {
        "domain": _text(pub, "domain"),
        "adkim": _text(pub, "adkim", "r"),
        "aspf": _text(pub, "aspf", "r"),
        "p": _text(pub, "p", "none"),
        "sp": _text(pub, "sp"),
        "pct": int(_text(pub, "pct") or 100),
    }

    # --- records ---
    records = []
    for rec in root.findall("record"):
        row = _find(rec, "row")
        evaluated = _find(row, "policy_evaluated")
        identifiers = _find(rec, "identifiers")
        auth_results = _find(rec, "auth_results")

        spf_node = _find(auth_results, "spf")
        dkim_node = _find(auth_results, "dkim")

        dkim_result = _text(evaluated, "dkim", "")
        spf_result = _text(evaluated, "spf", "")
        disposition = _text(evaluated, "disposition", "none")
        count = int(_text(row, "count") or 1)

        # alignment: both must pass
        aligned = dkim_result == "pass" and spf_result == "pass"

        records.append({
            "source_ip": _text(row, "source_ip"),
            "count": count,
            "disposition": disposition,
            "dkim": dkim_result,
            "spf": spf_result,
            "header_from": _text(identifiers, "header_from"),
            "dkim_domain": _text(dkim_node, "domain"),
            "spf_domain": _text(spf_node, "domain"),
            "aligned": aligned,
        })

    # --- rollup ---
    total_messages = sum(r["count"] for r in records)
    rollup = {
        "n_records": len(records),
        "total_messages": total_messages,
        "spf_pass": sum(r["count"] for r in records if r["spf"] == "pass"),
        "dkim_pass": sum(r["count"] for r in records if r["dkim"] == "pass"),
        "non_none_dispositions": sum(
            r["count"] for r in records if r["disposition"] != "none"
        ),
        "all_pass": all(r["aligned"] for r in records) if records else True,
    }

    return {
        "report_metadata": report_metadata,
        "policy_published": policy_published,
        "records": records,
        "rollup": rollup,
    }


def is_failure_row(record: dict) -> bool:
    """True if a record warrants a ClickUp escalation."""
    if record["disposition"] == "reject" and (
        record["dkim"] != "pass" or record["spf"] != "pass"
    ):
        return True
    if not record["aligned"]:
        return True
    return False
