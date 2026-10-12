// The regulator's view of one fund, built only from contracts the regulator
// (or the public disclosure party) can see on its participant.

import type { Ledger, Party } from "./ledger.ts";
import { T } from "./zuecan.ts";

export interface Report {
  generatedAt: string;
  fund: { symbol: string; name: string; termsVersion: number };
  register: { outstanding: number; attestedReserve: number; netFlow: number; attestedAt: string; status: string; breaches: string[] };
  nav: { navPerUnit: number; asOf: string };
  coverage: { liability: number; backing: number; ratio: number };
  reserves: { seq: number; attestedAt: string; value: number; wamDays: number; walDays: number; dailyLiquidBps: number; weeklyLiquidBps: number; governmentBps: number; breaches: string[] }[];
  holders: { owner: string; units: number; frozen: boolean }[];
  escrowedUnits: number;
  trades: { seller: string; buyer: string; units: number; price: number; executedAt: string }[];
  publicPrints: { units: number; price: number; executedAt: string; hasIdentities: boolean }[];
  reconciliation: { unitsOnLedger: number; registerOutstanding: number; ok: boolean };
}

const short = (party: string) => party.split("::")[0].replace(/-[a-z0-9]+-[a-z0-9]{4}$/, "");

export async function buildReport(ledger: Ledger, regulator: Party, publicParty: Party, symbol: string): Promise<Report> {
  const mine = <A extends { createArgument: any }>(cs: A[]) =>
    cs.filter((c) => (c.createArgument.instrument?.symbol ?? symbol) === symbol);
  const [terms, registers, navs, attestations, holdings, offers, orders, matched, requests, payouts, reports, prints] =
    await Promise.all([
      ledger.activeContracts(regulator, T.FundTerms),
      ledger.activeContracts(regulator, T.FundRegister),
      ledger.activeContracts(regulator, T.NavReport),
      ledger.activeContracts(publicParty, T.ReserveAttestation),
      ledger.activeContracts(regulator, T.FundHolding),
      ledger.activeContracts(regulator, T.TransferOffer),
      ledger.activeContracts(regulator, T.SellOrder),
      ledger.activeContracts(regulator, T.MatchedTrade),
      ledger.activeContracts(regulator, T.RedemptionRequest),
      ledger.activeContracts(regulator, T.RedemptionPayout),
      ledger.activeContracts(regulator, T.RegulatoryTradeReport),
      ledger.activeContracts(publicParty, T.TradePrint),
    ]);
  const [t] = mine(terms);
  const [r] = mine(registers);
  const [n] = mine(navs);
  if (!t || !r || !n) throw new Error(`fund ${symbol} not visible to the regulator`);
  const reg = r.createArgument;
  const navPerUnit = Number(n.createArgument.navPerUnit);
  const outstanding = Number(reg.outstanding);
  const backing = Number(reg.attestedReserve) + Number(reg.netFlowSinceAttestation);
  const liability = outstanding * navPerUnit;

  const byOwner = new Map<string, { units: number; frozen: boolean }>();
  for (const h of mine(holdings)) {
    const a = h.createArgument;
    const cur = byOwner.get(a.owner) ?? { units: 0, frozen: false };
    byOwner.set(a.owner, { units: cur.units + Number(a.units), frozen: cur.frozen || a.frozen });
  }
  const held = [...byOwner.values()].reduce((s, h) => s + h.units, 0);
  const escrowed = [offers, orders, matched, requests, payouts]
    .flatMap((cs) => mine(cs))
    .reduce((s, c) => s + Number(c.createArgument.units), 0);
  const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

  return {
    generatedAt: new Date().toISOString(),
    fund: { symbol, name: t.createArgument.name, termsVersion: Number(t.createArgument.version) },
    register: {
      outstanding,
      attestedReserve: Number(reg.attestedReserve),
      netFlow: Number(reg.netFlowSinceAttestation),
      attestedAt: reg.attestedAt,
      status: reg.status,
      breaches: reg.portfolioBreaches,
    },
    nav: { navPerUnit, asOf: n.createArgument.asOf },
    coverage: { liability: round6(liability), backing: round6(backing), ratio: liability === 0 ? Infinity : backing / liability },
    reserves: mine(attestations)
      .map((a) => {
        const m = a.createArgument.metrics;
        return {
          seq: Number(a.createArgument.seq),
          attestedAt: a.createArgument.attestedAt,
          value: Number(m.value),
          wamDays: Number(m.wamDays),
          walDays: Number(m.walDays),
          dailyLiquidBps: Number(m.dailyLiquidBps),
          weeklyLiquidBps: Number(m.weeklyLiquidBps),
          governmentBps: Number(m.governmentBps),
          breaches: a.createArgument.portfolioBreaches,
        };
      })
      .sort((a, b) => a.seq - b.seq),
    holders: [...byOwner.entries()].map(([owner, h]) => ({ owner: short(owner), units: round6(h.units), frozen: h.frozen })),
    escrowedUnits: round6(escrowed),
    trades: mine(reports).map((x) => ({
      seller: short(x.createArgument.seller),
      buyer: short(x.createArgument.buyer),
      units: Number(x.createArgument.units),
      price: Number(x.createArgument.price),
      executedAt: x.createArgument.executedAt,
    })),
    publicPrints: mine(prints).map((x) => ({
      units: Number(x.createArgument.units),
      price: Number(x.createArgument.price),
      executedAt: x.createArgument.executedAt,
      hasIdentities: "seller" in x.createArgument || "buyer" in x.createArgument,
    })),
    reconciliation: { unitsOnLedger: round6(held + escrowed), registerOutstanding: outstanding, ok: round6(held + escrowed) === round6(outstanding) },
  };
}

const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const when = (iso: string) => iso.replace("T", " ").replace(/\.\d+Z$/, " UTC");
const num = (x: number, digits = 2) => x.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function renderHtml(r: Report): string {
  const ok = r.reconciliation.ok && r.coverage.backing >= r.coverage.liability && r.register.breaches.length === 0;
  const row = (cells: unknown[]) => `<tr>${cells.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`;
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>監理檢視：${esc(r.fund.symbol)}</title>
<style>
  :root { --bg:#f7f7f5; --fg:#1c1c1a; --muted:#6b6b66; --card:#fff; --line:#e3e3de; --ok:#1f7a4d; --bad:#b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161615; --fg:#ececea; --muted:#a3a39d; --card:#1f1f1d; --line:#33332f; --ok:#5fc48f; --bad:#f2847b; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, "Noto Sans TC", sans-serif; }
  main { max-width:1000px; margin:0 auto; padding:24px 16px 48px; }
  h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:16px; margin:28px 0 8px; }
  .muted { color:var(--muted); }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px; margin-top:16px; }
  .tile { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 14px; }
  .tile b { display:block; font-size:clamp(16px, 4.5vw, 20px); font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
  .badge { display:inline-block; padding:2px 10px; border-radius:999px; font-weight:600; color:#fff; background:${ok ? "var(--ok)" : "var(--bad)"}; }
  .scroll { overflow-x:auto; background:var(--card); border:1px solid var(--line); border-radius:8px; }
  table { border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums; }
  th, td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { font-weight:600; color:var(--muted); font-size:13px; }
  tr:last-child td { border-bottom:0; }
</style>
</head>
<body><main>
<h1>${esc(r.fund.name)}（${esc(r.fund.symbol)}）</h1>
<div class="muted">監理檢視．條款第 ${r.fund.termsVersion} 版．產生於 ${esc(when(r.generatedAt))}．資料只取自監理機關與公開 party 在 Canton participant 上看得到的合約</div>
<p><span class="badge">${ok ? "帳實相符、儲備足額、投資組合合規" : "需要注意"}</span></p>
<div class="tiles">
  <div class="tile"><span class="muted">流通份數</span><b>${num(r.register.outstanding, 6)}</b></div>
  <div class="tile"><span class="muted">NAV</span><b>${num(r.nav.navPerUnit, 4)}</b></div>
  <div class="tile"><span class="muted">負債（份數 × NAV）</span><b>${num(r.coverage.liability)}</b></div>
  <div class="tile"><span class="muted">支撐（儲備＋淨流入）</span><b>${num(r.coverage.backing)}</b></div>
  <div class="tile"><span class="muted">覆蓋率</span><b>${Number.isFinite(r.coverage.ratio) ? num(r.coverage.ratio * 100) + "%" : "—"}</b></div>
  <div class="tile"><span class="muted">對帳（帳本份數／帳冊）</span><b>${num(r.reconciliation.unitsOnLedger, 2)} / ${num(r.reconciliation.registerOutstanding, 2)}</b></div>
</div>
<h2>託管機構儲備聲明（公開歷史）</h2>
<div class="scroll"><table>
<tr><th>#</th><th>時間</th><th>市值</th><th>WAM 天</th><th>WAL 天</th><th>每日流動</th><th>每週流動</th><th>政府資產</th><th>違規</th></tr>
${r.reserves.map((a) => row([a.seq, when(a.attestedAt), num(a.value), num(a.wamDays, 1), num(a.walDays, 1), num(a.dailyLiquidBps / 100) + "%", num(a.weeklyLiquidBps / 100) + "%", num(a.governmentBps / 100) + "%", a.breaches.join("；") || "無"])).join("\n")}
</table></div>
<h2>持有人（監理機關可見；公眾與其他投資人不可見）</h2>
<div class="scroll"><table>
<tr><th>持有人</th><th>份數</th><th>凍結</th></tr>
${r.holders.map((h) => row([h.owner, num(h.units, 6), h.frozen ? "是" : "否"])).join("\n")}
<tr><td>託管中（轉讓、賣單、待交割、贖回）</td><td>${num(r.escrowedUnits, 6)}</td><td></td></tr>
</table></div>
<h2>成交（監理申報，含雙方）</h2>
<div class="scroll"><table>
<tr><th>時間</th><th>賣方</th><th>買方</th><th>份數</th><th>價格</th></tr>
${r.trades.map((x) => row([when(x.executedAt), x.seller, x.buyer, num(x.units, 6), num(x.price, 4)])).join("\n")}
</table></div>
<h2>公開成交資訊（不含身分）</h2>
<div class="scroll"><table>
<tr><th>時間</th><th>份數</th><th>價格</th><th>含身分欄位</th></tr>
${r.publicPrints.map((x) => row([when(x.executedAt), num(x.units, 6), num(x.price, 4), x.hasIdentities ? "是" : "否"])).join("\n")}
</table></div>
</main></body></html>
`;
}
