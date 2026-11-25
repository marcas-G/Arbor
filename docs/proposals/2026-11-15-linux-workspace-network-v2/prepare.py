"""Prepare a reviewable design patch without modifying any owning document."""

import difflib
import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
PROPOSAL = OUT.with_suffix(".md")
proposal_bytes = PROPOSAL.read_bytes()
proposal = proposal_bytes.decode("utf-8")
proposal_hash = hashlib.sha256(proposal_bytes).hexdigest()


def section(title):
    marker = f"\n{title}\n"
    start = proposal.index(marker) + 1
    level = len(title) - len(title.lstrip("#"))
    cursor = start + len(title) + 1
    for line in proposal[cursor:].splitlines(keepends=True):
        if line.startswith("#"):
            depth = len(line) - len(line.lstrip("#"))
            if depth <= level:
                return proposal[start:cursor].strip()
        cursor += len(line)
    return proposal[start:].strip()


user_flow = section("## 1. 用户实际得到什么")
changes = section("## 2. 明确替换的旧要求")
isolation = section("## 3. 执行和通信边界")
network = section("## 4. 公网通道的精确语义")
versions = section("## 5. 版本和存储隔离")
production = section("## 6. 资格和正式装配")
acceptance = section("## 7. 交付判据与授权边界")
contracts = section("## 8. 联网命令的固定技术合同")
rules = section("### 8.1 新规则和控制字节")
policy = section("### 8.2 Command、snapshot、receipt 与内部 process policy")
storage = section("### 8.3 SQLite 和版本兼容")
qualification = section("### 8.4 受信 Linux 资格材料")

# Each owner's postimage contains the semantics it owns. The proposal hash
# binds the whole package; cross-references do not grant implementation or
# turn the prepared patch into an accepted design.
landings = {
    "docs/design/01-scenarios.md": user_flow,
    "docs/design/02-system-design.md": "\n\n".join(
        [changes, isolation, network]
    ),
    "docs/design/03-detailed-implementation-design.md": "\n\n".join(
        [versions, contracts]
    ),
    "docs/design/implementation/P1/01-command-contracts.md": policy,
    "docs/design/implementation/P1/02-port-contracts.md": policy,
    "docs/design/implementation/P1/04-sqlite-schema.md": storage,
    "docs/design/implementation/P4/04-sandbox.md": "\n\n".join(
        [isolation, network, policy]
    ),
    "docs/design/implementation/P5/01-composition-root.md": "\n\n".join(
        [production, qualification]
    ),
    "docs/design/implementation/P10/05-surface-actions-transport.md": (
        "New Linux V2 candidates explicitly carry policySchemaVersion=2; "
        "schema 1 candidates retain their existing representation. The "
        "candidate is derived from the current verified exact registry "
        "tuple and qualification, not from providerId alone. It does not "
        "grant authority or report an Experimental host as Supported. "
        "The chosen version reaches the existing Command boundary and "
        "strict response decoder. No service/preview API is introduced."
    ),
    "docs/design/implementation/P13/02-command-exposure-matrix.md": (
        "The existing human DecideSandboxPolicy surface may submit schema "
        "2 only for a deliberately selected Linux V2 candidate whose "
        "policySchemaVersion is exactly 2. The payload fields, human "
        "authority and full CAS remain unchanged; UI must not guess a "
        "version from providerId or silently retry schema 1. Display "
        "same-workspace TCP and ordinary end-to-end HTTPS accurately; "
        "do not claim TLS-content inspection, IPv6-only egress, or "
        "unqualified command availability. No new model control, "
        "permission or service/preview API is introduced."
    ),
    "docs/design/implementation/P12/12-providers-tools.md": production,
    "docs/design/implementation/P12/13-security-performance.md": "\n\n".join(
        [network, rules, qualification]
    ),
    "docs/design/implementation/P12/14-acceptance.md": "\n\n".join(
        [acceptance, qualification]
    ),
}

header_changes = {
    "docs/design/01-scenarios.md": [
        ("**Version:** 1.10\n", "**Version:** 1.11\n"),
        ("**Date:** 2026-10-26\n", "**Date:** 2026-11-15\n"),
    ],
    "docs/design/02-system-design.md": [
        ("**Version:** 1.25\n", "**Version:** 1.26\n"),
        ("**Supersedes:** v1.24\n", "**Supersedes:** v1.25\n"),
        ("**Date:** 2026-10-26\n", "**Date:** 2026-11-15\n"),
        ("`Arbor Scenarios S1–S4 v1.10`", "`Arbor Scenarios S1–S4 v1.11`"),
    ],
    "docs/design/03-detailed-implementation-design.md": [
        ("**Version:** 1.65\\\n", "**Version:** 1.66\\\n"),
        ("**Supersedes:** v1.64\\\n", "**Supersedes:** v1.65\\\n"),
        ("**Date:** 2026-10-26\\\n", "**Date:** 2026-11-15\\\n"),
        (
            "**Depends on:** `Arbor System Design Specification v1.25`",
            "**Depends on:** `Arbor System Design Specification v1.26`",
        ),
    ],
}

diffs = []
files = []
for path, content in landings.items():
    original = (ROOT / path).read_text()
    updated = original
    for old, new in header_changes.get(path, []):
        if updated.count(old) != 1:
            raise ValueError(f"ambiguous owning header: {path}: {old!r}")
        updated = updated.replace(old, new, 1)
    marker = (
        "\n\n## Linux workspace networking V2 governance supplement\n\n"
        "Accepted under `ACCEPT_LINUX_WORKSPACE_NETWORK_V2`; proposal "
        f"SHA-256 `{proposal_hash}`.\n\n"
        "This supplement owns only the Linux V2 changes assigned to this "
        "document. For V2 it supersedes the conflicting first-release "
        "Windows-only, blanket loopback-denial, V1 broker and discovery "
        "clauses; V1/Windows/historical evidence retain their original "
        "meaning. It creates no Supported result, migration execution, "
        "preserved-database upgrade or release claim. Service registration, "
        "cross-command service reuse and preview still require their "
        "separate exact contract and acceptance; the full product goal "
        "is not reduced. DID 1.66 owns the closed technical definitions.\n\n"
    )
    # Lower imported headings so they remain inside the supplement.
    nested = "\n".join(
        "##" + line if line.startswith("#") else line
        for line in content.splitlines()
    )
    updated = updated.rstrip() + marker + nested + "\n"
    diffs.extend(
        difflib.unified_diff(
            original.splitlines(keepends=True),
            updated.splitlines(keepends=True),
            fromfile=f"a/{path}",
            tofile=f"b/{path}",
        )
    )
    files.append(
        {
            "path": path,
            "beforeSha256": hashlib.sha256(original.encode()).hexdigest(),
            "afterSha256": hashlib.sha256(updated.encode()).hexdigest(),
        }
    )

patch = "".join(diffs)
(OUT / "landing.patch").write_text(patch)
manifest = {
    "status": "PREPARED_NOT_ACCEPTED",
    "proposal": str(PROPOSAL.relative_to(ROOT)),
    "proposalSha256": proposal_hash,
    "preparerSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    "patchSha256": hashlib.sha256(patch.encode()).hexdigest(),
    "files": files,
    "designFilesModifiedByPreparation": False,
}
(OUT / "manifest.json").write_text(
    json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
)
for file in files:
    assert (
        hashlib.sha256((ROOT / file["path"]).read_bytes()).hexdigest()
        == file["beforeSha256"]
    ), "preparation unexpectedly modified an owning document"
print(json.dumps({"status": manifest["status"], "owners": len(files), "proposalSha256": proposal_hash}))
