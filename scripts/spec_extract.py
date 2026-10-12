#!/usr/bin/env python3
"""Extract the contract and operation catalogue of the ledger model from the
Daml sources in main/, for docs/SPECIFICATION.md.

For every template: its fields, signatories, observers and ensure clause.
For every choice: its controllers, parameters, whether it consumes the
contract, the preconditions it asserts (assertMsg / abort messages, plus the
checks of the helpers it calls), and what it creates or exercises.

    scripts/spec_extract.py            # print the Markdown catalogue
    scripts/spec_extract.py --json     # the same as JSON
    scripts/spec_extract.py --write    # replace the generated section of docs/SPECIFICATION.md

The parser relies on the house style of main/ (four-space template bodies,
one field per line, `choice Name : Type` headers); it fails loudly rather
than guessing when that style is broken.
"""
import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(REPO, "main", "daml", "Zuecan")
SPEC = os.path.join(REPO, "docs", "SPECIFICATION.md")
BEGIN = "<!-- BEGIN GENERATED: scripts/spec_extract.py -->"
END = "<!-- END GENERATED -->"
MODULE_ORDER = ["Types", "Compliance", "Cash", "Fund", "Portfolio", "Registry", "Market", "Subscription"]
# `create <variable>` in the sources, by what the variable holds.
CREATED_VARS = {"this": "(new version)", "next": "(new version)", "proposed": "FundTerms", "newTerms": "FundTerms"}
HELPER_EFFECTS = {
    "deliver": "create FundHolding",
    "carveOut": "create FundHolding (remainder)",
    "recordEnforcement": "create EnforcementRecord",
}
HELPERS = ["checkEligible", "checkScreened", "checkNav", "checkTermsFor", "carveOut", "deliver", "recordEnforcement"]


def messages(lines):
    out = []
    for line in lines:
        for m in re.finditer(r'\b(assertMsg|abort)\s+\(?"((?:[^"\\]|\\.)*)"', line):
            out.append(m.group(2))
    return out


def doc_above(lines, i):
    doc = []
    j = i - 1
    while j >= 0 and re.match(r"^\s*--", lines[j]):
        doc.insert(0, re.sub(r"^\s*--\s?\|?\s?", "", lines[j]).strip())
        j -= 1
    return " ".join(d for d in doc if d)


def block(lines, start, indent):
    """Lines after `start` that are blank or indented deeper than `indent`."""
    out = []
    for line in lines[start + 1:]:
        if line.strip() and len(line) - len(line.lstrip()) <= indent and not line.lstrip().startswith("--"):
            break
        out.append(line)
    return out


def clause(body, keyword):
    """The text of `keyword ...` in a template body, continuation lines included."""
    for i, line in enumerate(body):
        m = re.match(rf"^    {keyword}\s+(.*)$", line)
        if m:
            text = [m.group(1).strip()]
            for nxt in body[i + 1:]:
                if re.match(r"^      \S", nxt):
                    text.append(nxt.strip())
                else:
                    break
            return " ".join(text)
    return None


def parse_helpers(all_lines):
    helpers = {}
    for lines in all_lines:
        for i, line in enumerate(lines):
            m = re.match(r"^(\w+)\s*:", line)
            if m and m.group(1) in HELPERS:
                name = m.group(1)
                # The body follows the definition line(s) `name args = ...`.
                j = i + 1
                while j < len(lines) and re.match(rf"^{name}\b", lines[j]):
                    j += 1
                helpers[name] = {"doc": doc_above(lines, i), "checks": messages(lines[i + 1:j] + block(lines, j - 1, 0))}
    return helpers


def parse_module(name):
    lines = open(os.path.join(SRC, name + ".daml")).read().splitlines()
    header = []
    for line in lines:
        if line.startswith("--"):
            header.append(re.sub(r"^--\s?\|?\s?", "", line).strip())
        else:
            break
    templates = []
    for i, line in enumerate(lines):
        m = re.match(r"^template (\w+)\s*$", line)
        if not m:
            continue
        body = block(lines, i, 0)
        fields = []
        in_with = False
        for b in body:
            if re.match(r"^  with\s*$", b):
                in_with = True
                continue
            if re.match(r"^  where\s*$", b):
                break
            fm = re.match(r"^    (\w+)\s*:\s*(.+?)\s*(?:--\s*\^\s*(.*))?$", b)
            if in_with and fm:
                fields.append({"name": fm.group(1), "type": fm.group(2), "note": fm.group(3) or ""})
        choices = []
        for k, b in enumerate(body):
            cm = re.match(r"^    (nonconsuming\s+)?choice (\w+)\s*:\s*(.+)$", b)
            if not cm:
                continue
            cbody = block(body, k, 4)
            params, controller, effects, helpers_used = [], None, [], []
            in_params = False
            for c in cbody:
                if re.match(r"^      with\s*$", c):
                    in_params = True
                    continue
                ctl = re.match(r"^      controller\s+(.+)$", c)
                if ctl:
                    controller = ctl.group(1).strip()
                    in_params = False
                    continue
                pm = re.match(r"^        (\w+)\s*:\s*(.+?)\s*(?:--\s*\^\s*(.*))?$", c)
                if in_params and pm:
                    params.append({"name": pm.group(1), "type": pm.group(2), "note": pm.group(3) or ""})
                for em in re.finditer(r"\bcreate\s+(\w+)", c):
                    target = em.group(1)
                    effects.append("create " + (target if target[0].isupper() else CREATED_VARS.get(target, f"({target})")))
                for em in re.finditer(r"\bexercise\s+\w+\s+(?:Cash\.)?([A-Z]\w*)", c):
                    effects.append("exercise " + em.group(1))
                for em in re.finditer(r"\barchive\s+\w+", c):
                    effects.append("archive (fetched contract)")
                for h in HELPERS:
                    if re.search(rf"\b{h}\b", c) and h not in helpers_used:
                        helpers_used.append(h)
            for h in helpers_used:
                if h in HELPER_EFFECTS:
                    effects.append(HELPER_EFFECTS[h])
            if controller is None:
                raise SystemExit(f"{name}.{m.group(1)}.{cm.group(2)}: no controller line found")
            choices.append({
                "name": cm.group(2),
                "returns": cm.group(3).strip(),
                "consuming": not cm.group(1),
                "doc": doc_above(body, k),
                "controller": controller,
                "params": params,
                "checks": messages(cbody),
                "helpers": helpers_used,
                "effects": sorted(set(effects), key=effects.index),
            })
        templates.append({
            "name": m.group(1),
            "doc": doc_above(lines, i),
            "fields": fields,
            "signatory": clause(body, "signatory"),
            "observer": clause(body, "observer"),
            "ensure": clause(body, "ensure"),
            "choices": choices,
        })
    return {"module": "Zuecan." + name, "doc": " ".join(h for h in header if h), "templates": templates}


def extract():
    modules = [parse_module(n) for n in MODULE_ORDER if os.path.exists(os.path.join(SRC, n + ".daml"))]
    all_lines = [open(os.path.join(SRC, n + ".daml")).read().splitlines() for n in MODULE_ORDER]
    return {"modules": modules, "helpers": parse_helpers(all_lines)}


def md_escape(s):
    return s.replace("|", "\\|")


def markdown(cat):
    out = [BEGIN, "", "> 本節由 `scripts/spec_extract.py` 從 `main/daml/Zuecan/*.daml` 產生，請勿手改；改程式碼後重新產生。", ""]
    n_t = sum(len(m["templates"]) for m in cat["modules"])
    n_c = sum(len(t["choices"]) for m in cat["modules"] for t in m["templates"])
    n_k = sum(len(c["checks"]) for m in cat["modules"] for t in m["templates"] for c in t["choices"])
    out += [f"共 {n_t} 個 template、{n_c} 個 choice（不含內建 `Archive`）、{n_k} 條 choice 內的前置條件，另加 §C.0 輔助函式的檢查。", ""]
    out += ["### C.0 共用檢查（輔助函式）", "", "| 函式 | 說明 | 檢查（失敗訊息） |", "|---|---|---|"]
    for h in HELPERS:
        if h in cat["helpers"]:
            info = cat["helpers"][h]
            checks = "<br>".join(f"`{md_escape(c)}`" for c in info["checks"]) or "—"
            out.append(f"| `{h}` | {md_escape(info['doc'])} | {checks} |")
    out.append("")
    sec = 0
    for m in cat["modules"]:
        if not m["templates"]:
            continue
        sec += 1
        out += [f"### C.{sec} `{m['module']}`", ""]
        for t in m["templates"]:
            out += [f"#### `{t['name']}`", ""]
            if t["doc"]:
                out += [t["doc"], ""]
            out += [f"- **signatory**：`{t['signatory']}`"]
            if t["observer"]:
                out += [f"- **observer**：`{t['observer']}`"]
            if t["ensure"]:
                out += [f"- **ensure**：`{t['ensure']}`"]
            out += ["", "| 欄位 | 型別 | 說明 |", "|---|---|---|"]
            out += [f"| `{f['name']}` | `{md_escape(f['type'])}` | {md_escape(f['note'])} |" for f in t["fields"]]
            out.append("")
            if t["choices"]:
                out += ["| choice | controller | 消耗 | 參數 | 前置條件（失敗訊息） | 效果 |", "|---|---|---|---|---|---|"]
                for c in t["choices"]:
                    params = "<br>".join(f"`{p['name']} : {md_escape(p['type'])}`" for p in c["params"]) or "—"
                    checks = [f"`{md_escape(x)}`" for x in c["checks"]] + [f"＋`{h}`" for h in c["helpers"] if h in ("checkEligible", "checkScreened", "checkNav", "checkTermsFor", "carveOut")]
                    effects = "<br>".join(md_escape(e) for e in c["effects"]) or "—"
                    out.append(f"| `{c['name']}` | `{c['controller']}` | {'是' if c['consuming'] else '否'} | {params} | {'<br>'.join(checks) or '—'} | {effects} |")
                out.append("")
    out.append(END)
    return "\n".join(out)


def main():
    cat = extract()
    if "--json" in sys.argv:
        print(json.dumps(cat, ensure_ascii=False, indent=2))
    elif "--write" in sys.argv:
        spec = open(SPEC).read()
        if BEGIN not in spec or END not in spec:
            raise SystemExit("docs/SPECIFICATION.md has no generated-section markers")
        before, rest = spec.split(BEGIN, 1)
        _, after = rest.split(END, 1)
        open(SPEC, "w").write(before + markdown(cat) + after)
        print("updated", SPEC)
    elif "--check" in sys.argv:
        spec = open(SPEC).read()
        current = spec[spec.index(BEGIN): spec.index(END) + len(END)]
        if current != markdown(cat):
            print("docs/SPECIFICATION.md is out of date: run scripts/spec_extract.py --write")
            sys.exit(1)
        print("specification catalogue is current")
    else:
        print(markdown(cat))


if __name__ == "__main__":
    main()
