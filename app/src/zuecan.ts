// The ZuecanRWAton fund operations over the JSON Ledger API: one function per
// business step, each one ledger transaction (or two where the model needs
// the counterparty's own submission, such as locking cash before a request).

import {
  type ContractId,
  type Ledger,
  type Party,
  create,
  createdAllOf,
  createdOf,
  date,
  days,
  decimal,
  exercise,
  hours,
  time,
} from "./ledger.ts";

const pkg = "#zuecan-rwa";
export const T = {
  CredentialRequest: `${pkg}:Zuecan.Compliance:CredentialRequest`,
  InvestorCredential: `${pkg}:Zuecan.Compliance:InvestorCredential`,
  CashHolding: `${pkg}:Zuecan.Cash:CashHolding`,
  LockedCash: `${pkg}:Zuecan.Cash:LockedCash`,
  FundTerms: `${pkg}:Zuecan.Fund:FundTerms`,
  TermsProposal: `${pkg}:Zuecan.Fund:TermsProposal`,
  NavReport: `${pkg}:Zuecan.Fund:NavReport`,
  RegisterProposal: `${pkg}:Zuecan.Registry:RegisterProposal`,
  FundRegister: `${pkg}:Zuecan.Registry:FundRegister`,
  ReserveAttestation: `${pkg}:Zuecan.Registry:ReserveAttestation`,
  FundHolding: `${pkg}:Zuecan.Registry:FundHolding`,
  TransferOffer: `${pkg}:Zuecan.Registry:TransferOffer`,
  SellOrder: `${pkg}:Zuecan.Registry:SellOrder`,
  MatchedTrade: `${pkg}:Zuecan.Registry:MatchedTrade`,
  RedemptionRequest: `${pkg}:Zuecan.Registry:RedemptionRequest`,
  RedemptionPayout: `${pkg}:Zuecan.Registry:RedemptionPayout`,
  EnforcementRecord: `${pkg}:Zuecan.Registry:EnforcementRecord`,
  MarketControl: `${pkg}:Zuecan.Market:MarketControl`,
  MarketProposal: `${pkg}:Zuecan.Market:MarketProposal`,
  TradePrint: `${pkg}:Zuecan.Market:TradePrint`,
  RegulatoryTradeReport: `${pkg}:Zuecan.Market:RegulatoryTradeReport`,
  SubscriptionRequest: `${pkg}:Zuecan.Subscription:SubscriptionRequest`,
} as const;

export interface Roles {
  ta: Party;
  custodian: Party;
  navAgent: Party;
  compliance: Party;
  operator: Party;
  regulator: Party;
  public: Party;
  usd: Party;
}

export interface Fund {
  roles: Roles;
  instrument: { registrar: Party; symbol: string };
  termsCid: ContractId;
  navCid: ContractId;
  registerCid: ContractId;
  marketCid: ContractId;
}

export const governmentMmfRules = {
  maxWamDays: "60",
  maxWalDays: "120",
  maxMaturityDays: "397",
  minDailyLiquidBps: "2500",
  minWeeklyLiquidBps: "5000",
  minGovernmentBps: "9950",
};

export async function allocateRoles(ledger: Ledger): Promise<Roles> {
  const [ta, custodian, navAgent, compliance, operator, regulator, pub, usd] = await Promise.all(
    ["TransferAgent", "Custodian", "FundAdministrator", "KycAgent", "VenueOperator", "Regulator", "Public", "UsdIssuer"]
      .map((hint) => ledger.allocateParty(hint)),
  );
  return { ta, custodian, navAgent, compliance, operator, regulator, public: pub, usd };
}

/** Terms (proposed by the transfer agent, approved by the regulator), the
 *  first NAV, the register (once the custodian accepts) and the venue. */
export async function launchFund(ledger: Ledger, roles: Roles, symbol: string, navPerUnit: string): Promise<Fund> {
  const instrument = { registrar: roles.ta, symbol };
  const terms = {
    instrument,
    name: "Zuecan Treasury Money Market Fund",
    strategy: "Government money-market fund: US Treasury bills (<= 397 days) and Treasury repo",
    currency: "USD",
    cashIssuer: roles.usd,
    custodian: roles.custodian,
    navAgent: roles.navAgent,
    compliance: roles.compliance,
    operator: roles.operator,
    regulator: roles.regulator,
    publicParty: roles.public,
    eligibility: {
      allowedClasses: ["Accredited", "QualifiedPurchaser", "Professional", "Institutional"],
      allowedJurisdictions: ["US", "TW", "SG"],
      maxScreeningAge: days(90),
    },
    portfolioRules: governmentMmfRules,
    minSubscription: decimal(1000),
    minRedemptionUnits: decimal(1),
    maxNavAge: hours(30),
    maxAttestationAge: hours(30),
    offeringDocHash: "sha256:offering-memorandum-v1",
    version: "1",
  };
  const proposalTx = await ledger.submit([roles.ta], [
    create(T.TermsProposal, { proposed: terms, replaces: null, rationale: "initial offering" }),
  ]);
  const proposalCid = createdOf(proposalTx, T.TermsProposal).contractId;
  const termsTx = await ledger.submit([roles.regulator], [exercise(T.TermsProposal, proposalCid, "ApproveTerms")]);
  const termsCid = createdOf(termsTx, T.FundTerms).contractId;

  const navTx = await ledger.submit([roles.navAgent], [
    create(T.NavReport, {
      instrument,
      navAgent: roles.navAgent,
      readers: [roles.custodian, roles.operator, roles.regulator, roles.public],
      navPerUnit,
      asOf: time(new Date()),
      seq: "1",
      methodologyRef: "amortized-cost; T-bills marked daily",
    }),
  ]);
  const navCid = createdOf(navTx, T.NavReport).contractId;

  const appointTx = await ledger.submit([roles.ta], [
    create(T.RegisterProposal, { instrument, custodian: roles.custodian, regulator: roles.regulator, readers: [roles.public] }),
  ]);
  const registerTx = await ledger.submit([roles.custodian], [
    exercise(T.RegisterProposal, createdOf(appointTx, T.RegisterProposal).contractId, "AcceptAppointment"),
  ]);
  const registerCid = createdOf(registerTx, T.FundRegister).contractId;

  // The venue proposes its market; the regulator co-signs it.
  const marketProposalTx = await ledger.submit([roles.operator], [
    create(T.MarketProposal, {
      control: {
        operator: roles.operator,
        regulator: roles.regulator,
        instrument,
        readers: [roles.public],
        status: { tag: "Trading", value: {} },
        maxTradeUnits: decimal(50_000),
        maxDeviationBps: decimal(50),
      },
    }),
  ]);
  const marketTx = await ledger.submit([roles.regulator], [
    exercise(T.MarketProposal, createdOf(marketProposalTx, T.MarketProposal).contractId, "AcceptMarket"),
  ]);
  const marketCid = createdOf(marketTx, T.MarketControl).contractId;
  return { roles, instrument, termsCid, navCid, registerCid, marketCid };
}

/** Investor asks, KYC agent approves; returns the credential. */
export async function onboard(ledger: Ledger, fund: Fund, investor: Party, investorClass: string, jurisdiction: string): Promise<ContractId> {
  const { roles } = fund;
  const reqTx = await ledger.submit([investor], [
    create(T.CredentialRequest, {
      investor,
      compliance: roles.compliance,
      requestedClass: investorClass,
      jurisdiction,
      evidenceHash: `sha256:kyc-file-${investor.split("::")[0]}`,
    }),
  ]);
  const credTx = await ledger.submit([roles.compliance], [
    exercise(T.CredentialRequest, createdOf(reqTx, T.CredentialRequest).contractId, "Approve", {
      grantedClass: investorClass,
      validFor: days(365),
      relying: [roles.ta, roles.operator, roles.custodian],
      regulator: roles.regulator,
    }),
  ]);
  return createdOf(credTx, T.InvestorCredential).contractId;
}

export async function mintCash(ledger: Ledger, fund: Fund, owner: Party, amount: number): Promise<ContractId> {
  const tx = await ledger.submit([fund.roles.usd], [
    create(T.CashHolding, { issuer: fund.roles.usd, owner, currency: "USD", amount: decimal(amount) }),
  ]);
  return createdOf(tx, T.CashHolding).contractId;
}

/** The owner's largest unlocked cash holding. */
export async function largestCash(ledger: Ledger, owner: Party): Promise<{ cid: ContractId; amount: number }> {
  const holdings = (await ledger.activeContracts(owner, T.CashHolding))
    .filter((c) => c.createArgument.owner === owner)
    .map((c) => ({ cid: c.contractId, amount: Number(c.createArgument.amount) }))
    .sort((a, b) => b.amount - a.amount);
  if (!holdings.length) throw new Error(`no cash for ${owner}`);
  return holdings[0];
}

export async function lockCash(
  ledger: Ledger, owner: Party, lockedTo: Party, payee: Party, amount: number | string, releaseAfter: Date, purpose: string,
): Promise<ContractId> {
  const cash = await largestCash(ledger, owner);
  const tx = await ledger.submit([owner], [
    exercise(T.CashHolding, cash.cid, "Lock", {
      lockedTo,
      payee,
      lockAmount: decimal(amount),
      releaseAfter: time(releaseAfter),
      purpose,
    }),
  ]);
  return createdOf(tx, T.LockedCash).contractId;
}

/** Escrow cash for the custodian, ask for units, and have the transfer agent
 *  settle. Returns the investor's new holding. */
export async function subscribe(ledger: Ledger, fund: Fund, investor: Party, credentialCid: ContractId, amount: number): Promise<ContractId> {
  const { roles } = fund;
  const releaseAfter = new Date(Date.now() + 2 * 24 * 3600 * 1000);
  const lockedCashCid = await lockCash(ledger, investor, roles.ta, roles.custodian, amount, releaseAfter, `subscription ${fund.instrument.symbol}`);
  const reqTx = await ledger.submit([investor], [
    create(T.SubscriptionRequest, { instrument: fund.instrument, investor, cashAmount: decimal(amount), lockedCashCid }),
  ]);
  const settleTx = await ledger.submit([roles.ta], [
    exercise(T.SubscriptionRequest, createdOf(reqTx, T.SubscriptionRequest).contractId, "SettleSubscription", {
      termsCid: fund.termsCid,
      registerCid: fund.registerCid,
      navCid: fund.navCid,
      credentialCid,
    }),
  ]);
  fund.registerCid = createdOf(settleTx, T.FundRegister).contractId;
  return createdOf(settleTx, T.FundHolding).contractId;
}

/** The custodian's statement: a quarter cash, the rest in 4- and 8-week bills. */
export async function attest(ledger: Ledger, fund: Fund, value: number, statementRef: string): Promise<void> {
  const today = new Date();
  const plus = (d: number) => new Date(today.getTime() + d * 24 * 3600 * 1000);
  const cash = Math.floor(value * 0.25 * 1e6) / 1e6;
  const bill4w = Math.floor(value * 0.4 * 1e6) / 1e6;
  const bill8w = value - cash - bill4w;
  const position = (securityId: string, kind: string, v: number, maturity: Date) => ({
    securityId, kind, par: decimal(v), marketValue: decimal(v), maturity: date(maturity), resetDate: null,
  });
  const tx = await ledger.submit([fund.roles.custodian], [
    exercise(T.FundRegister, fund.registerCid, "Attest", {
      positions: [
        position("CASH-USD", "Cash", cash, today),
        position("912797-4W", "TreasuryBill", bill4w, plus(28)),
        position("912797-8W", "TreasuryBill", bill8w, plus(56)),
      ],
      newStatementRef: statementRef,
      termsCid: fund.termsCid,
    }),
  ]);
  fund.registerCid = createdOf(tx, T.FundRegister).contractId;
}

/** Seller quotes `units` to one buyer at `price`; the buyer locks the
 *  notional for the venue and takes; the venue settles DvP. */
export async function tradeOnVenue(
  ledger: Ledger, fund: Fund,
  seller: { party: Party; holdingCid: ContractId; credentialCid: ContractId },
  buyer: { party: Party; credentialCid: ContractId },
  units: number, price: number,
): Promise<{ buyerHolding: ContractId; sellerRest: ContractId | undefined }> {
  const { roles } = fund;
  const expiresAt = new Date(Date.now() + 3600 * 1000);
  const settleWithinHours = 1;
  const deadline = new Date(expiresAt.getTime() + settleWithinHours * 3600 * 1000);
  const listTx = await ledger.submit([seller.party], [
    exercise(T.FundHolding, seller.holdingCid, "ListForSale", {
      buyer: buyer.party,
      operator: roles.operator,
      amount: decimal(units),
      price: decimal(price),
      cashIssuer: roles.usd,
      currency: "USD",
      expiresAt: time(expiresAt),
      settleWithin: hours(settleWithinHours),
    }),
  ]);
  const orderCid = createdOf(listTx, T.SellOrder).contractId;
  const sellerRest = createdAllOf(listTx, T.FundHolding)[0]?.contractId;
  const notional = Math.floor(units * price * 1e6) / 1e6;
  const lockedCashCid = await lockCash(ledger, buyer.party, roles.operator, seller.party, notional, deadline, `buy ${fund.instrument.symbol}`);
  const takeTx = await ledger.submit([buyer.party], [exercise(T.SellOrder, orderCid, "Take", { lockedCashCid })]);
  const settleTx = await ledger.submit([roles.operator], [
    exercise(T.MatchedTrade, createdOf(takeTx, T.MatchedTrade).contractId, "Settle", {
      marketCid: fund.marketCid,
      termsCid: fund.termsCid,
      navCid: fund.navCid,
      buyerCredentialCid: buyer.credentialCid,
      sellerCredentialCid: seller.credentialCid,
    }),
  ], { witnesses: [buyer.party] });
  return { buyerHolding: createdOf(settleTx, T.FundHolding).contractId, sellerRest };
}

/** Request, transfer-agent approval at the current NAV, custodian payment. */
export async function redeem(ledger: Ledger, fund: Fund, investor: Party, holdingCid: ContractId, credentialCid: ContractId, units: number): Promise<void> {
  const { roles } = fund;
  const reqTx = await ledger.submit([investor], [exercise(T.FundHolding, holdingCid, "RequestRedemption", { amount: decimal(units) })]);
  const approveTx = await ledger.submit([roles.ta], [
    exercise(T.RedemptionRequest, createdOf(reqTx, T.RedemptionRequest).contractId, "ApproveRedemption", {
      termsCid: fund.termsCid, navCid: fund.navCid, credentialCid,
    }),
  ]);
  const cash = await largestCash(ledger, roles.custodian);
  const payTx = await ledger.submit([roles.custodian], [
    exercise(T.RedemptionPayout, createdOf(approveTx, T.RedemptionPayout).contractId, "Pay", {
      cashCid: cash.cid, registerCid: fund.registerCid, termsCid: fund.termsCid, navCid: fund.navCid, credentialCid,
    }),
  ]);
  fund.registerCid = createdOf(payTx, T.FundRegister).contractId;
}
