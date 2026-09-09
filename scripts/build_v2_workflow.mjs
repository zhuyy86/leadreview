import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeIntake, scoreLead } from "../logic/lead_logic.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, "workflow", "AI Lead Qualification & Appointment Agent - V1 Foundation.json");
const target = path.join(root, "workflow", "LeadReview - V2 Human Review.json");
const workflow = JSON.parse(fs.readFileSync(source, "utf8"));
workflow.name = "LeadReview - V2 Multi-Source & Human Review";

const normalize = workflow.nodes.find((node) => node.name === "Normalize Lead Data");
normalize.type = "n8n-nodes-base.code";
normalize.typeVersion = 2;
normalize.parameters = { jsCode:
  normalizeIntake.toString() + "\nreturn items.map((item) => ({ json: { ...item.json, ..." +
  "normalizeIntake(item.json.body || item.json) } }));" };

const score = workflow.nodes.find((node) => node.name === "Score & Qualify Lead");
score.parameters.jsCode = scoreLead.toString() +
  "\nreturn [{ json: { ...scoreLead($json.output || {}), lead_source: " +
  "$('Normalize Lead Data').item.json.lead_source, received_at: $now.toISO(), " +
  "workflow_version: '2.0' } }];";

const output = workflow.nodes.find((node) => node.name === "Build Final Structured Output");
output.parameters.assignments.assignments.push(
  { id: "routing-obj", name: "routing", type: "object",
    value: "={{ { proposed_action: $json.proposed_action, next_action: $json.next_action, human_approval_required: $json.human_approval_required } }}" },
  { id: "score-reasons", name: "score_reasons", type: "array",
    value: "={{ $json.score_reasons }}" },
  { id: "audit-obj", name: "audit", type: "object",
    value: "={{ { lead_source: $json.lead_source, received_at: $json.received_at, workflow_version: $json.workflow_version, execution_id: $execution.id } }}" }
);
const oldNext = output.parameters.assignments.assignments.find((x) => x.id === "next-action");
oldNext.value = "={{ $json.next_action }}";
workflow.meta = { ...(workflow.meta || {}), upstream_commit:
  "ca3dc13f6b9681e7ae3d920a6ed776ab5165f2c8", extension: "LeadReview V2" };
fs.writeFileSync(target, JSON.stringify(workflow, null, 2) + "\n");
console.log(target);
