import { describe, expect, test } from "bun:test";
import { asObject, asString, isJsonObject } from "./payload";

describe("asString", () => {
  test("hands back the string itself", () => {
    expect(asString("hello")).toBe("hello");
    expect(asString("")).toBe("");
  });

  test("refuses everything that merely prints like one", () => {
    expect(asString(42)).toBeUndefined();
    expect(asString(true)).toBeUndefined();
    expect(asString(null)).toBeUndefined();
    expect(asString(undefined)).toBeUndefined();
    expect(asString({ label: "x" })).toBeUndefined();
    expect(asString(["x"])).toBeUndefined();
  });
});

describe("asObject", () => {
  test("hands back a plain object", () => {
    expect(asObject({ command: "ls" })).toEqual({ command: "ls" });
  });

  test("an array is not an object here", () => {
    expect(asObject(["ls"])).toBeUndefined();
  });

  test("primitives and null are not objects", () => {
    expect(asObject("ls")).toBeUndefined();
    expect(asObject(7)).toBeUndefined();
    expect(asObject(null)).toBeUndefined();
    expect(asObject(undefined)).toBeUndefined();
  });
});

describe("isJsonObject", () => {
  test("agrees with asObject on every shape", () => {
    for (const value of [{ a: 1 }, [], "s", 0, false, null, undefined] as const) {
      expect(isJsonObject(value)).toBe(asObject(value) !== undefined);
    }
  });
});
