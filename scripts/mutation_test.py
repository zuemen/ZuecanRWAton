#!/usr/bin/env python3
"""Mutation test for the ZuecanRWAton ledger model.

Each mutation removes one safety check or authorisation from main/ (a
condition becomes True, a check becomes `pure ()`, a signatory or controller
is dropped). The suite must fail for every one of them; a mutation that
survives means that rule has no test.

Runs every mutant on a throwaway copy of the repo inside the pinned Daml SDK
image, so an interrupted run never leaves the real sources mutated.

    scripts/mutation_test.py            # all mutants, 3 in parallel
    scripts/mutation_test.py -j 1 "price band"
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMAGE = os.environ.get("DAML_IMAGE", "digitalasset/daml-sdk:3.4.0-rc2")

# (name, module under main/daml/Zuecan, original text, mutated text)
MUTANTS = [
 ("issuance coverage", "Fund", "(liability next nav.navPerUnit <= coverage next)", "True"),
 ("redemption coverage", "Fund", "(liability this nav.navPerUnit <= coverage this)", "True"),
 ("issuance attestation freshness", "Fund", "(isWithin terms.maxAttestationAge now attestedAt)\n        lc <- fetch", "True\n        lc <- fetch"),
 ("redemption attestation freshness", "Fund", "(isWithin terms.maxAttestationAge now attestedAt)\n        assertMsg \"cannot redeem", "True\n        assertMsg \"cannot redeem"),
 ("nav freshness", "Fund", "(isWithin terms.maxNavAge now nav.asOf)", "True"),
 ("nav agent identity", "Fund", "(nav.navAgent == terms.navAgent)", "True"),
 ("register dual control", "Fund", "signatory instrument.registrar, custodian\n    observer readers", "signatory instrument.registrar\n    observer custodian, readers"),
 ("issuance needs subscriber", "Fund", "controller instrument.registrar, subscriber", "controller instrument.registrar"),
 ("redemption needs custodian", "Fund", "controller instrument.registrar, custodian", "controller instrument.registrar"),
 ("redemption pays cash", "Fund", "(cashOut > 0.0)", "True"),
 ("issuance eligibility", "Fund", "checkEligible terms.compliance subscriber terms.eligibility now cred", "pure ()"),
 ("issuance escrow match", "Fund", "lc.payee == custodian", "True"),
 ("issuance minimum", "Fund", "(lc.amount >= terms.minSubscription)", "True"),
 ("issuance status", "Fund", "(status == Open)", "True"),
 ("redemption status", "Fund", "(status /= Suspended)", "True"),
 ("unit rounding down", "Fund", "floor6 (lc.amount / nav.navPerUnit)", "(lc.amount / nav.navPerUnit)"),
 ("terms version bump", "Fund", "(newTerms.version == version + 1)", "True"),
 ("investor class", "Compliance", "(cred.investorClass `elem` eligibility.allowedClasses)", "True"),
 ("jurisdiction", "Compliance", "(cred.jurisdiction `elem` eligibility.allowedJurisdictions)", "True"),
 ("credential expiry", "Compliance", "(now < cred.expiresAt)", "True"),
 ("screening age", "Compliance", "(isWithin eligibility.maxScreeningAge now cred.screenedAt)", "True"),
 ("credential owner", "Compliance", "(cred.investor == investor)", "True"),
 ("credential issuer", "Compliance", "(cred.compliance == compliance)", "True"),
 ("payout before lapse", "Cash", "(now < releaseAfter)", "True"),
 ("payout needs owner", "Cash", "controller lockedTo, owner", "controller lockedTo"),
 ("reclaim after lapse", "Cash", "(now >= releaseAfter)", "True"),
 ("cash transfer bound", "Cash", "(transferAmount > 0.0 && transferAmount <= amount)", "True"),
 ("price band", "Holding", "(bpsDeviation nav.navPerUnit price <= market.maxDeviationBps)", "True"),
 ("market halted", "Holding", "(market.status == Trading)", "True"),
 ("size cap", "Holding", "(units <= market.maxTradeUnits)", "True"),
 ("take lock match", "Holding", "&& lc.issuer == cashIssuer && lc.currency == currency && lc.amount == notional)", ")"),
 ("lock lapses at deadline", "Holding", "(lc.releaseAfter == deadline)", "True"),
 ("order expiry", "Holding", "(now < expiresAt)", "True"),
 ("settle deadline", "Holding", "(now < deadline)", "True"),
 ("abort deadline", "Holding", "(now >= deadline)", "True"),
 ("abort actor", "Holding", "(actor == seller || actor == buyer)", "True"),
 ("transfer receiver eligibility", "Holding", "checkEligible terms.compliance receiver terms.eligibility now cred", "pure ()"),
 ("buyer eligibility", "Holding", "checkEligible terms.compliance buyer terms.eligibility now buyerCred", "pure ()"),
 ("seller screening", "Holding", "checkScreened terms.compliance seller terms.eligibility now sellerCred", "pure ()"),
 ("frozen escrow", "Holding", "assertMsg \"the holding is frozen\" (not h.frozen)", "pure ()"),
 ("min redemption", "Holding", "(units >= terms.minRedemptionUnits)", "True"),
 ("redeemer screening", "Holding", "checkScreened terms.compliance investor terms.eligibility now cred", "pure ()"),
 ("holding dual signature", "Holding", "signatory instrument.registrar, owner\n    observer regulator", "signatory instrument.registrar\n    observer owner, regulator"),
 ("regulator halt lock", "Market", "HaltedByRegulator _ -> abort \"only the regulator can lift a regulatory halt\"", "HaltedByRegulator _ -> create this with status = Trading"),
 ("operator cannot override halt", "Market", "HaltedByRegulator _ -> abort \"the regulator has halted this market\"", "HaltedByRegulator _ -> create this with status = HaltedByOperator reason"),
 ("request matches escrow", "Subscription", "(lc.amount == cashAmount)", "True"),
]


def run(mutant):
    name, module, old, new = mutant
    work = tempfile.mkdtemp(prefix="zuecan-mutant-")
    try:
        shutil.copytree(REPO, work, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns(".git", ".daml"))
        path = os.path.join(work, "main/daml/Zuecan", module + ".daml")
        src = open(path).read()
        if old not in src:
            return name, "PATTERN MISSING", ""
        open(path, "w").write(src.replace(old, new, 1))
        subprocess.run(["chmod", "-R", "a+rwX", work], check=True)
        cmd = ("daml build --all >build.log 2>&1 || { echo BUILD_FAIL; exit 0; }; "
               "cd test && daml test 2>&1 | grep -E ': failed' | head -1")
        r = subprocess.run(["docker", "run", "--rm", "-v", f"{work}:/w", "-w", "/w", IMAGE, "sh", "-c", cmd],
                           capture_output=True, text=True)
        out = r.stdout.strip()
        if "BUILD_FAIL" in out:
            return name, "NO COMPILE", ""
        return name, ("KILLED" if out else "SURVIVED"), out
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-j", "--jobs", type=int, default=3)
    ap.add_argument("names", nargs="*", help="only run mutants with these names")
    args = ap.parse_args()
    todo = [m for m in MUTANTS if not args.names or m[0] in args.names]
    failed = []
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for name, verdict, detail in pool.map(run, todo):
            print(f"{verdict:15} {name}  {detail}", flush=True)
            if verdict != "KILLED":
                failed.append(name)
    print(f"\n{len(todo) - len(failed)}/{len(todo)} mutants killed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
