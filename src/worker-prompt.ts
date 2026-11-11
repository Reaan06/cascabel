// Worker identity (S1). The routed child must be *your* worker: we read the
// agent file live at every spawn — no snapshots, no cloned copies, no new
// agent definitions. A missing file is a hard, clear error.
import { readFileSync } from "node:fs";

export class WorkerPromptError extends Error {}

export function workerAgentPath(override?: string): string {
  if (override) return override;
  if (process.env.CASCABEL_WORKER_AGENT) return process.env.CASCABEL_WORKER_AGENT;
  return `${process.env.HOME ?? ""}/.pi/agent/agents/gentle-ai-worker.md`;
}

/**
 * Frontmatter-none stripping: agent definition files start with a YAML
 * frontmatter block (name/description for the catalog) which is metadata,
 * not instructions. Everything after it is the worker's operating contract.
 */
export function stripFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) return normalized.trim();
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return normalized.trim();
  const after = normalized.slice(end + 1).replace(/^---\n/, "");
  return after.trim();
}

export function loadWorkerPrompt(path?: string): string {
  const file = workerAgentPath(path);
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    if (errno === "ENOENT") {
      throw new WorkerPromptError(
        `worker agent file not found at ${file}; Cascabel routes your existing worker and refuses to invent instructions`,
      );
    }
    throw new WorkerPromptError(`cannot read worker agent file ${file}: ${(err as Error).message}`);
  }
  const prompt = stripFrontmatter(contents);
  if (prompt.trim().length === 0) {
    throw new WorkerPromptError(
      `worker agent file ${file} has no body after frontmatter; refusing to launch instruction-less children`,
    );
  }
  return prompt;
}
