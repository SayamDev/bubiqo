/**
 * The money summary: what this page says about money, in its own words.
 *
 * The first version assumed every page with an amount on it was a bill, so a
 * SumUp payout report came out as "Next bill £214.85, balance -£2.24" — the
 * takings called a bill, the card fee called a balance. Money pages are not all
 * the same document, and each amount only means something next to its label.
 *
 * So this does two things. It decides what kind of document it is (a bill to
 * pay, a payout to receive, a receipt for something paid, a statement), and it
 * reads every amount together with the words the page put beside it. The
 * headline is then the figure that kind of document is about: the payment for a
 * bill, the money deposited for a payout, the total for a receipt.
 */
import type { Entity, Surface } from "./types";
import { SYMBOL_TO_CODE } from "./money";

export type MoneyKind = "bill" | "payout" | "receipt" | "statement";

export interface MoneyLine {
  /** The page's own label for the amount: "SumUp processing fees". */
  readonly label: string;
  /** Stored shape, signed: "GBP -2.24", "GBP 194.27 DR". */
  readonly value: string;
  /** What the amount is doing, for colour and for the breakdown bar. */
  readonly role: "gross" | "deduction" | "paid" | "pending" | "due" | "balance" | "total" | "other";
}

export interface MoneySummary {
  readonly kind: MoneyKind;
  /** The figure the document is about. */
  readonly headline: MoneyLine;
  /** Every other labelled amount, in page order. */
  readonly lines: readonly MoneyLine[];
  /** Payment date for a bill; report date for a payout or statement. */
  readonly dueAt?: number;
  readonly account?: string;
  readonly from?: string;
}

/** Kept for the parts of the panel written before payouts existed. */
export type BillSummary = MoneySummary;

const KIND_SIGNALS: readonly [MoneyKind, RegExp][] = [
  ["payout", /\b(?:payouts?|paid out|settlement|deposited (?:in|to|into)|card payments? (?:processed|taken)|processed card payments)\b/i],
  ["bill", /\b(?:direct debit|your bill|amount due|payment due|due date|pay (?:by|before)|invoice)\b/i],
  ["receipt", /\b(?:receipt|order confirm|thanks for your (?:order|purchase)|you paid|order total|payment received)\b/i],
  ["statement", /\b(?:statement|balance|account summary)\b/i],
];

const ROLE_SIGNALS: readonly [MoneyLine["role"], RegExp][] = [
  ["pending", /\b(?:to be paid|pending|upcoming payout|scheduled)\b/i],
  ["paid", /\b(?:paid out|payout amount|deposited|amount paid out|transferred)\b/i],
  ["deduction", /\b(?:fees?|deductions?|refunds?|chargebacks?|charges?|commission|discount)\b/i],
  ["gross", /\b(?:gross|processed|sales|takings|card payments|subtotal)\b/i],
  ["due", /\b(?:direct debit|payment|amount due|due|bill)\b/i],
  ["balance", /\bbalance\b/i],
  ["total", /\b(?:total|amount paid|you paid)\b/i],
];

const AMOUNT = /(?<![\w.])([-−(]?)\s?([£$€¥₹])\s?([-−]?)(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+(?:\.\d{2})?)(\)?)(?:\s?(DR|CR)\b)?/g;

/** A line that reads like a label: short, words, not a sentence of prose. */
function looksLikeLabel(line: string): boolean {
  const t = line.trim();
  if (t.length < 3 || t.length > 48) return false;
  if (!/[a-z]/i.test(t)) return false;
  if (/[£$€¥₹]\s?\d/.test(t)) return false;
  // Prose ends in a full stop; a label does not.
  if (/[.!?]$/.test(t) && t.split(" ").length > 5) return false;
  return true;
}

function roleOf(label: string): MoneyLine["role"] {
  for (const [role, re] of ROLE_SIGNALS) if (re.test(label)) return role;
  return "other";
}

/**
 * Every amount on the page with the label nearest above or before it.
 *
 * Emails lay these out as a label, a line of small print, then the figure — or
 * label and figure on one line. Looking back up to three lines for the first one
 * that reads like a label covers both without guessing at the layout.
 */
export function labelledAmounts(text: string): MoneyLine[] {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const out: MoneyLine[] = [];
  const seen = new Set<string>();

  lines.forEach((line, index) => {
    for (const m of line.matchAll(AMOUNT)) {
      const code = SYMBOL_TO_CODE[m[2] ?? ""];
      if (!code) continue;
      const negative = /[-−]/.test(m[1] ?? "") || /[-−]/.test(m[3] ?? "") || (m[1] === "(" && m[5] === ")");
      const value = `${code} ${negative ? "-" : ""}${(m[4] ?? "").replace(/,/g, "")}${m[6] ? ` ${m[6]}` : ""}`;

      // Only the clause right before the figure: "Bill scheduled for payment. E.ON
      // Next bill £48.56" is labelled "E.ON Next bill", not the whole line.
      const before = (line.slice(0, m.index ?? 0).split(/[.!?]\s+/).pop() ?? "").replace(/[:\-–—\s]+$/, "").trim();
      let label = looksLikeLabel(before) ? before : "";
      if (!label) {
        // A heading and its small print both sit above the figure; the heading is
        // the shorter one. Stop at the previous amount, which owns what is above it.
        const candidates: string[] = [];
        for (let back = 1; back <= 3 && index - back >= 0; back++) {
          const candidate = lines[index - back] ?? "";
          if (/[£$€¥₹]\s?\d/.test(candidate)) break;
          if (looksLikeLabel(candidate)) candidates.push(candidate);
        }
        const words = (t: string): number => t.split(/\s+/).length;
        label = candidates.reduce((best, c) => (best === "" || words(c) < words(best) ? c : best), "");
      }
      if (!label) continue;

      const key = `${label}|${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // "Your current balance is" reads as a label once the dangling verb goes.
      label = label.replace(/\s+/g, " ").replace(/\s+(?:is|of|was|are|will be)$/i, "");
      out.push({ label, value, role: roleOf(label) });
    }
  });

  return out;
}

export function kindOf(surface: Surface, text: string): MoneyKind | undefined {
  for (const [kind, re] of KIND_SIGNALS) if (re.test(text)) return kind;
  return surface === "invoice" ? "bill" : undefined;
}

const headlineRoles: Record<MoneyKind, readonly MoneyLine["role"][]> = {
  payout: ["paid", "pending", "gross"],
  bill: ["due", "total", "other"],
  receipt: ["total", "due", "other"],
  statement: ["balance", "total", "other"],
};

export function buildMoneySummary(
  surface: Surface,
  pageText: string,
  entities: readonly Entity[],
  now: number,
): MoneySummary | undefined {
  if (surface === "job") return undefined;
  const kind = kindOf(surface, pageText);
  if (!kind) return undefined;

  let lines = labelledAmounts(pageText);

  // No labels to be had: fall back to the extracted amounts, unnamed.
  if (lines.length === 0) {
    lines = entities
      .filter((e) => e.type === "amount")
      .map((e) => {
        const role: MoneyLine["role"] = / (?:DR|CR)$/.test(e.value) || /\bbalance\b/i.test(e.source) ? "balance" : roleOf(e.source);
        return { label: role === "balance" ? "Balance" : kind === "bill" ? "Payment" : "Amount", value: e.value, role };
      });
  }
  if (lines.length === 0) return undefined;

  const headline =
    headlineRoles[kind].map((role) => lines.find((l) => l.role === role)).find((l) => l !== undefined) ??
    lines.find((l) => !l.value.includes(" -")) ??
    lines[0]!;

  const dated = entities
    .filter((e) => (e.type === "deadline" || e.type === "date") && e.resolvedAt !== undefined)
    .filter((e) => kind !== "bill" || (e.resolvedAt ?? 0) >= now - 24 * 60 * 60 * 1000)
    .sort((a, b) => (a.type === "deadline" ? -1 : 0) - (b.type === "deadline" ? -1 : 0) || (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0));

  const reference = entities.find((e) => e.type === "reference")?.value;
  const organisation = entities.find((e) => e.type === "organisation")?.value;

  return {
    kind,
    headline,
    // The headline figure again under another label is the same money twice.
    lines: lines.filter((l) => l !== headline && l.value !== headline.value),
    ...(dated[0]?.resolvedAt !== undefined ? { dueAt: dated[0].resolvedAt } : {}),
    ...(reference ? { account: reference } : {}),
    ...(organisation ? { from: organisation } : {}),
  };
}

/** Kept name for the analysis pipeline. */
export const buildBillSummary = buildMoneySummary;
