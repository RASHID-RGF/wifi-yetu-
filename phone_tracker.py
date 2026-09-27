#!/usr/bin/env python3
"""
phone_tracker.py — Phone number lookup, validation and analysis.

Uses Google's libphonenumber (Python port) to inspect phone numbers entirely
offline: validity, region, carrier, line type, timezone and formatting.

Legitimate uses: validating user signups, cleaning CRM data, auditing your own
contact lists, classifying inbound traffic.

Usage:
    python3 phone_tracker.py "+14155552671"
    python3 phone_tracker.py 0612345678 --region FR
    python3 phone_tracker.py --batch numbers.csv --out report.csv
    python3 phone_tracker.py --interactive
"""

from __future__ import annotations

import argparse
import csv
import sys
from dataclasses import dataclass, asdict, fields
from functools import lru_cache
from typing import Iterable, Optional

import phonenumbers
from phonenumbers import (
    carrier,
    geocoder,
    timezone,
    number_type,
    PhoneNumberFormat,
    PhoneNumberType,
)

# --------------------------------------------------------------------------- #
# Core lookup
# --------------------------------------------------------------------------- #

# Human-readable names for PhoneNumberType constants.
TYPE_NAMES = {
    PhoneNumberType.FIXED_LINE: "fixed line",
    PhoneNumberType.MOBILE: "mobile",
    PhoneNumberType.FIXED_LINE_OR_MOBILE: "fixed line or mobile",
    PhoneNumberType.TOLL_FREE: "toll free",
    PhoneNumberType.PREMIUM_RATE: "premium rate",
    PhoneNumberType.SHARED_COST: "shared cost",
    PhoneNumberType.VOIP: "voip",
    PhoneNumberType.PERSONAL_NUMBER: "personal number",
    PhoneNumberType.PAGER: "pager",
    PhoneNumberType.UAN: "universal access number",
    PhoneNumberType.VOICEMAIL: "voicemail",
    PhoneNumberType.UNKNOWN: "unknown",
}


@dataclass
class NumberReport:
    """Everything we can determine about one phone number."""

    input: str
    valid: bool
    possible: bool
    e164: str = ""
    international: str = ""
    national: str = ""
    rfc3966: str = ""
    country: str = ""
    country_code: str = ""
    region_code: str = ""
    location: str = ""
    carrier: str = ""
    line_types: str = ""
    timezones: str = ""
    notes: str = ""
    error: str = ""


def _type_names(t: int) -> str:
    return TYPE_NAMES.get(t, str(t))


def _parse(raw: str, region: Optional[str] = None):
    """Thin wrapper so callers can branch on failure without try/except."""
    try:
        return phonenumbers.parse(raw, region), ""
    except phonenumbers.NumberParseException as exc:
        return None, str(exc)


def _detect(raw: str, region: Optional[str] = None):
    """Interpret a number that was written without a leading '+'.

    Resolution order:
      1. the region supplied via --region, if the result is actually valid
      2. the whole string as an international number ('+' + digits) — a long
         digit run that begins with a real country code is strong evidence
      3. every supported region, but only when EXACTLY ONE round-trips back
         to the digits we were given

    Step 3 deliberately refuses to guess: a bare national number such as
    '0612345678' is valid in dozens of countries, and picking one at random
    would invent a wrong answer. Ambiguity is reported instead.

    Returns (parsed, note) or (None, reason).
    """
    digits = phonenumbers.normalize_digits_only(raw)
    region_note = f" (--region {region} did not match)" if region else ""

    # 1. Explicit region, trusted only if it yields a valid number.
    if region:
        parsed, _ = _parse(raw, region)
        if parsed is not None and phonenumbers.is_valid_number(parsed):
            return parsed, ""

    if digits:
        # 2. International number missing its '+' (also handles the '00'
        #    international dial prefix used across much of Europe and Asia).
        for candidate in ("+" + digits, "+" + digits[2:] if digits[:2] == "00" else None):
            if not candidate:
                continue
            parsed, _ = _parse(candidate)
            if parsed is not None and phonenumbers.is_valid_number(parsed):
                return parsed, "interpreted as international number missing '+'"

        # 3. Unique national-format match.
        matches = _national_matches(raw, digits)
        if len(matches) == 1:
            reg, parsed = matches[0]
            return parsed, f"detected region {reg}{region_note}"
        if len(matches) > 1:
            regs = ", ".join(r for r, _ in matches)
            return None, (
                f"ambiguous: valid as a national number in {len(matches)} countries "
                f"({regs}); re-run with --region CC to disambiguate"
            )

    return None, (
        "could not determine the region; re-run with --region CC "
        "(e.g. --region KE) or prefix the number with '+'"
        + (f"; --region {region} did not yield a valid number" if region else "")
    )


@lru_cache(maxsize=4096)
def _national_matches(raw: str, digits: str) -> tuple:
    """Regions whose national formatting of `raw` round-trips to `digits`."""
    matches = []
    for reg in sorted(phonenumbers.SUPPORTED_REGIONS):
        parsed, _ = _parse(raw, reg)
        if parsed is None or not phonenumbers.is_valid_number(parsed):
            continue
        nat = phonenumbers.format_number(parsed, PhoneNumberFormat.NATIONAL)
        if phonenumbers.normalize_digits_only(nat) == digits:
            matches.append((reg, parsed))
    return tuple(matches)


def lookup(raw: str, region: Optional[str] = None) -> NumberReport:
    """Parse `raw` and return a full report. `region` is an ISO country code
    used to interpret numbers written without a leading '+' (e.g. 'FR')."""
    raw = (raw or "").strip()
    report = NumberReport(input=raw, valid=False, possible=False)

    if not raw:
        report.error = "empty input"
        return report

    if raw.lstrip().startswith("+"):
        parsed, err = _parse(raw, region)
        if parsed is None:
            report.error = err
            return report
    else:
        parsed, err = _detect(raw, region)
        if parsed is None:
            report.error = err
            return report
        report.notes = err

    report.valid = phonenumbers.is_valid_number(parsed)
    report.possible = phonenumbers.is_possible_number(parsed)

    if not report.possible:
        report.error = "number is not possible for any region"
        return report

    report.e164 = phonenumbers.format_number(parsed, PhoneNumberFormat.E164)
    report.international = phonenumbers.format_number(
        parsed, PhoneNumberFormat.INTERNATIONAL
    )
    report.national = phonenumbers.format_number(parsed, PhoneNumberFormat.NATIONAL)
    report.rfc3966 = phonenumbers.format_number(parsed, PhoneNumberFormat.RFC3966)

    report.country_code = str(parsed.country_code)
    report.region_code = phonenumbers.region_code_for_number(parsed) or ""

    report.country = geocoder.country_name_for_number(parsed, "en") or ""

    report.location = geocoder.description_for_number(parsed, "en") or ""
    report.carrier = carrier.name_for_number(parsed, "en") or ""

    nt = number_type(parsed)
    # FIXED_LINE_OR_MOBILE means the numbering plan doesn't distinguish them.
    report.line_types = _type_names(nt)

    tzs = timezone.time_zones_for_number(parsed)
    report.timezones = ", ".join(tzs) if tzs else ""

    if not report.valid:
        report.error = "number is possible but not valid"

    return report


# --------------------------------------------------------------------------- #
# Batch processing
# --------------------------------------------------------------------------- #

REPORT_COLUMNS = [f.name for f in fields(NumberReport)]


def lookup_many(
    numbers: Iterable[str], region: Optional[str] = None
) -> list[NumberReport]:
    return [lookup(n, region) for n in numbers]


def read_column(path: str, column: str) -> list[str]:
    """Read numbers from a CSV (`column` by header/name/index) or plain text."""
    if not path.lower().endswith(".csv"):
        with open(path, encoding="utf-8") as fh:
            return [line.strip() for line in fh if line.strip()]

    with open(path, newline="", encoding="utf-8") as fh:
        sample = fh.read(4096)
        fh.seek(0)
        delimiter = csv.Sniffer().sniff(sample, delimiters=",;\t").delimiter
        reader = csv.DictReader(fh, delimiter=delimiter)
        if reader.fieldnames is None:
            return []

        if column.isdigit():
            idx = int(column)
            return [row[reader.fieldnames[idx]].strip() for row in reader]
        if column not in reader.fieldnames:
            raise SystemExit(
                f"column {column!r} not found; available: {reader.fieldnames}"
            )
        return [row[column].strip() for row in reader]


def write_report(path: str, reports: list[NumberReport]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=REPORT_COLUMNS)
        writer.writeheader()
        for r in reports:
            writer.writerow(asdict(r))


# --------------------------------------------------------------------------- #
# Display
# --------------------------------------------------------------------------- #

LABELS = [
    ("input", "Input"),
    ("valid", "Valid"),
    ("e164", "E.164"),
    ("international", "International"),
    ("national", "National"),
    ("rfc3966", "RFC 3966"),
    ("country", "Country"),
    ("country_code", "Country code"),
    ("region_code", "Region"),
    ("location", "Location"),
    ("carrier", "Carrier"),
    ("line_types", "Line type"),
    ("timezones", "Time zones"),
    ("notes", "Notes"),
    ("error", "Error"),
]


def print_report(r: NumberReport) -> None:
    width = max(len(label) for _, label in LABELS)
    print("-" * (width + 42))
    for key, label in LABELS:
        value = getattr(r, key)
        if value in ("", False, None):
            if key in ("valid", "error"):
                value = "no" if key == "valid" else "-"
            else:
                value = "-"
        print(f"  {label:<{width}} : {value}")


def summary(reports: list[NumberReport]) -> None:
    total = len(reports)
    valid = sum(r.valid for r in reports)
    print(
        f"\n  {total} number(s) processed — {valid} valid, {total - valid} invalid"
    )


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="phone_tracker.py",
        description="Validate and look up phone numbers offline.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "examples:\n"
            '  phone_tracker.py "+14155552671"\n'
            "  phone_tracker.py 0612345678 --region FR\n"
            "  phone_tracker.py --batch numbers.txt\n"
            '  phone_tracker.py --batch contacts.csv --column phone --out report.csv\n'
        ),
    )
    p.add_argument("number", nargs="*", help="phone number(s) to look up")
    p.add_argument(
        "-r",
        "--region",
        metavar="CC",
        help="ISO country code for numbers without a leading '+' (e.g. US, FR)",
    )
    p.add_argument("-b", "--batch", metavar="FILE", help="file of numbers (.txt/.csv)")
    p.add_argument(
        "-c",
        "--column",
        default="0",
        help="CSV column: header name or 0-based index (default: 0)",
    )
    p.add_argument("-o", "--out", metavar="FILE", help="write results to CSV")
    p.add_argument("-i", "--interactive", action="store_true", help="REPL mode")
    p.add_argument(
        "-q", "--quiet", action="store_true", help="suppress per-number details"
    )
    return p


def interactive(region: Optional[str]) -> None:
    print("phone lookup — enter a number, or blank line / Ctrl-D to quit")
    while True:
        try:
            raw = input("\nnumber> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not raw:
            break
        print_report(lookup(raw, region))


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)

    numbers: list[str] = list(args.number)
    if args.batch:
        try:
            numbers.extend(read_column(args.batch, args.column))
        except OSError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2

    if args.interactive or not numbers:
        if not args.interactive and sys.stdin.isatty():
            build_parser().print_help()
            return 0
        if args.interactive:
            interactive(args.region)
            return 0
        # Piped input, e.g. `cat numbers.txt | phone_tracker.py`
        numbers = [line.strip() for line in sys.stdin if line.strip()]
        if not numbers:
            return 0

    reports = lookup_many(numbers, args.region)

    if not args.quiet:
        for r in reports:
            print_report(r)

    summary(reports)

    if args.out:
        write_report(args.out, reports)
        print(f"  wrote {args.out}")

    # Non-zero exit if every number failed — handy for scripts/CI.
    return 0 if any(r.valid for r in reports) else 1


if __name__ == "__main__":
    raise SystemExit(main())
