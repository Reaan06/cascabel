// LF-strict JSONL framing. Pi's RPC docs warn: do not split on U+2028/U+2029,
// so everything here splits on "\n" only (docs/rpc.md:51-54, docs/json.md:14-18).
export function encodeFrame(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

export interface FrameParseResult {
  frames: Array<Record<string, unknown>>;
  /** Trailing bytes that do not end in \n and may be an incomplete frame. */
  remainder: string;
}

export function decodeFrames(chunk: string, previous = ""): FrameParseResult {
  const buffer = previous + chunk;
  const frames: Array<Record<string, unknown>> = [];
  const lines = buffer.split("\n");
  // The last element is the remainder after the final \n (or "" if clean).
  const remainder = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      frames.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch (err) {
      throw new Error(
        `cascabel: malformed JSON frame from child: ${(err as Error).message}; line: ${trimmed.slice(0, 200)}`,
        { cause: err },
      );
    }
  }
  return { frames, remainder };
}
