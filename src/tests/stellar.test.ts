/**
 * Tests for Stellar amount parsing and formatting.
 */

import "./mocks.js";
import { describe, it, expect } from "vitest";
import {
  parseAmount,
  formatAmount,
  formatAmountTrimmed,
  AmountError,
  USDC_STROOP,
} from "../stellar.js";

describe("parseAmount", () => {
  it("parses whole numbers", () => {
    expect(parseAmount("1")).toBe(USDC_STROOP);
    expect(parseAmount("10")).toBe(10n * USDC_STROOP);
    expect(parseAmount("100")).toBe(100n * USDC_STROOP);
  });

  it("parses decimal amounts", () => {
    expect(parseAmount("1.5")).toBe(15_000_000n);
    expect(parseAmount("0.0000001")).toBe(1n);
    expect(parseAmount("0.5")).toBe(5_000_000n);
  });

  it("handles 7 decimal places", () => {
    expect(parseAmount("1.2345678")).toBe(12_345_678n);
    expect(parseAmount("1.0000001")).toBe(10_000_001n);
  });

  it("rejects zero", () => {
    expect(() => parseAmount("0")).toThrow(AmountError);
    expect(() => parseAmount("0.0000000")).toThrow(AmountError);
  });

  it("rejects negative numbers", () => {
    expect(() => parseAmount("-1")).toThrow(AmountError);
    expect(() => parseAmount("-0.5")).toThrow(AmountError);
  });

  it("rejects more than 7 decimal places", () => {
    expect(() => parseAmount("1.00000001")).toThrow(AmountError);
  });

  it("rejects non-numeric strings", () => {
    expect(() => parseAmount("abc")).toThrow(AmountError);
    expect(() => parseAmount("1.2.3")).toThrow(AmountError);
    expect(() => parseAmount("")).toThrow(AmountError);
    expect(() => parseAmount("1e5")).toThrow(AmountError);
  });

  it("rejects injection-style strings", () => {
    expect(() => parseAmount("'; DROP TABLE users; --")).toThrow(AmountError);
    expect(() => parseAmount("<script>alert(1)</script>")).toThrow(AmountError);
    expect(() => parseAmount("1 OR 1=1")).toThrow(AmountError);
  });

  it("rejects amounts over the per-transfer cap", () => {
    // Default cap is 100 USDC
    expect(() => parseAmount("101")).toThrow(AmountError);
    expect(() => parseAmount("9999999")).toThrow(AmountError);
  });

  it("rejects absurdly large numbers", () => {
    expect(() => parseAmount("999999999999")).toThrow(AmountError);
  });

  it("accepts the exact maximum", () => {
    expect(() => parseAmount("100")).not.toThrow();
  });
});

describe("formatAmount / formatAmountTrimmed", () => {
  it("formats stroops to 7dp string", () => {
    expect(formatAmount(USDC_STROOP)).toBe("1.0000000");
    expect(formatAmount(15_000_000n)).toBe("1.5000000");
    expect(formatAmount(1n)).toBe("0.0000001");
  });

  it("trims trailing zeros", () => {
    expect(formatAmountTrimmed(USDC_STROOP)).toBe("1");
    expect(formatAmountTrimmed(15_000_000n)).toBe("1.5");
    expect(formatAmountTrimmed(1n)).toBe("0.0000001");
    expect(formatAmountTrimmed(0n)).toBe("0");
  });
});
