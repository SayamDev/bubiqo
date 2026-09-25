/**
 * Reading a number out of page text.
 *
 * This exists because the same bug was written three times in three different
 * regexes: a pattern of the shape `\d{1,3}(?:,\d{3})*` matches the first three
 * digits of an unpunctuated number and stops, so "£70000" reads as 700 and
 * "£2400" as 240 — wrong by two orders of magnitude, on invoices as much as on
 * salaries.
 *
 * One reader, used by every caller, with a table of real formats behind it. A
 * fourth caller written later cannot reintroduce the same fault.
 */

/** The number part of an amount, as it appears in prose. */
export const NUMBER_PATTERN = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?`;

/** Currency symbols and the codes they mean. */
export const SYMBOL_TO_CODE: Readonly<Record<string, string>> = {
  "£": "GBP",
  $: "USD",
  "€": "EUR",
  "¥": "JPY",
  "₹": "INR",
};

export const CURRENCY_CODES = [
  "GBP", "USD", "EUR", "JPY", "INR", "CHF", "CAD", "AUD", "SEK", "NOK", "DKK", "PLN",
] as const;

/**
 * The names behind the codes, for anywhere a person has to choose one.
 *
 * Settings offered a three-character text box, which accepted "XYZ" as happily
 * as "GBP" and then failed a rate lookup with nothing to explain why.
 */
export const CURRENCY_NAMES: Readonly<Record<(typeof CURRENCY_CODES)[number], string>> = {
  GBP: "British pound",
  USD: "US dollar",
  EUR: "Euro",
  JPY: "Japanese yen",
  INR: "Indian rupee",
  CHF: "Swiss franc",
  CAD: "Canadian dollar",
  AUD: "Australian dollar",
  SEK: "Swedish krona",
  NOK: "Norwegian krone",
  DKK: "Danish krone",
  PLN: "Polish złoty",
};

/**
 * Read a numeric string, returning nothing rather than a wrong number.
 *
 * `k` and `m` suffixes are expanded, because a job advert writes "85k" far more
 * often than it writes "85,000".
 */
export function readNumber(raw: string): number | undefined {
  const cleaned = raw.trim().toLowerCase().replace(/,/g, "");
  // Number("") is 0, not NaN — an empty capture would have become a real amount.
  if (!/\d/.test(cleaned)) return undefined;

  const suffix = /^([\d.]+)\s*([km])$/.exec(cleaned);
  if (suffix) {
    const base = Number(suffix[1]);
    if (!Number.isFinite(base)) return undefined;
    return suffix[2] === "k" ? base * 1_000 : base * 1_000_000;
  }

  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

/** Format for storage and display: "GBP 2880.00", "GBP 70000–85000". */
export function formatAmount(code: string, value: number): string {
  return `${code} ${value}`;
}

export function formatRange(code: string, low: number, high: number): string {
  return `${code} ${low}–${high}`;
}

/** Plausible as pay. Keeps a 37.5-hour week and a five-day course out. */
export function looksLikeSalary(value: number): boolean {
  return value >= 10_000 && value <= 5_000_000;
}

/** An amount as a person reads it: "GBP 70000–85000" becomes "£70,000–85,000". */
const CODE_TO_SYMBOL: Readonly<Record<string, string>> = {
  GBP: "£",
  USD: "$",
  EUR: "€",
  JPY: "¥",
  INR: "₹",
};

export function displayMoney(value: string): string {
  const match = /^([A-Z]{3})\s+(-?)(\d+(?:\.\d+)?)(?:\s*[–-]\s*(\d+(?:\.\d+)?))?(?:\s+(DR|CR))?$/.exec(value.trim());
  if (!match) return value;

  const [, code = "", minus = "", low = "", high, marker] = match;
  const symbol = CODE_TO_SYMBOL[code];
  const group = (n: string): string => {
    const [whole = "", fraction] = n.split(".");
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return fraction ? `${grouped}.${fraction}` : grouped;
  };

  const amount = high ? `${group(low)}–${group(high)}` : group(low);
  const money = symbol ? `${symbol}${amount}` : `${code} ${amount}`;

  /*
   * "DR" and "CR" are accountants' words. On a bill, DR is what you owe and CR
   * is money in your favour, so say that — the marker already carries the
   * direction, and a minus sign beside it only adds confusion.
   */
  if (marker === "DR") return `${money} owed`;
  if (marker === "CR") return `${money} in credit`;
  return minus ? `-${money}` : money;
}

