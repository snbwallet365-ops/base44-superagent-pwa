export type Evaluation = { passed: boolean; answer: string; critique: string[]; source: "local" | "webhook" };

type EvaluationInput = { task: string; draft: string; succeeded: boolean };

export async function evaluateAndRefine({ task, draft, succeeded }: EvaluationInput): Promise<Evaluation> {
  const critique: string[] = [];
  const cleanDraft = draft.trim().replace(/\n{3,}/g, "\n\n");
  if (!succeeded) {
    return { passed: false, answer: cleanDraft || "The automation did not report a successful result. Review the saved trace and retry.", critique: ["Execution success flag was false."], source: "local" };
  }
  if (!cleanDraft) {
    return { passed: true, answer: "The task completed, but the agent returned no written summary. Review the execution trace for its actions.", critique: ["Execution succeeded; result text was empty."], source: "local" };
  }
  critique.push("Execution reported success.", "Final answer is non-empty and normalized.");

  const endpoint = process.env.AGENT_EVALUATOR_URL;
  const key = process.env.AGENT_EVALUATOR_API_KEY;
  if (!endpoint || !key) return { passed: true, answer: cleanDraft, critique, source: "local" };

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        task,
        draft_answer: cleanDraft,
        rubric: ["Do not claim actions that the execution result does not support.", "Keep the final answer concise, specific, and honest about uncertainty.", "Preserve concrete findings and next steps."],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(`Evaluator returned ${response.status}.`);
    const refined = typeof payload.refined_answer === "string" ? payload.refined_answer.trim() : cleanDraft;
    if (!refined) throw new Error("Evaluator returned an empty answer.");
    const passed = payload.approved !== false;
    critique.push(typeof payload.critique === "string" ? payload.critique.slice(0, 1000) : "Optional evaluator reviewed the draft.");
    return {
      passed,
      answer: passed ? refined : `The task ran, but its result did not pass the quality check. ${refined}`,
      critique,
      source: "webhook",
    };
  } catch {
    critique.push("Optional evaluator was unavailable; deterministic checks were used.");
    return { passed: true, answer: cleanDraft, critique, source: "local" };
  }
}
