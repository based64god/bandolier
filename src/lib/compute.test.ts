import { describe, expect, it } from "vitest";

import {
  cpuToMillicores,
  memoryToBytes,
  parseCpuQuery,
  parseMemoryQuery,
  validateCpuQuantity,
  validateMemoryQuantity,
} from "~/lib/compute";

describe("cpuToMillicores", () => {
  it("parses millicores", () => {
    expect(cpuToMillicores("500m")).toBe(500);
  });

  it("parses whole and fractional cores", () => {
    expect(cpuToMillicores("2")).toBe(2000);
    expect(cpuToMillicores("1.5")).toBe(1500);
  });

  it("tolerates surrounding whitespace", () => {
    expect(cpuToMillicores(" 250m ")).toBe(250);
  });

  it("rejects malformed quantities", () => {
    for (const bad of ["", "m", "2c", "1,5", "-1", "2 m", "0x2", "2Gi"]) {
      expect(cpuToMillicores(bad)).toBeNull();
    }
  });
});

describe("memoryToBytes", () => {
  it("parses binary suffixes", () => {
    expect(memoryToBytes("512Mi")).toBe(512 * 1024 ** 2);
    expect(memoryToBytes("4Gi")).toBe(4 * 1024 ** 3);
    expect(memoryToBytes("1Ti")).toBe(1024 ** 4);
  });

  it("parses decimal suffixes and plain bytes", () => {
    expect(memoryToBytes("1G")).toBe(1000 ** 3);
    expect(memoryToBytes("1.5G")).toBe(1.5 * 1000 ** 3);
    expect(memoryToBytes("1024")).toBe(1024);
  });

  it("rejects malformed quantities", () => {
    for (const bad of ["", "Gi", "4GiB", "4 Gi", "-4Gi", "4g", "4m"]) {
      expect(memoryToBytes(bad)).toBeNull();
    }
  });
});

describe("validateCpuQuantity", () => {
  it("accepts and normalizes (trims) a valid quantity", () => {
    expect(validateCpuQuantity(" 4 ")).toEqual({
      valid: true,
      normalized: "4",
    });
    expect(validateCpuQuantity("500m")).toEqual({
      valid: true,
      normalized: "500m",
    });
  });

  it("rejects a malformed quantity with a usage hint", () => {
    const v = validateCpuQuantity("lots");
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.error).toContain('Invalid CPU quantity "lots"');
  });

  it("rejects zero and out-of-bounds values", () => {
    expect(validateCpuQuantity("0").valid).toBe(false);
    expect(validateCpuQuantity("0m").valid).toBe(false);
    // 65 cores is past the 64-core ceiling; 64 is the boundary and allowed.
    expect(validateCpuQuantity("65").valid).toBe(false);
    expect(validateCpuQuantity("64").valid).toBe(true);
  });
});

describe("validateMemoryQuantity", () => {
  it("accepts and normalizes (trims) a valid quantity", () => {
    expect(validateMemoryQuantity(" 4Gi ")).toEqual({
      valid: true,
      normalized: "4Gi",
    });
  });

  it("defaults a bare number to Gi", () => {
    expect(validateMemoryQuantity("4")).toEqual({
      valid: true,
      normalized: "4Gi",
    });
    expect(validateMemoryQuantity(" 1.5 ")).toEqual({
      valid: true,
      normalized: "1.5Gi",
    });
  });

  it("rejects a malformed quantity with a usage hint", () => {
    const v = validateMemoryQuantity("4 gigs");
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.error).toContain("Invalid memory quantity");
  });

  it("rejects unit mistakes below the floor (megabytes typos)", () => {
    // An explicit small unit like "64Mi" is under any workable harness
    // footprint — almost certainly a unit mistake. (A bare "512" is read as
    // Gi, not bytes, so it's valid.)
    expect(validateMemoryQuantity("64Mi").valid).toBe(false);
    expect(validateMemoryQuantity("4M").valid).toBe(false);
    expect(validateMemoryQuantity("128Mi").valid).toBe(true);
    expect(validateMemoryQuantity("512")).toEqual({
      valid: true,
      normalized: "512Gi",
    });
  });

  it("rejects values past the ceiling", () => {
    expect(validateMemoryQuantity("513Gi").valid).toBe(false);
    expect(validateMemoryQuantity("512Gi").valid).toBe(true);
    expect(validateMemoryQuantity("2Ti").valid).toBe(false);
  });
});

describe("parseCpuQuery / parseMemoryQuery", () => {
  it("resolves valid label values to the normalized quantity", () => {
    expect(parseCpuQuery(" 4 ")).toBe("4");
    expect(parseMemoryQuery("8Gi")).toBe("8Gi");
  });

  it("returns undefined on anything invalid so callers fall back", () => {
    expect(parseCpuQuery("fast")).toBeUndefined();
    expect(parseCpuQuery("999")).toBeUndefined();
    expect(parseMemoryQuery("big")).toBeUndefined();
    expect(parseMemoryQuery("2Ti")).toBeUndefined();
  });
});
