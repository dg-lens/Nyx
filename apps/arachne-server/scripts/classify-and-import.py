#!/usr/bin/env python3
"""Classify the local Arachne vault into mesh|local and import the mesh subset.

Phase-4 importer (arachne-server README). Hard rules are FAIL-CLOSED: anything
touching the secret / auth / topology map stays local even if a heuristic would
share it. General diagnostic knowledge (lessons, invariants, decisions,
playbooks, mocs about mechanisms) defaults to mesh — the point of the shared graph.

Usage:
  classify-and-import.py --dry-run                 # manifest only, no network
  classify-and-import.py --import --token <tok>    # push mesh nodes to --url
"""
import argparse, json, os, re, sys, urllib.request, urllib.error
from pathlib import Path

VAULT = Path(os.environ.get("NYX_DATA_DIR", str(Path.home() / "Nyx/Data"))) / "memory" / "nodes"

# FAIL-CLOSED hard-local signals: the security/auth/topology MAP.
SECURITY_RX = re.compile(
    r"(\bbitwarden\b|\bbws\b|\bcredential|\bpassword\b|\bapi[_-]?key\b|"
    r"\bsecret[_-]?(key|value|store|name|manager)\b|\bmachine[_-]?token\b|"
    r"\btoken_hash\b|\bplatform[_-]?token\b|\bprivate[_-]?key\b|\btailscale\b|"
    r"\bssh\b|/\.config/bitwarden|\boauth\b|\bdenylist\b|\baccess[_-]?token\b|"
    r"\bservice[_-]?role[_-]?key\b|\bauth[_-]?token\b)",
    re.I,
)
# loc segments that are inherently secret-scoped.
LOCAL_LOC_RX = re.compile(r"\.secrets\b", re.I)

def parse_frontmatter(text):
    if not text.startswith("---"):
        return None, text
    end = text.find("\n---", 3)
    if end == -1:
        return None, text
    fm_raw, body = text[3:end].strip("\n"), text[end + 4:].lstrip("\n")
    fm, key = {}, None
    for line in fm_raw.split("\n"):
        if re.match(r"^\s*#", line) or not line.strip():
            continue
        m = re.match(r"^([a-zA-Z_]+):\s*(.*)$", line)
        if m:
            key, val = m.group(1), m.group(2).strip()
            if val.startswith("[") and val.endswith("]"):
                fm[key] = [x.strip().strip('"\'') for x in val[1:-1].split(",") if x.strip()]
            elif val == "":
                fm[key] = []
            else:
                fm[key] = val.strip('"\'')
        elif key and re.match(r"^\s*-\s+", line):
            fm.setdefault(key, [])
            if isinstance(fm[key], list):
                fm[key].append(re.sub(r"^\s*-\s+", "", line).strip().strip('"\''))
    return fm, body

def as_list(v):
    return v if isinstance(v, list) else ([v] if v else [])

def classify(fm, body):
    concern = [c.lower() for c in as_list(fm.get("concern"))]
    loc = " ".join(as_list(fm.get("loc")))
    hay = " ".join([
        fm.get("id", ""), fm.get("title", ""), fm.get("summary", ""),
        " ".join(as_list(fm.get("triggers"))), " ".join(as_list(fm.get("paths"))),
    ])
    if "secrets" in concern:
        return "local", "concern:secrets"
    if LOCAL_LOC_RX.search(loc):
        return "local", "loc:*.secrets"
    if SECURITY_RX.search(hay):
        return "local", f"security-map signal in metadata"
    if SECURITY_RX.search(body[:1200]):
        return "local", "security-map signal in body"
    kind = (fm.get("kind") or "").lower()
    if kind in ("lesson", "invariant", "decision", "playbook", "reference", "moc", "overview", "pattern", "ruleset", "proposal"):
        return "mesh", f"kind:{kind} (general knowledge, no security-map signal)"
    return "local", f"unrecognized kind:{kind or '?'} — fail-closed"

def to_write_input(fm, body):
    def num(v, d):
        try: return int(v)
        except Exception: return d
    return {
        "id": fm.get("id"), "kind": fm.get("kind", "reference"),
        "title": fm.get("title", fm.get("id", "")), "summary": fm.get("summary", ""),
        "body": body, "loc": as_list(fm.get("loc")), "concern": as_list(fm.get("concern")),
        "load": fm.get("load", "match"), "audience": as_list(fm.get("audience")) or ["all"],
        "weight": num(fm.get("weight"), 4), "paths": as_list(fm.get("paths")),
        "symbols": as_list(fm.get("symbols")), "triggers": as_list(fm.get("triggers")),
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--import", dest="do_import", action="store_true")
    ap.add_argument("--url", default="https://lens-arachne.fly.dev")
    ap.add_argument("--token", default=os.environ.get("ARACHNE_TOKEN_NYX", ""))
    ap.add_argument("--manifest", default=str(Path(os.environ.get("NYX_DATA_DIR", str(Path.home()/"Nyx/Data")))/"dev"/"arachne-import-manifest.md"))
    a = ap.parse_args()

    rows, mesh_nodes = [], []
    for f in sorted(VAULT.glob("*.md")):
        fm, body = parse_frontmatter(f.read_text(encoding="utf-8"))
        if not fm or not fm.get("id"):
            rows.append((f.name, "local", "no frontmatter/id — fail-closed")); continue
        dest, why = classify(fm, body)
        rows.append((fm["id"], dest, why))
        if dest == "mesh":
            mesh_nodes.append(to_write_input(fm, body))

    mesh = [r for r in rows if r[1] == "mesh"]
    local = [r for r in rows if r[1] == "local"]
    lines = ["# Arachne import manifest", "",
             f"_{len(rows)} nodes · {len(mesh)} mesh · {len(local)} local (held)_", "",
             "## MESH (pushed to lens-arachne)", ""]
    for nid, _, why in sorted(mesh): lines.append(f"- `{nid}` — {why}")
    lines += ["", "## LOCAL (held — security map / fail-closed)", ""]
    for nid, _, why in sorted(local): lines.append(f"- `{nid}` — {why}")
    Path(a.manifest).write_text("\n".join(lines), encoding="utf-8")
    print(f"{len(rows)} nodes: {len(mesh)} mesh, {len(local)} local → manifest {a.manifest}")

    if a.do_import:
        if not a.token:
            print("ERROR: --import needs --token (or ARACHNE_TOKEN_NYX)", file=sys.stderr); sys.exit(2)
        ok = err = 0
        for n in mesh_nodes:
            req = urllib.request.Request(a.url + "/node", method="POST",
                data=json.dumps(n).encode(),
                headers={"Authorization": f"Bearer {a.token}", "Content-Type": "application/json"})
            try:
                urllib.request.urlopen(req, timeout=20); ok += 1
            except urllib.error.HTTPError as e:
                err += 1; print(f"  push {n['id']} -> {e.code} {e.read()[:120]}", file=sys.stderr)
        print(f"pushed {ok}/{len(mesh_nodes)} mesh nodes ({err} errors)")

if __name__ == "__main__":
    main()
