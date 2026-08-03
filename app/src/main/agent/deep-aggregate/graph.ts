/**
 * Deep-aggregate pipeline: Planner → Recall → Branch → Summarizer
 * Simplified sequential without complex conditional routing.
 */

import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { BaseMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { embedText } from "../embeddings";
import { lanceStore } from "../../db/lance-store";
import { inboxPieDb } from "../../db/inboxpie-db";
import { buildGraphSchemaBlock } from "./schema";
import { PlanSchema, PLANNER_PROMPT, WORKER_PROMPT, SUMMARIZER_PROMPT, type Plan } from "./prompts";
import type { AgentResponse, AgentStep } from "../nlp-agent";

// ── Types ──────────────────────────────────────────────────────────────────

type Aggregate = Record<string, { count: number; sum: number }>;

// ── State annotation with reducer for streaming merge ────────────────────

const aggregateReducer = (left: Aggregate = {}, right: Aggregate = {}) => {
  const merged = { ...left };
  for (const [key, rval] of Object.entries(right)) {
    if (!merged[key]) {
      merged[key] = rval;
    } else {
      merged[key].count += rval.count;
      merged[key].sum += rval.sum;
    }
  }
  return merged;
};

const StateAnnotation = Annotation.Root({
  question: Annotation<string>,
  plan: Annotation<Plan | null>,
  mailIds: Annotation<string[]>,
  partials: Annotation<Aggregate>({
    reducer: aggregateReducer,
    default: () => ({}),
  }),
  agentSteps: Annotation<AgentStep[]>({
    reducer: (l, r) => [...l, ...r],
    default: () => [],
  }),
  answer: Annotation<AgentResponse | null>,
});

// ── Nodes ──────────────────────────────────────────────────────────────────

async function buildIndexProfileBlockInternal(): Promise<string> {
  try {
    const p = await lanceStore.getIndexProfile();
    if (!p.total) return "";
    const domains = p.domains.slice(0, 30).map((d: any) => `${d.domain}(${d.count})`).join(", ");
    const folders = p.folders.slice(0, 25).map((f: any) => `${f.folder}(${f.count})`).join(", ");
    const years = p.years.length ? `${Math.min(...p.years)}–${Math.max(...p.years)}` : "n/a";
    return [
      "INDEX PROFILE:",
      `- Years present: ${years}`,
      `- Folders: ${folders}`,
      `- Top sender domains: ${domains}`,
    ].join("\n");
  } catch {
    return "";
  }
}

async function plannerNode(state: typeof StateAnnotation.State, llm: BaseChatModel, emit: (s: AgentStep) => void) {
  console.log(`[LangGraph] ▶ Planner: analyzing question "${state.question.substring(0, 80)}..."`);
  emit({ type: "intent", label: "Planning", detail: "Analyzing query structure" });

  const graphSchema = await buildGraphSchemaBlock();
  const indexBlock = await buildIndexProfileBlockInternal();

  const prompt = PLANNER_PROMPT(graphSchema, indexBlock)
    .replace("{USER_QUESTION}", state.question);

  console.log(`[LangGraph]   invoking LLM to create plan...`);
  const response = await llm.invoke([new HumanMessage(prompt)]);
  const text = typeof response.content === "string" ? response.content : String(response.content);

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Planner did not return valid JSON");

  let parsed = JSON.parse(jsonMatch[0]);

  // Normalize common LLM output mistakes
  if (parsed.measure) {
    if (typeof parsed.measure === "string") {
      // Ensure it's lowercase "count"
      if (parsed.measure.toLowerCase() === "count") {
        parsed.measure = "count";
      } else if (typeof parsed.measure === "string" && parsed.measure.includes("{")) {
        // Try to parse if it's a stringified JSON
        try {
          parsed.measure = JSON.parse(parsed.measure);
        } catch {
          // Leave as-is, schema validation will catch it
        }
      }
    }
    // If measure is an object, ensure sum_type is uppercase
    if (typeof parsed.measure === "object" && parsed.measure.sum_type) {
      parsed.measure.sum_type = parsed.measure.sum_type.toUpperCase();
    }
  }

  // Ensure filters is an object
  if (!parsed.filters || typeof parsed.filters !== "object") {
    parsed.filters = {};
  }

  // Ensure keyword is a string
  if (!parsed.keyword) {
    parsed.keyword = "";
  }

  // Default sensible values if missing
  if (!parsed.reduce_key_type) {
    parsed.reduce_key_type = "PLACE"; // Default to PLACE if query is about grouping
  }
  if (!parsed.chart_type) {
    parsed.chart_type = "pie_chart"; // Default chart
  }

  const plan = PlanSchema.parse(parsed);

  console.log(`[LangGraph]   ✓ Plan decided:`);
  console.log(`[LangGraph]     task: ${plan.task_summary}`);
  console.log(`[LangGraph]     reduce_key: ${plan.reduce_key} (type: ${plan.reduce_key_type})`);
  console.log(`[LangGraph]     measure: ${typeof plan.measure === "string" ? plan.measure : JSON.stringify(plan.measure)}`);
  console.log(`[LangGraph]     search_query: "${plan.search_query}"`);
  console.log(`[LangGraph]     keyword: ${plan.keyword ? `"${plan.keyword}"` : "(none)"}`);
  console.log(`[LangGraph]     chart_type: ${plan.chart_type}`);

  return { plan };
}

async function recallNode(state: typeof StateAnnotation.State) {
  if (!state.plan) throw new Error("Plan is required");

  console.log(`[LangGraph] ▶ Recall: exhaustive search for "${state.plan.search_query}"`);

  // For aggregation queries, we need ALL results, not a limited candidate pool.
  // Set limit to a very high number (will fetch everything in one pass if available).
  const MAX_RESULTS = 50000;

  const queryVec = await embedText(state.plan.search_query);

  const candidates = await lanceStore.search(queryVec, {
    limit: MAX_RESULTS,
    queryText: state.plan.search_query,
    yearFrom: state.plan.filters.year_from,
    yearTo: state.plan.filters.year_to,
    folderType: state.plan.filters.folder_type,
    domain: state.plan.filters.domain,
  });

  console.log(`[LangGraph]   Hybrid vector+BM25 search: ${candidates.length} results (limit=${MAX_RESULTS})`);

  // Exhaustive keyword search: finds EVERY email containing the keyword, no ANN limit.
  // For aggregation queries like "FastTag", this ensures we don't miss any transactions
  // just because they ranked outside the top-K of the vector index.
  const exhaustive = state.plan.keyword
    ? await lanceStore.searchExhaustive(state.plan.keyword, { limit: MAX_RESULTS })
    : [];

  if (exhaustive.length > 0) {
    const hitLimit = exhaustive.length >= MAX_RESULTS;
    const warningMsg = hitLimit ? ` ⚠️  HIT LIMIT (may be more results)` : "";
    console.log(`[LangGraph]   Exhaustive BM25 keyword search ("${state.plan.keyword}"): ${exhaustive.length} matches${warningMsg}`);
  }

  // Merge both result sets by ID to avoid duplicates.
  const byId = new Map(candidates.map((r) => [r.id, r]));
  for (const r of exhaustive) {
    if (!byId.has(r.id)) byId.set(r.id, r);
  }

  const mailIds = [...byId.keys()];
  const hitsLimitWarning = mailIds.length >= MAX_RESULTS ? ` ⚠️  CAPPED at ${MAX_RESULTS}` : "";
  console.log(`[LangGraph]   Merged pool: ${mailIds.length} unique emails${hitsLimitWarning}`);

  return {
    mailIds,
    agentSteps: [
      { type: "intent", label: "Found emails", detail: `${mailIds.length} emails matching query` },
    ],
  };
}

async function branchNode(state: typeof StateAnnotation.State, llm: BaseChatModel, emit: (s: AgentStep) => void) {
  if (!state.plan) throw new Error("Plan is required");

  const needsContent =
    state.plan.reduce_key_type === "BODY" ||
    (typeof state.plan.measure === "object" && state.plan.measure.sum_type === "BODY");

  // CRITICAL: When grouping by one entity type and summing a DIFFERENT entity type,
  // we MUST read content to extract the relationship (e.g., "group by PLACE, sum AMOUNT").
  // The fast path assumes the amount is embedded in the grouping entity's label, which fails
  // for cross-entity aggregations like "toll plaza (PLACE) and payment amount (AMOUNT)".
  let isCrossEntityAggregation = false;
  let sumType: string | undefined;
  if (typeof state.plan.measure === "object") {
    sumType = state.plan.measure.sum_type;
    isCrossEntityAggregation = sumType !== "BODY" && state.plan.reduce_key_type !== sumType;
  }

  console.log(`[LangGraph] ▶ Branch: decide path for reduce_key_type="${state.plan.reduce_key_type}" measure=${JSON.stringify(state.plan.measure)}`);
  console.log(`[LangGraph]   isCrossEntityAggregation=${isCrossEntityAggregation} (reduceType=${state.plan.reduce_key_type} vs sumType=${sumType ?? "count"})`);
  if (isCrossEntityAggregation) {
    console.log(`[LangGraph]   Cross-entity aggregation detected (${state.plan.reduce_key_type} + ${sumType}) → forcing SLOW path`);
  }

  if (!needsContent && !isCrossEntityAggregation) {
    // Fast path: aggregate from typed nodes only
    console.log(`[LangGraph]   Path: FAST (no content reading needed)`);
    const nodes = inboxPieDb.getNodesForMails(state.mailIds);
    console.log(`[LangGraph]     getNodesForMails: ${nodes.length} nodes total`);
    const filtered = nodes.filter((n) => n.type === state.plan!.reduce_key_type);
    console.log(`[LangGraph]     filtered by type: ${filtered.length} nodes of type ${state.plan.reduce_key_type}`);

    const partials: Aggregate = {};
    for (const node of filtered) {
      if (!partials[node.label]) {
        partials[node.label] = { count: 0, sum: 0 };
      }
      partials[node.label].count += 1;
      if (typeof state.plan!.measure === "object") {
        const match = node.label.match(/[\d,]+(?:\.\d+)?/);
        if (match) {
          partials[node.label].sum += parseFloat(match[0].replace(/,/g, ""));
        }
      }
    }

    console.log(`[LangGraph]     aggregated: ${Object.keys(partials).length} distinct groups`);
    return {
      partials,
      agentSteps: [
        { type: "intent", label: "Aggregated from graph", detail: `${Object.keys(partials).length} groups` },
      ],
    };
  }

  // Slow path: extract from email content via LLM
  console.log(`[LangGraph]   Path: SLOW (reading email content, need_content=true)`);
  const BATCH_SIZE = 25;
  const allPartials: Aggregate = {};
  const totalBatches = Math.ceil(state.mailIds.length / BATCH_SIZE);
  console.log(`[LangGraph]     will process ${totalBatches} batches of ${BATCH_SIZE} emails each`);

  for (let i = 0; i < state.mailIds.length; i += BATCH_SIZE) {
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const batchIds = state.mailIds.slice(i, i + BATCH_SIZE);

    console.log(`[LangGraph]     Batch ${batchNum}/${totalBatches}: fetching ${batchIds.length} emails`);

    const nodes = inboxPieDb.getNodesForMails(batchIds);
    const bodies = inboxPieDb.getBodiesByIds(batchIds);

    const bodyMap = new Map(bodies.map((b) => [b.id, b.body_text]));

    const emailsForPrompt = batchIds.map((id, idx) => ({
      index: idx + 1,
      body: bodyMap.get(id) || "",
      entities: nodes.filter((n) => n.mailId === id),
    }));

    const prompt = WORKER_PROMPT(state.plan)
      .replace("{EMAILS_JSON}", JSON.stringify(emailsForPrompt, null, 2));

    console.log(`[LangGraph]     Batch ${batchNum}/${totalBatches}: invoking LLM worker...`);
    const response = await llm.invoke([new HumanMessage(prompt)]);
    const text = typeof response.content === "string" ? response.content : String(response.content);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(`[LangGraph]     Batch ${batchNum}/${totalBatches}: ✗ no JSON in response`);
      continue;
    }

    try {
      const partial: Aggregate = JSON.parse(jsonMatch[0]);
      console.log(`[LangGraph]     Batch ${batchNum}/${totalBatches}: ✓ parsed ${Object.keys(partial).length} groups from worker`);
      for (const [key, val] of Object.entries(partial)) {
        if (!allPartials[key]) allPartials[key] = { count: 0, sum: 0 };
        allPartials[key].count += val.count;
        allPartials[key].sum += val.sum;
      }
    } catch (e) {
      console.warn(`[LangGraph]     Batch ${batchNum}/${totalBatches}: ✗ parse error`, e);
    }
  }

  console.log(`[LangGraph]     all batches done: merged into ${Object.keys(allPartials).length} distinct groups`);
  return {
    partials: allPartials,
    agentSteps: [
      { type: "intent", label: `Processed ${totalBatches} batches`, detail: `${Object.keys(allPartials).length} groups` },
    ],
  };
}

async function reduceNode(state: typeof StateAnnotation.State) {
  console.log(`[LangGraph] ▶ Reduce: sorting ${Object.keys(state.partials).length} groups by sum descending`);

  const sorted = Object.entries(state.partials)
    .sort((a, b) => b[1].sum - a[1].sum);

  const topN = sorted.slice(0, 20);
  const finalTable = Object.fromEntries(topN);

  console.log(`[LangGraph]   top 20: ${Object.keys(finalTable).length} groups`);
  const topLabels = Object.keys(finalTable).slice(0, 5).join(", ");
  console.log(`[LangGraph]   top groups: [${topLabels}${Object.keys(finalTable).length > 5 ? ", ..." : ""}]`);

  return {
    partials: finalTable,
    agentSteps: [
      { type: "intent", label: "Finalized results", detail: `${Object.keys(finalTable).length} groups` },
    ],
  };
}

async function summarizerNode(state: typeof StateAnnotation.State, llm: BaseChatModel, emit: (s: AgentStep) => void) {
  if (!state.plan) throw new Error("Plan required");

  console.log(`[LangGraph] ▶ Summarizer: composing answer for ${Object.keys(state.partials).length} groups, chart_type="${state.plan.chart_type}"`);

  emit({ type: "result", label: "Composing answer" });

  const prompt = SUMMARIZER_PROMPT(state.plan)
    .replace("{FINAL_TABLE_JSON}", JSON.stringify(state.partials, null, 2));

  console.log(`[LangGraph]   prompt length: ${prompt.length} chars`);
  console.log(`[LangGraph]   invoking LLM for final prose...`);

  const response = await llm.invoke([new HumanMessage(prompt)]);
  const text = typeof response.content === "string" ? response.content : String(response.content);

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Summarizer did not return valid JSON");

  const parsed = JSON.parse(jsonMatch[0]);
  console.log(`[LangGraph]   ✓ parsed answer: "${parsed.answer_text?.substring(0, 80)}..."`);

  const rows = Object.entries(state.partials).map(([key, { count, sum }]) => ({
    [state.plan!.reduce_key]: key,
    count,
    sum,
  }));

  const answer: AgentResponse = {
    intent: state.plan.task_summary,
    response_type: state.plan.chart_type,
    answer_text: parsed.answer_text || "",
    rows,
  };

  console.log(`[LangGraph] ✓ Pipeline complete: ${rows.length} rows, chart="${answer.response_type}"`);

  return { answer };
}

// ── Build graph ────────────────────────────────────────────────────────────

export function buildDeepAggregateGraph(llm: BaseChatModel, emit: (s: AgentStep) => void) {
  const graph = new StateGraph(StateAnnotation) as any;

  // Simple linear flow: planner → recall → branch → reduce → summarizer
  graph.addNode("planner", async (state: typeof StateAnnotation.State) => plannerNode(state, llm, emit));
  graph.addNode("recall", async (state: typeof StateAnnotation.State) => recallNode(state));
  graph.addNode("branch", async (state: typeof StateAnnotation.State) => branchNode(state, llm, emit));
  graph.addNode("reduce", async (state: typeof StateAnnotation.State) => reduceNode(state));
  graph.addNode("summarizer", async (state: typeof StateAnnotation.State) => summarizerNode(state, llm, emit));

  // Straight chain
  graph.addEdge(START, "planner");
  graph.addEdge("planner", "recall");
  graph.addEdge("recall", "branch");
  graph.addEdge("branch", "reduce");
  graph.addEdge("reduce", "summarizer");
  graph.addEdge("summarizer", END);

  return graph.compile();
}
