import { describe, it, expect } from "vitest";
import { displayMoney } from "../extension/src/sidepanel/format";

describe("displayMoney", () => {
  it("turns the stored format into something a person reads", () => {
    expect(displayMoney("GBP 70000–85000")).toBe("£70,000–85,000");
    expect(displayMoney("GBP 78000")).toBe("£78,000");
  });

  it("keeps the code when there is no symbol for it", () => {
    expect(displayMoney("PLN 120000")).toBe("PLN 120,000");
  });

  it("leaves anything it does not recognise alone", () => {
    expect(displayMoney("Competitive")).toBe("Competitive");
    expect(displayMoney("")).toBe("");
  });

  it("keeps pence where the amount has them", () => {
    expect(displayMoney("EUR 2880.50")).toBe("€2,880.50");
  });
});
