#!/usr/bin/env python3
"""Fail when retired Promethean deployment authority returns to Proxx."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
import re
import sys
from typing import Iterable


REPOSITORY_ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    rule: str
    text: str


GLOBAL_RULES = (
    (
        "services reusable deploy workflow",
        re.compile(
            r"open-hax/services/\.github/workflows/"
            r"deploy-promethean\.yml@"
        ),
    ),
    ("ssh-keyscan trust bootstrap", re.compile(r"\bssh-keyscan\b")),
    (
        "accept-new SSH trust-on-first-use",
        re.compile(r"StrictHostKeyChecking\s*=?\s*accept-new", re.IGNORECASE),
    ),
    ("legacy error home path", re.compile(r"/home/error(?:/|\b)")),
    (
        "legacy error SSH identity",
        re.compile(
            r"\b(?:DEPLOY_USER|(?:STAGING|TESTING|PRODUCTION)_SSH_USER)\b"
            r"[^\n]{0,160}(?:\|\|\s*)?['\"]?error(?:['\"]|\b)",
            re.IGNORECASE,
        ),
    ),
    (
        "direct legacy error SSH identity",
        re.compile(
            r"\b(?:ssh|scp|sftp|rsync)\b"
            r"(?:(?:\\\r?\n)|[^\r\n]){0,320}"
            r"(?<![\w.-])error@[A-Z0-9._-]+\b",
            re.IGNORECASE,
        ),
    ),
    (
        "legacy deployment promotion check",
        re.compile(r"\b(?:deploy-staging|staging-live-e2e)\b"),
    ),
)

WORKFLOW_HOST_RULE = (
    "legacy Promethean workflow host",
    re.compile(r"promethean\.rest", re.IGNORECASE),
)

TARGET_HOST_RULE = (
    "legacy Promethean deployment host",
    re.compile(r"\bDEPLOY_HOST\b[^\n]{0,200}promethean\.rest", re.IGNORECASE),
)


def candidate_paths(root: Path) -> Iterable[Path]:
    workflow_dir = root / ".github" / "workflows"
    if workflow_dir.is_dir():
        yield from workflow_dir.rglob("*.yml")
        yield from workflow_dir.rglob("*.yaml")

    scripts_dir = root / "scripts"
    if scripts_dir.is_dir():
        yield from scripts_dir.rglob("*.sh")

    targets_dir = root / "deploy" / "targets"
    if targets_dir.is_dir():
        yield from (path for path in targets_dir.rglob("*") if path.is_file())


def line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def scan_text(relative_path: str, text: str) -> list[Finding]:
    rules = list(GLOBAL_RULES)
    if relative_path.startswith(".github/workflows/"):
        rules.append(WORKFLOW_HOST_RULE)
    if relative_path.startswith("deploy/targets/"):
        rules.append(TARGET_HOST_RULE)

    findings: list[Finding] = []
    source_lines = text.splitlines()
    for rule, pattern in rules:
        for match in pattern.finditer(text):
            line = line_number(text, match.start())
            source_line = source_lines[line - 1].strip()
            findings.append(Finding(relative_path, line, rule, source_line))
    return findings


def scan_repository(root: Path) -> list[Finding]:
    findings: list[Finding] = []
    for path in sorted(set(candidate_paths(root))):
        relative_path = path.relative_to(root).as_posix()
        text = path.read_text(encoding="utf-8")
        findings.extend(scan_text(relative_path, text))
    return findings


def run_self_test() -> None:
    forbidden = (
        (
            ".github/workflows/deploy.yml",
            "uses: open-hax/services/.github/workflows/deploy-promethean.yml@main\n",
            "services reusable deploy workflow",
        ),
        (
            ".github/workflows/deploy.yml",
            "run: ssh-keyscan -H legacy.example >> ~/.ssh/known_hosts\n",
            "ssh-keyscan trust bootstrap",
        ),
        (
            "scripts/deploy.sh",
            "ssh -o StrictHostKeyChecking=accept-new deploy@example\n",
            "accept-new SSH trust-on-first-use",
        ),
        (
            "deploy/targets/legacy.env",
            "DEPLOY_PATH=/home/error/services/proxx\n",
            "legacy error home path",
        ),
        (
            "deploy/targets/legacy.env",
            "DEPLOY_USER=error\n",
            "legacy error SSH identity",
        ),
        (
            "scripts/legacy-return.sh",
            "ssh error@ussy3.promethean.rest uname -a\n",
            "direct legacy error SSH identity",
        ),
        (
            "scripts/continued-legacy-return.sh",
            "ssh -o BatchMode=yes \\\n  error@ussy3.promethean.rest uname -a\n",
            "direct legacy error SSH identity",
        ),
        (
            ".github/workflows/deploy.yml",
            "STAGING_SSH_HOST: ussy3.promethean.rest\n",
            "legacy Promethean workflow host",
        ),
        (
            ".github/workflows/main-pr-gate.yml",
            'const requiredChecks = ["deploy-staging", "staging-live-e2e"];\n',
            "legacy deployment promotion check",
        ),
        (
            "deploy/targets/legacy.env",
            "DEPLOY_HOST=big.ussy.promethean.rest\n",
            "legacy Promethean deployment host",
        ),
    )

    for relative_path, text, expected_rule in forbidden:
        rules = {finding.rule for finding in scan_text(relative_path, text)}
        if expected_rule not in rules:
            raise AssertionError(
                f"self-test did not reject {expected_rule!r} in {relative_path}"
            )

    safe = {
        ".github/workflows/code-quality.yml": "run: python3 scripts/check.py\n",
        "scripts/deploy.sh": (
            "ssh -o UserKnownHostsFile=/run/secrets/known_hosts deploy@example\n"
        ),
        "scripts/bootstrap.sh": (
            "FEDERATION_DEFAULT_OWNER_SUBJECT=did:web:example.invalid\n"
        ),
    }
    for relative_path, text in safe.items():
        findings = scan_text(relative_path, text)
        if findings:
            raise AssertionError(
                f"self-test rejected safe fixture {relative_path}: {findings}"
            )

    print(f"deployment-authority self-test passed ({len(forbidden)} retired patterns)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="exercise every retired pattern and a safe pinned-known-hosts fixture",
    )
    args = parser.parse_args()

    if args.self_test:
        run_self_test()
        return 0

    findings = scan_repository(REPOSITORY_ROOT)
    if findings:
        print("Retired deployment authority detected:", file=sys.stderr)
        for finding in findings:
            print(
                f"{finding.path}:{finding.line}: {finding.rule}: {finding.text}",
                file=sys.stderr,
            )
        return 1

    print("deployment authority boundary passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
