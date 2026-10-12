// End-to-end run against a Canton participant over the JSON Ledger API:
// launch the fund, onboard two investors, subscribe, attest reserves, trade
// on the venue, redeem, then build the regulator's report and check that
// the books balance. Exits non-zero on any failure.
//
//   LEDGER_URL=http://localhost:7575 node src/flow.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { Ledger } from "./ledger.ts";
import { buildReport, renderHtml } from "./report.ts";
import { T, allocateRoles, attest, launchFund, mintCash, onboard, redeem, subscribe, tradeOnVenue } from "./zuecan.ts";

const ledger = new Ledger(process.env.LEDGER_URL ?? "http://localhost:7575");
const outDir = new URL("../out/", import.meta.url);

function check(cond: boolean, message: string): void {
  if (!cond) throw new Error(`check failed: ${message}`);
  console.log(`  ✓ ${message}`);
}

async function main(): Promise<void> {
  console.log(`ledger ${await ledger.version()} at ${ledger.baseUrl}`);
  const nav = "1.042500";
  const symbol = `ZTMMF-${Date.now().toString(36)}`;

  console.log("launch: terms (TA proposes, regulator approves), NAV, register, venue");
  const roles = await allocateRoles(ledger);
  const fund = await launchFund(ledger, roles, symbol, nav);

  console.log("onboard investors");
  const [alice, bob] = await Promise.all([ledger.allocateParty("Alice"), ledger.allocateParty("Bob")]);
  const aliceCred = await onboard(ledger, fund, alice, "Accredited", "US");
  const bobCred = await onboard(ledger, fund, bob, "Professional", "TW");
  await mintCash(ledger, fund, alice, 1_000_000);
  await mintCash(ledger, fund, bob, 1_000_000);

  console.log("subscribe, attest, subscribe");
  const aliceHolding = await subscribe(ledger, fund, alice, aliceCred, 250_000);
  await attest(ledger, fund, 250_000, "custodian-statement-day-1");
  await subscribe(ledger, fund, bob, bobCred, 100_000);

  console.log("trade 20,000 units Alice → Bob on the venue (DvP)");
  const trade = await tradeOnVenue(
    ledger, fund,
    { party: alice, holdingCid: aliceHolding, credentialCid: aliceCred },
    { party: bob, credentialCid: bobCred },
    20_000, 1.043,
  );

  console.log("redeem 10,000 of Alice's remaining units");
  if (!trade.sellerRest) throw new Error("expected Alice to keep a remainder after the trade");
  await redeem(ledger, fund, alice, trade.sellerRest, aliceCred, 10_000);

  console.log("regulator's report");
  const report = await buildReport(ledger, roles.regulator, roles.public, symbol);
  const unitsAlice = Math.floor((250_000 / Number(nav)) * 1e6) / 1e6;
  const unitsBob = Math.floor((100_000 / Number(nav)) * 1e6) / 1e6;
  check(report.reconciliation.ok, `units on the ledger (${report.reconciliation.unitsOnLedger}) = register outstanding (${report.reconciliation.registerOutstanding})`);
  check(Math.abs(report.register.outstanding - (unitsAlice + unitsBob - 10_000)) < 1e-6, "outstanding = issued − redeemed");
  check(report.coverage.backing >= report.coverage.liability, "attested reserves plus net flows cover every unit at NAV");
  check(report.register.breaches.length === 0 && report.reserves.length === 1, "one custodian statement, no portfolio breaches");
  check(report.holders.length === 2, "the regulator sees both holders");
  check(report.trades.length === 1 && report.trades[0].units === 20_000, "the regulator sees the trade with both sides");
  check(report.publicPrints.length === 1 && !report.publicPrints[0].hasIdentities, "the public print carries no identities");

  const bobView = await ledger.activeContracts(bob, T.FundHolding);
  check(bobView.every((h) => h.createArgument.owner === bob), "Bob sees only his own holdings");
  const publicView = await ledger.activeContracts(roles.public, T.FundHolding);
  check(publicView.length === 0, "the public sees no holdings");

  mkdirSync(outDir, { recursive: true });
  writeFileSync(new URL("report.json", outDir), JSON.stringify(report, null, 2));
  writeFileSync(new URL("regulator.html", outDir), renderHtml(report));
  console.log(`wrote ${new URL("regulator.html", outDir).pathname}`);
  console.log("flow passed");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
