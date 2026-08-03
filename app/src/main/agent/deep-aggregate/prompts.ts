/**
 * Prompts and schemas for the deep-aggregate pipeline: Planner, Worker, Summarizer.
 */

import { z } from "zod";

export const PlanSchema = z.object({
  task_summary: z.string().describe("Brief summary of what the aggregation will compute"),
  search_query: z.string().describe("Natural language query to find relevant emails"),
  keyword: z.string().default("").describe("Literal term for exhaustive fuzzy match (e.g. 'FastTag'), empty string if none"),
  filters: z.object({
    year_from: z.number().optional().describe("Filter emails from this year onwards"),
    year_to: z.number().optional().describe("Filter emails up to this year"),
    folder_type: z.enum(["inbox", "sent", "trash", "junk", "drafts", "custom"]).optional(),
    domain: z.string().optional().describe("Sender domain to pre-filter"),
  }).default({}),
  reduce_key: z.string().describe("The grouping dimension (e.g. 'toll plaza name', 'sender domain')"),
  reduce_key_type: z.enum(["ORG", "PERSON", "PRODUCT", "TOPIC", "PLACE", "EVENT", "DATE", "AMOUNT", "BODY"])
    .describe("Which entity type the key maps to; BODY = must read from email text"),
  measure: z.union([
    z.literal("count"),
    z.object({
      sum: z.string().describe("The numeric field to sum (e.g. 'payment amount')"),
      sum_type: z.enum(["AMOUNT", "BODY"]).describe("Entity type of the measure; BODY = read from text"),
    }),
  ]).describe("Either 'count' or { sum, sum_type }"),
  chart_type: z.enum(["pie_chart", "bar_chart", "data_table", "stat_card"])
    .describe("Chart type for presentation"),
});

export type Plan = z.infer<typeof PlanSchema>;

export const PLANNER_PROMPT = (graphSchemaBlock: string, indexProfile: string) => `\
You are the PLANNER for an email-analytics pipeline. You do NOT answer the question.
You turn it into a machine contract for a map-reduce job over already-extracted email data.

Our indexer has already extracted a knowledge graph from every email. Entities are typed with
this CLOSED taxonomy — these are the ONLY reliable grouping/measure dimensions:
  ORG     — companies, banks, institutions, brands
  PERSON  — names of individuals
  PRODUCT — named products, services, apps, financial instruments/funds
  PLACE   — cities, countries, regions, addresses, named locations (e.g. toll plazas)
  EVENT   — occasions, conferences, scheduled happenings
  DATE    — dates, times, deadlines
  AMOUNT  — monetary values, quantities, prices
  TOPIC   — anything else / general concepts

This user's graph statistics:
${graphSchemaBlock}

Index profile (what's actually available to search):
${indexProfile}

Output ONLY valid JSON (no markdown, no explanation):
{
  "task_summary": "...",
  "search_query": "...",
  "keyword": "",
  "filters": {},
  "reduce_key": "...",
  "reduce_key_type": "PLACE" or "ORG" or "AMOUNT" or "DATE" or "TOPIC" or "EVENT" or "PERSON" or "PRODUCT" or "BODY",
  "measure": "count" or {"sum": "payment amount", "sum_type": "AMOUNT"} or {"sum": "...", "sum_type": "BODY"},
  "chart_type": "pie_chart"
}

CRITICAL RULES:
1. reduce_key_type MUST be one of: ORG, PERSON, PRODUCT, TOPIC, PLACE, EVENT, DATE, AMOUNT, BODY
2. measure is EITHER the string "count" OR an object with BOTH "sum" and "sum_type" fields
3. sum_type MUST be either "AMOUNT" or "BODY"
4. keyword: FOR AGGREGATION QUERIES, ALWAYS extract the exact brand/service/product name if one exists
   (e.g. "FastTag", "ICICI", "PPFAS"). This triggers exhaustive search that returns EVERY matching
   email, not just the top-ranked ones. Leave empty ONLY for purely conceptual queries with no
   specific term to anchor on. **For named transactions/services, keyword is REQUIRED.**
5. filters should be {} (empty object) unless filtering by year/folder/domain/sender

Example 1 (pie chart of toll plazas, count):
  "reduce_key": "toll plaza name",
  "reduce_key_type": "PLACE",
  "measure": "count",

Example 2 (pie chart of toll plazas, sum amounts):
  "reduce_key": "toll plaza name",
  "reduce_key_type": "PLACE",
  "measure": {"sum": "payment amount", "sum_type": "AMOUNT"},

Do NOT output anything else. JSON only. No markdown fence.

User's question: {USER_QUESTION}

Output:`;

export const WORKER_PROMPT = (plan: Plan) => `\
You are a GRAPH-EXTRACTION & CALCULATION WORKER. You handle ONE batch of emails in isolation.
Task contract: group by "${plan.reduce_key}", measure = ${typeof plan.measure === "string" ? plan.measure : JSON.stringify(plan.measure)}.

For each email you are given (body text + its pre-extracted entities), decide if it is a
genuine instance of the task:
- Drop promos, OTPs, statement summaries, notifications — noise that mentions keywords but
  isn't a real transaction/data point.
- Keep only genuine instances.

For each genuine email, extract ONE (key, value) pair:
- key = the ${plan.reduce_key} (e.g. the toll plaza name for that transaction)
- value = the numeric measure (${typeof plan.measure === "string" ? "count (1)" : plan.measure.sum})

Then AGGREGATE WITHIN THIS BATCH and return ONLY partial totals as JSON:
{ "<key>": { "count": <n>, "sum": <total> }, ... }

Do not return individual rows. Do not explain. JSON only.

Example output (if grouping by toll plaza, summing amounts):
{
  "Whitefield Plaza": { "count": 3, "sum": 450 },
  "Hebbal Plaza": { "count": 2, "sum": 300 }
}

Emails in this batch:
{EMAILS_JSON}

Output JSON only:`;

export const SUMMARIZER_PROMPT = (plan: Plan) => `\
You are the SUMMARIZER. You are given a FINAL, already-computed aggregate table. The numbers
are SETTLED — do NOT recompute, reorder, or alter them.

Write a short, direct answer for the user and confirm the chart type. Reference the real
group names and totals from the table below.

Aggregation task: grouped by "${plan.reduce_key}", measured as ${typeof plan.measure === "string" ? "count" : plan.measure.sum}.

Final aggregated data:
{FINAL_TABLE_JSON}

Output JSON only:
{
  "answer_text": "...",
  "chart_type": "${plan.chart_type}"
}

Be concise. Confirm what was counted/summed and any interesting patterns (e.g. which group is
largest). Do not speculate or add new information. Output JSON only:`;
