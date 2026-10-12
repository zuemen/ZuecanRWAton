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
 ("issuance coverage", "Registry", "(liability next nav.navPerUnit <= coverage next)", "True"),
 ("redemption coverage", "Registry", "(liability this nav.navPerUnit <= coverage this)", "True"),
 ("issuance attestation freshness", "Registry", "(isWithin terms.maxAttestationAge now attestedAt)\n        assertMsg (\"the portfolio", "True\n        assertMsg (\"the portfolio"),
 ("redemption attestation freshness", "Registry", "(isWithin terms.maxAttestationAge now attestedAt)\n        assertMsg \"cannot redeem", "True\n        assertMsg \"cannot redeem"),
 ("nav freshness", "Fund", "(isWithin terms.maxNavAge now nav.asOf)", "True"),
 ("nav agent identity", "Fund", "(nav.navAgent == terms.navAgent)", "True"),
 ("register dual control", "Registry", "signatory instrument.registrar, custodian\n    observer regulator, readers", "signatory instrument.registrar\n    observer custodian, regulator, readers"),
 ("issuance needs subscriber", "Registry", "controller instrument.registrar, subscriber", "controller instrument.registrar"),
 ("redemption needs custodian", "Registry", "controller instrument.registrar, custodian", "controller instrument.registrar"),
 ("redemption pays cash", "Registry", "(cashOut > 0.0)", "True"),
 ("issuance eligibility", "Registry", "checkEligible terms.compliance subscriber terms.eligibility now cred", "pure ()"),
 ("issuance escrow match", "Registry", "lc.payee == custodian", "True"),
 ("issuance minimum", "Registry", "(lc.amount >= terms.minSubscription)", "True"),
 ("issuance status", "Registry", "(status == Open)", "True"),
 ("redemption status", "Registry", "(status /= Suspended)", "True"),
 ("unit rounding down", "Registry", "floor6 (lc.amount / nav.navPerUnit)", "(lc.amount / nav.navPerUnit)"),
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
 ("price band", "Registry", "(bpsDeviation nav.navPerUnit price <= market.maxDeviationBps)", "True"),
 ("market halted", "Registry", "(market.status == Trading)", "True"),
 ("size cap", "Registry", "(units <= market.maxTradeUnits)", "True"),
 ("take lock match", "Registry", "&& lc.issuer == cashIssuer && lc.currency == currency && lc.amount == notional)", ")"),
 ("lock lapses at deadline", "Registry", "(lc.releaseAfter == deadline)", "True"),
 ("order expiry", "Registry", "(now < expiresAt)", "True"),
 ("settle deadline", "Registry", "(now < deadline)", "True"),
 ("abort deadline", "Registry", "(now >= deadline)", "True"),
 ("abort actor", "Registry", "(actor == seller || actor == buyer)", "True"),
 ("transfer receiver eligibility", "Registry", "checkEligible terms.compliance receiver terms.eligibility now cred", "pure ()"),
 ("buyer eligibility", "Registry", "checkEligible terms.compliance buyer terms.eligibility now buyerCred", "pure ()"),
 ("seller screening", "Registry", "checkScreened terms.compliance seller terms.eligibility now sellerCred", "pure ()"),
 ("frozen escrow", "Registry", "assertMsg \"the holding is frozen\" (not h.frozen)", "pure ()"),
 ("min redemption", "Registry", "(units >= terms.minRedemptionUnits)", "True"),
 ("redeemer screening", "Registry", "checkScreened terms.compliance investor terms.eligibility now cred", "pure ()"),
 ("holding dual signature", "Registry", "signatory instrument.registrar, custodian, owner\n    observer regulator", "signatory instrument.registrar, custodian\n    observer owner, regulator"),
 ("regulator halt lock", "Market", "HaltedByRegulator _ -> abort \"only the regulator can lift a regulatory halt\"", "HaltedByRegulator _ -> create this with status = Trading"),
 ("operator cannot override halt", "Market", "HaltedByRegulator _ -> abort \"the regulator has halted this market\"", "HaltedByRegulator _ -> create this with status = HaltedByOperator reason"),
 ("holding custodian signature", "Registry", "signatory instrument.registrar, custodian, owner\n    observer regulator", "signatory instrument.registrar, owner\n    observer custodian, regulator"),
 ("reserve is sum of positions", "Registry", "attestedReserve = metrics.value", "attestedReserve = metrics.value * 2.0"),
 ("portfolio breach gate", "Registry", "(null portfolioBreaches)\n        lc <- fetch", "True\n        lc <- fetch"),
 ("wam limit", "Portfolio", "| m.wamDays > intToDecimal rules.maxWamDays ]", "| False ]"),
 ("wal limit", "Portfolio", "| m.walDays > intToDecimal rules.maxWalDays ]", "| False ]"),
 ("maturity limit", "Portfolio", "| m.longestMaturityDays > rules.maxMaturityDays ]", "| False ]"),
 ("daily liquidity limit", "Portfolio", "| m.dailyLiquidBps < intToDecimal rules.minDailyLiquidBps ]", "| False ]"),
 ("weekly liquidity limit", "Portfolio", "| m.weeklyLiquidBps < intToDecimal rules.minWeeklyLiquidBps ]", "| False ]"),
 ("government share limit", "Portfolio", "| m.governmentBps < intToDecimal rules.minGovernmentBps ]", "| False ]"),
 ("non-positive value", "Portfolio", "| any (\\p -> p.marketValue <= 0.0 || p.par <= 0.0) positions ]", "| False ]"),
 ("wam reset look-through", "Portfolio", "days (min p.maturity (fromOptional p.maturity p.resetDate))", "days p.maturity"),
 ("agency notes weekly liquid", "Portfolio", "|| (p.kind == AgencyDiscountNote && maturityDays p <= 60)", ""),
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
               "cd test && daml test 2>&1 | grep -E ': failed' | grep -v 'Canton.daml' | head -1")
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
    ap.add_argument("--check", action="store_true",
                    help="only check that every mutant's original text is still in the sources")
    ap.add_argument("names", nargs="*", help="only run mutants with these names")
    args = ap.parse_args()
    todo = [m for m in MUTANTS if not args.names or m[0] in args.names]
    if args.check:
        stale = [name for name, module, old, _ in todo
                 if old not in open(os.path.join(REPO, "main/daml/Zuecan", module + ".daml")).read()]
        for name in stale:
            print(f"pattern missing: {name}")
        print(f"{len(todo) - len(stale)}/{len(todo)} mutant patterns found")
        sys.exit(1 if stale else 0)
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
