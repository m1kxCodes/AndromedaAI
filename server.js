const express = require("express");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENAI_API_KEY;
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const SYSTEM_PROMPT = [
  "You are Andromeda, a space-themed concept AI.",
  "Speak with cinematic clarity, be concise, and offer actionable insights.",
  "Use tools when useful. If a tool is called, explain the result briefly.",
].join(" ");

const tools = [
  {
    type: "function",
    function: {
      name: "get_server_time",
      description: "Return the current server time in ISO format.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_random_constellation",
      description: "Return a random constellation name with a short description.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "plan_mission",
      description: "Generate a mission outline from a goal.",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string" },
        },
        required: ["goal"],
        additionalProperties: false,
      },
    },
  },
];

const constellations = [
  "Orion: Hunter figure with bright belt stars.",
  "Lyra: Harp-shaped constellation anchored by Vega.",
  "Cygnus: Swan gliding through the Milky Way.",
  "Cassiopeia: W-shaped constellation named for a queen.",
  "Scorpius: Scorpion with the red star Antares.",
];

const sessions = new Map();

const getSession = (sessionId) => {
  if (!sessionId) {
    return { id: null, messages: [] };
  }
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { id: sessionId, messages: [] });
  }
  return sessions.get(sessionId);
};

const buildMessages = (sessionMessages) => {
  return [{ role: "system", content: SYSTEM_PROMPT }, ...sessionMessages];
};

const runTool = (name, args) => {
  switch (name) {
    case "get_server_time":
      return new Date().toISOString();
    case "get_random_constellation": {
      const choice =
        constellations[Math.floor(Math.random() * constellations.length)];
      return choice;
    }
    case "plan_mission":
      return `Mission outline for "${args.goal}":\n1. Define objectives.\n2. Assemble sensors.\n3. Run calibration.\n4. Execute observation.\n5. Synthesize insights.`;
    default:
      return `Tool "${name}" not available.`;
  }
};

const callOpenAI = async ({ messages, model, stream, toolChoice }) => {
  if (!API_KEY) {
    throw new Error("Missing OPENAI_API_KEY.");
  }

  const payload = {
    model,
    messages,
    temperature: 0.6,
    stream,
  };

  if (toolChoice !== "none") {
    payload.tools = tools;
    payload.tool_choice = toolChoice || "auto";
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "OpenAI API request failed.");
  }

  return response;
};

const resolveToolCalls = (message, session) => {
  if (!message.tool_calls) {
    return false;
  }

  session.messages.push({
    role: "assistant",
    content: message.content || "",
    tool_calls: message.tool_calls,
  });

  for (const call of message.tool_calls) {
    const toolName = call.function.name;
    let args = {};
    if (call.function.arguments) {
      try {
        args = JSON.parse(call.function.arguments);
      } catch (error) {
        args = {};
      }
    }
    const result = runTool(toolName, args);
    session.messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: result,
    });
  }

  return true;
};

app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/memory/clear", (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId && sessions.has(sessionId)) {
    sessions.delete(sessionId);
  }
  res.json({ ok: true });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { sessionId, message, model } = req.body || {};
    const session = getSession(sessionId);
    if (message) {
      session.messages.push({ role: "user", content: message });
    }

    let completed = false;
    let resultMessage = null;
    let usedModel = model || DEFAULT_MODEL;

    for (let i = 0; i < 3; i += 1) {
      const response = await callOpenAI({
        messages: buildMessages(session.messages),
        model: usedModel,
        stream: false,
      });
      const data = await response.json();
      const assistantMessage = data.choices[0].message;

      if (resolveToolCalls(assistantMessage, session)) {
        continue;
      }

      session.messages.push({
        role: "assistant",
        content: assistantMessage.content || "",
      });
      resultMessage = assistantMessage.content || "";
      completed = true;
      usedModel = data.model || usedModel;
      break;
    }

    if (!completed) {
      throw new Error("Tool chain did not resolve.");
    }

    res.json({
      sessionId: session.id || sessionId,
      message: resultMessage,
      model: usedModel,
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Server error" });
  }
});

app.post("/api/chat/stream", async (req, res) => {
  const { sessionId, message, model } = req.body || {};
  const session = getSession(sessionId);
  session.messages.push({ role: "user", content: message || "" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    const initialResponse = await callOpenAI({
      messages: buildMessages(session.messages),
      model: model || DEFAULT_MODEL,
      stream: false,
    });
    const initialData = await initialResponse.json();
    const firstMessage = initialData.choices[0].message;
    const resolved = resolveToolCalls(firstMessage, session);

    const streamResponse = await callOpenAI({
      messages: buildMessages(session.messages),
      model: model || DEFAULT_MODEL,
      stream: true,
      toolChoice: resolved ? "none" : "auto",
    });

    const reader = streamResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalText = "";

    res.write(
      `data: ${JSON.stringify({ model: initialData.model || DEFAULT_MODEL })}\n\n`
    );

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }
        const data = trimmed.replace("data:", "").trim();
        if (data === "[DONE]") {
          continue;
        }
        const payload = JSON.parse(data);
        const delta = payload.choices?.[0]?.delta?.content || "";
        if (delta) {
          finalText += delta;
          res.write(`data: ${JSON.stringify({ delta })}\n\n`);
        }
      }
    }

    session.messages.push({ role: "assistant", content: finalText });
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Andromeda server running on http://localhost:${PORT}`);
});
