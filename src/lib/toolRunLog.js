import { apiUrl, authHeaders } from "./api.js";

// Local skills (calculator, weather, reminders, etc.) resolve entirely in the
// browser and never otherwise touch the backend, so this is the only path that
// gets them into tool_runs. Fire-and-forget: a logging failure must never affect
// the skill reply already shown to the user.
export function logToolRun(toolName, input, status = "succeeded") {
  logToolRunAsync(toolName, input, status).catch((err) => {
    console.warn("[heney] tool_run log failed:", err.message);
  });
}

async function logToolRunAsync(toolName, input, status) {
  const headers = await authHeaders();
  if (!headers.Authorization) return;

  await fetch(apiUrl("/api/tool-run"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ toolName, input, status }),
  });
}
