import { describe, it, expect } from "vitest";
import { cleanTitle, shortenUrl, trimForStorage, MAX_VALUE_LENGTH } from "@core/storage-hygiene";
import type { Entity } from "@core/types";

describe("cleanTitle", () => {
  it("removes the user's own email address from a webmail title", () => {
    /*
     * The bug this exists for: Gmail titles its tab
     * "Subject - you@gmail.com - Gmail", so saving it verbatim wrote the user's
     * address into every reminder and saved item they ever made.
     */
    const cleaned = cleanTitle("Barclays wants you to apply - asfcit15sayamajmal@gmail.com - Gmail", "mail.google.com");
    expect(cleaned).toBe("Barclays wants you to apply");
    expect(cleaned).not.toMatch(/@/);
  });

  it("strips other mail clients too", () => {
    expect(cleanTitle("Invoice 42 - me@work.com - Outlook", "outlook.com")).toBe("Invoice 42");
    expect(cleanTitle("Notes - Proton Mail", "proton.me")).toBe("Notes");
  });

  it("removes an address appearing anywhere, not only before the client name", () => {
    expect(cleanTitle("Re: contract someone@example.org thread", "x.com")).not.toMatch(/@/);
  });

  it("leaves an ordinary title alone", () => {
    expect(cleanTitle("Senior Frontend Engineer — Halcyon Labs", "careers.example.com"))
      .toBe("Senior Frontend Engineer — Halcyon Labs");
  });

  it("falls back to the domain rather than storing something nameless", () => {
    expect(cleanTitle("   ", "example.com")).toBe("example.com");
    expect(cleanTitle("you@example.com", "example.com")).toBe("example.com");
  });

  it("caps a runaway title", () => {
    const cleaned = cleanTitle("x".repeat(400), "example.com");
    expect(cleaned.length).toBeLessThanOrEqual(120);
  });
});

describe("trimForStorage", () => {
  const entity = (value: string): Entity => ({
    type: "url", value, confidence: 0.9, source: "a long explanatory snippet from the page", sensitivity: "public",
  });

  it("caps a tracking URL instead of storing all 700 characters of it", () => {
    const trimmed = trimForStorage(entity(`https://cio.mail-hackajob.com/e/c/${"e".repeat(700)}`));
    expect(trimmed.value.length).toBeLessThanOrEqual(MAX_VALUE_LENGTH);
    expect(trimmed.value.endsWith("…")).toBe(true);
  });

  it("drops the source snippet, which has done its job by the time anything is saved", () => {
    expect(trimForStorage(entity("https://example.com")).source).toBe("");
  });

  it("keeps a resolved date, because that is what reminders key off", () => {
    const dated: Entity = { type: "deadline", value: "x", confidence: 1, source: "s", sensitivity: "public", resolvedAt: 123 };
    expect(trimForStorage(dated).resolvedAt).toBe(123);
  });

  it("leaves a short value untouched", () => {
    expect(trimForStorage(entity("https://example.com/apply")).value).toBe("https://example.com/apply");
  });
});

describe("shortenUrl", () => {
  it("shows where a link goes without 700 characters of tracking payload", () => {
    const short = shortenUrl(`https://cio.mail-hackajob.com/e/c/${"e".repeat(700)}`);
    expect(short.startsWith("cio.mail-hackajob.com")).toBe(true);
    expect(short.length).toBeLessThan(60);
  });

  it("survives something that is not a URL", () => {
    expect(shortenUrl("not a url")).toBe("not a url");
  });
});
