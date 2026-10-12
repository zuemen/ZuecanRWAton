// Unit tests for the regulator page: no ledger needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Report, renderHtml } from "../src/report.ts";

const base: Report = {
  generatedAt: "2026-10-12T12:00:00.000Z",
  fund: { symbol: "ZTMMF", name: "Zuecan Treasury Money Market Fund", termsVersion: 1 },
  register: { outstanding: 100, attestedReserve: 104.25, netFlow: 0, attestedAt: "2026-10-12T11:00:00Z", status: "Open", breaches: [] },
  nav: { navPerUnit: 1.0425, asOf: "2026-10-12T10:00:00Z" },
  coverage: { liability: 104.25, backing: 104.25, ratio: 1 },
  reserves: [],
  holders: [{ owner: "Alice", units: 100, frozen: false }],
  escrowedUnits: 0,
  trades: [],
  publicPrints: [],
  reconciliation: { unitsOnLedger: 100, registerOutstanding: 100, ok: true },
};

test("a balanced, covered, compliant fund gets the all-clear badge", () => {
  assert.match(renderHtml(base), /帳實相符、儲備足額、投資組合合規/);
});

test("any of: books do not reconcile, under-covered, portfolio breach turns the badge red", () => {
  const cases: Report[] = [
    { ...base, reconciliation: { ...base.reconciliation, unitsOnLedger: 101, ok: false } },
    { ...base, coverage: { ...base.coverage, backing: 100 } },
    { ...base, register: { ...base.register, breaches: ["weighted average maturity 70 days exceeds 60"] } },
  ];
  for (const r of cases) assert.match(renderHtml(r), /需要注意/);
});

test("ledger text is escaped", () => {
  const html = renderHtml({ ...base, holders: [{ owner: '<script>alert("x")</script>', units: 1, frozen: false }] });
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
});
