/**
 * Graph schema block builder for the Planner.
 * Injects the live per-type entity profile so the planner knows what data exists.
 */

import { inboxPieDb } from "../../db/inboxpie-db";

export async function buildGraphSchemaBlock(): Promise<string> {
  const profile = inboxPieDb.getGraphTypeProfile();

  const lines = [
    "This user's email graph contains:",
    "",
  ];

  for (const type of ["ORG", "PERSON", "PRODUCT", "PLACE", "EVENT", "DATE", "AMOUNT", "TOPIC"]) {
    const { count, examples } = profile[type] || { count: 0, examples: [] };
    if (count === 0) {
      lines.push(`  ${type}: 0 nodes (empty)`);
    } else {
      const exStr = examples.length > 0 ? ` [${examples.join(", ")}]` : "";
      lines.push(`  ${type}: ${count} nodes${exStr}`);
    }
  }

  return lines.join("\n");
}
