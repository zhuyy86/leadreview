const SOURCES = new Set(["website", "form", "gmail", "api"]);
const URGENCY = new Set(["high", "medium", "low", "unknown"]);
const INTENT = new Set(["emergency", "ready_to_buy", "comparison", "research", "unknown"]);
const PROPERTY = new Set(["residential", "commercial", "unknown"]);

export function normalizeIntake(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Request body must be an object.");
  }
  const source = String(payload.lead_source || "website").toLowerCase().trim();
  if (!SOURCES.has(source)) throw new Error("Unsupported lead_source.");
  let message = payload.message;
  if (source === "gmail") {
    const subject = typeof payload.subject === "string" ? payload.subject.trim() : "";
    const text = typeof payload.textPlain === "string" ? payload.textPlain.trim() : "";
    message = [subject, text].filter(Boolean).join("\n");
  } else if (source === "form" && typeof message !== "string") {
    message = ["Service: " + (payload.service || ""), "Details: " + (payload.details || ""),
               "Name: " + (payload.name || ""), "Email: " + (payload.email || "")]
      .filter((line) => !line.endsWith(": ")).join("\n");
  }
  if (typeof message !== "string") throw new Error("A text message is required.");
  message = message.trim();
  if (message.length < 5 || message.length > 2000) {
    throw new Error("Message must contain 5 to 2000 characters.");
  }
  return { lead_message: message, lead_source: source };
}

export function scoreLead(extracted) {
  const value = extracted && typeof extracted === "object" && !Array.isArray(extracted)
    ? extracted : {};
  const clean = (name) => typeof value[name] === "string" && value[name].trim()
    ? value[name].trim() : null;
  const urgency = URGENCY.has((clean("urgency") || "").toLowerCase())
    ? clean("urgency").toLowerCase() : "unknown";
  const intent = INTENT.has((clean("intent") || "").toLowerCase())
    ? clean("intent").toLowerCase() : "unknown";
  const propertyType = PROPERTY.has((clean("property_type") || "").toLowerCase())
    ? clean("property_type").toLowerCase() : "unknown";
  const result = {
    name: clean("name"), email: clean("email"), phone: clean("phone"),
    location: clean("location"), service: clean("service"), urgency,
    property_type: propertyType, budget: clean("budget"), intent
  };
  if (result.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) result.email = null;
  const reasons = [];
  const add = (points, reason) => { reasons.push({ points, reason }); return points; };
  let score = 0;
  score += urgency === "high" ? add(30, "high urgency")
    : urgency === "medium" ? add(15, "medium urgency")
    : urgency === "low" ? add(5, "low urgency") : 0;
  score += intent === "emergency" ? add(35, "emergency intent")
    : intent === "ready_to_buy" ? add(30, "ready to buy")
    : intent === "comparison" ? add(15, "comparison intent")
    : intent === "research" ? add(5, "research intent") : 0;
  if (result.budget) score += add(15, "budget provided");
  if (result.email || result.phone) score += add(10, "contact method provided");
  if (result.location) score += add(5, "location provided");
  if (result.service) score += add(5, "service identified");
  score = Math.max(0, Math.min(100, score));
  const status = score >= 70 ? "qualified" : score >= 40 ? "needs_review" : "unqualified";
  const proposed = status === "qualified" ? "book_appointment"
    : status === "needs_review" ? "human_review" : "nurture_followup";
  return { ...result, qualification_status: status, qualification_score: score,
    score_reasons: reasons, proposed_action: proposed,
    human_approval_required: status !== "unqualified",
    next_action: status !== "unqualified" ? "await_human_approval" : proposed };
}
