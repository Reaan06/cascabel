import { describe, expect, it } from "vitest";
import { encodeFrame, decodeFrames } from "../src/jsonl";

describe("JSONL framing (LF only)", () => {
  it("encodes with a trailing \\n", () => {
    expect(encodeFrame({ type: "prompt" })).toBe('{"type":"prompt"}\n');
  });

  it("decodes split chunks keeping the remainder", () => {
    const first = decodeFrames('{"a":1}\n{"b":2}\n{"c":');
    expect(first.frames).toEqual([{ a: 1 }, { b: 2 }]);
    expect(first.remainder).toBe('{"c":');
    const second = decodeFrames("3}\n", first.remainder);
    expect(second.frames).toEqual([{ c: 3 }]);
    expect(second.remainder).toBe("");
  });

  it("ignores empty lines", () => {
    expect(decodeFrames("\n\n{"+'"x":1}'+"\n\n").frames).toEqual([{ x: 1 }]);
  });

  it("never splits on U+2028/U+2029 (rpc.md:51)", () => {
    const msg = { text: "line sep\u2028here  \u2029here" };
    const framed = encodeFrame(msg);
    const { frames } = decodeFrames(framed);
    expect(frames[0]).toEqual(msg);
  });

  it("fails closed on malformed frames with context", () => {
    expect(() => decodeFrames("not json\n"))
      .toThrowError(/malformed JSON frame/);
  });

  it("rejects newline-injected frame boundaries", () => {
    // a payload containing a literal \n must be escaped by JSON.stringify
    const framed = encodeFrame({ evil: "line\nother frame" });
    expect(decodeFrames(framed).frames).toHaveLength(1);
  });
});
