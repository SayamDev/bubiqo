/**
 * The bill summary: what is going out, when, and where the account stands.
 *
 * A Direct Debit reminder carries three numbers a person cares about: the
 * payment, the date it leaves, and the balance. Left in the details list they
 * read as "Amount £48.56, Amount £194.27 owed" with no way to tell which is the
 * payment. This picks them apart using the words around each amount.
 */
import type { Entity, Surface } from "./types";

export interface BillSummary {
  /** The payment being taken or asked for, as stored ("GBP 48.56"). */
  readonly payment?: string;
  /** Epoch ms of the payment date, when the page gives one. */
  readonly dueAt?: number;
  /** The account balance, signed or marked DR/CR ("GBP -194.27 DR"). */
  readonly balance?: string;
  readonly account?: string;
  readonly supplier?: string;
}

const BILL_WORDS = /\b(?:bill|direct debit|payment|statement|invoice|balance|amount due|tariff)\b/i;
const BALANCE_WORDS = /\bbalance\b/i;
const PAYMENT_WORDS = /\b(?:direct debit|payment|pay|due|bill|amount|total)\b/i;

const isBalanceLike = (e: Entity): boolean => / (?:DR|CR)$/.test(e.value) || / -\d/.test(e.value) || BALANCE_WORDS.test(e.source);

export function buildBillSummary(
  surface: Surface,
  pageText: string,
  entities: readonly Entity[],
  now: number,
): BillSummary | undefined {
  if (surface !== "invoice" && !(surface === "email" && BILL_WORDS.test(pageText))) return undefined;

  const amounts = entities.filter((e) => e.type === "amount");
  if (amounts.length === 0) return undefined;

  const balance = amounts.find(isBalanceLike);
  const candidates = amounts.filter((e) => e !== balance && !isBalanceLike(e));
  const payment = candidates.find((e) => PAYMENT_WORDS.test(e.source)) ?? candidates[0];

  const dated = entities
    .filter((e) => (e.type === "deadline" || e.type === "date") && e.resolvedAt !== undefined)
    .filter((e) => (e.resolvedAt ?? 0) >= now - 24 * 60 * 60 * 1000)
    .sort((a, b) => (a.type === "deadline" ? -1 : 0) - (b.type === "deadline" ? -1 : 0) || (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0));

  if (!payment && !balance) return undefined;

  return {
    ...(payment ? { payment: payment.value } : {}),
    ...(dated[0]?.resolvedAt !== undefined ? { dueAt: dated[0].resolvedAt } : {}),
    ...(balance ? { balance: balance.value } : {}),
    ...(entities.find((e) => e.type === "reference") ? { account: entities.find((e) => e.type === "reference")!.value } : {}),
    ...(entities.find((e) => e.type === "organisation") ? { supplier: entities.find((e) => e.type === "organisation")!.value } : {}),
  };
}
