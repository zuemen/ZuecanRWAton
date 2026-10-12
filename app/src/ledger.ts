// Minimal client for the Canton JSON Ledger API v2.
//
// Only what the ZuecanRWAton app needs: allocate parties, submit commands and
// wait for the transaction, and read the active contract set. No
// dependencies: Node's built-in fetch.

export type Party = string;
export type ContractId = string;

export interface CreatedEvent {
  contractId: ContractId;
  templateId: string;
  createArgument: Record<string, unknown>;
  signatories: Party[];
  observers: Party[];
}

export interface Transaction {
  updateId: string;
  effectiveAt: string;
  created: CreatedEvent[];
}

export type Command =
  | { CreateCommand: { templateId: string; createArguments: unknown } }
  | { ExerciseCommand: { templateId: string; contractId: ContractId; choice: string; choiceArgument: unknown } };

export class LedgerError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class Ledger {
  readonly baseUrl: string;
  readonly userId: string;
  private commandSeq = 0;

  constructor(baseUrl: string, userId = "zuecan-app") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.userId = userId;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const cause = parsed && typeof parsed === "object" && "cause" in parsed ? String(parsed.cause) : text;
      throw new LedgerError(`${method} ${path} failed (${res.status}): ${cause}`, res.status, parsed);
    }
    return parsed;
  }

  async version(): Promise<string> {
    return (await this.call("GET", "/v2/version")).version;
  }

  /** Allocate a party; the hint is made unique so reruns on one ledger work. */
  async allocateParty(hint: string): Promise<Party> {
    const unique = `${hint}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const res = await this.call("POST", "/v2/parties", {
      partyIdHint: unique,
      identityProviderId: "",
      synchronizerId: "",
      userId: "",
    });
    return res.partyDetails.party;
  }

  async ledgerEnd(): Promise<number> {
    return (await this.call("GET", "/v2/state/ledger-end")).offset;
  }

  /** Submit one atomic batch of commands and return its created events, as
   *  seen by the submitting parties and any `witnesses` (by default the
   *  response only carries what the submitters can see; the venue settling a
   *  trade cannot see the buyer's new holding, for instance). */
  async submit(actAs: Party[], commands: Command[], opts: { readAs?: Party[]; witnesses?: Party[] } = {}): Promise<Transaction> {
    const readAs = opts.readAs ?? [];
    const viewers = [...new Set([...actAs, ...readAs, ...(opts.witnesses ?? [])])];
    const wildcard = { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] };
    const res = await this.call("POST", "/v2/commands/submit-and-wait-for-transaction", {
      commands: {
        commandId: `zuecan-${process.pid}-${Date.now()}-${++this.commandSeq}`,
        userId: this.userId,
        actAs,
        readAs,
        commands,
      },
      transactionFormat: {
        transactionShape: "TRANSACTION_SHAPE_ACS_DELTA",
        eventFormat: { verbose: true, filtersByParty: Object.fromEntries(viewers.map((p) => [p, wildcard])) },
      },
    });
    const tx = res.transaction;
    const created: CreatedEvent[] = (tx.events ?? [])
      .filter((e: any) => "CreatedEvent" in e)
      .map((e: any) => e.CreatedEvent);
    return { updateId: tx.updateId, effectiveAt: tx.effectiveAt, created };
  }

  /** Active contracts of `templateId` visible to `party`. */
  async activeContracts(party: Party, templateId: string): Promise<CreatedEvent[]> {
    const offset = await this.ledgerEnd();
    const res: any[] = await this.call("POST", "/v2/state/active-contracts", {
      activeAtOffset: offset,
      // The top-level verbose flag is the deprecated form; with eventFormat it
      // must be off, and eventFormat.verbose applies.
      verbose: false,
      eventFormat: {
        verbose: true,
        filtersByParty: {
          [party]: {
            cumulative: [
              {
                identifierFilter: {
                  TemplateFilter: { value: { templateId, includeCreatedEventBlob: false } },
                },
              },
            ],
          },
        },
      },
    });
    return res
      .map((entry) => entry.contractEntry?.JsActiveContract?.createdEvent)
      .filter((e): e is CreatedEvent => Boolean(e));
  }
}

/** The single created event of `templateId` in `tx` (by `#package:Module:Entity` suffix). */
export function createdOf(tx: Transaction, templateId: string): CreatedEvent {
  const matches = createdAllOf(tx, templateId);
  if (matches.length !== 1) {
    throw new Error(`expected one ${templateId} in transaction ${tx.updateId}, found ${matches.length}`);
  }
  return matches[0];
}

export function createdAllOf(tx: Transaction, templateId: string): CreatedEvent[] {
  const suffix = templateId.replace(/^#[^:]+/, "");
  return tx.created.filter((e) => e.templateId.endsWith(suffix));
}

export function create(templateId: string, createArguments: unknown): Command {
  return { CreateCommand: { templateId, createArguments } };
}

export function exercise(templateId: string, contractId: ContractId, choice: string, choiceArgument: unknown = {}): Command {
  return { ExerciseCommand: { templateId, contractId, choice, choiceArgument } };
}

// Daml-LF JSON encodings used by the model.

export const decimal = (x: number | string): string => (typeof x === "number" ? x.toFixed(6) : x);
export const time = (d: Date): string => d.toISOString();
export const date = (d: Date): string => d.toISOString().slice(0, 10);
export const hours = (n: number) => ({ microseconds: String(n * 3_600_000_000) });
export const days = (n: number) => hours(24 * n);
export const unit = {};
