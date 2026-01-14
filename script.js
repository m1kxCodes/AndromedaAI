const glow = document.querySelector(".glow-orbit");
const chatForm = document.querySelector("#chatForm");
const userInput = document.querySelector("#userInput");
const messageLog = document.querySelector("#messageLog");
const connectionStatus = document.querySelector("#connectionStatus");
const statusDot = document.querySelector(".status-dot");
const clearMemoryButton = document.querySelector("#clearMemory");
const regenerateButton = document.querySelector("#regenerate");
const copyLastButton = document.querySelector("#copyLast");
const modelName = document.querySelector("#modelName");
const modelSelect = document.querySelector("#modelSelect");
const temperatureInput = document.querySelector("#temperature");
const temperatureValue = document.querySelector("#temperatureValue");
const toolsToggle = document.querySelector("#toolsToggle");
const toolsStatus = document.querySelector("#toolsStatus");

const sessionId = crypto.randomUUID();
let isStreaming = false;
let lastPrompt = "";
let lastAssistantText = "";

const setStatus = (label, online) => {
  if (connectionStatus) {
    connectionStatus.textContent = label;
  }
  if (statusDot) {
    statusDot.classList.toggle("online", online);
  }
};

const appendMessage = (role, text) => {
  if (!messageLog) {
    return null;
  }
  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;

  const roleEl = document.createElement("p");
  roleEl.className = "message-role";
  roleEl.textContent = role;

  const textEl = document.createElement("p");
  textEl.className = "message-text";
  textEl.textContent = text;

  wrapper.append(roleEl, textEl);
  messageLog.appendChild(wrapper);
  messageLog.scrollTop = messageLog.scrollHeight;
  return textEl;
};

const streamResponse = async (prompt) => {
  const selectedModel = modelSelect ? modelSelect.value : undefined;
  const temperature = temperatureInput ? Number(temperatureInput.value) : undefined;
  const toolsEnabled = toolsToggle ? toolsToggle.checked : true;
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      message: prompt,
      model: selectedModel,
      temperature,
      toolsEnabled,
    }),
  });

  if (!response.ok || !response.body) {
    throw new Error("Failed to stream response.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let assistantText = "";
  const assistantEl = appendMessage("assistant", "");
  lastAssistantText = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) {
        continue;
      }
      const payload = line.replace("data:", "").trim();
      if (!payload) {
        continue;
      }
      if (payload === "[DONE]") {
        return;
      }
      const parsed = JSON.parse(payload);
      if (parsed.delta) {
        assistantText += parsed.delta;
        lastAssistantText = assistantText;
        if (assistantEl) {
          assistantEl.textContent = assistantText;
        }
        messageLog.scrollTop = messageLog.scrollHeight;
      }
      if (parsed.model && modelName) {
        modelName.textContent = parsed.model;
      }
    }
  }
};

const sendMessage = async (event) => {
  event.preventDefault();
  if (!userInput || isStreaming) {
    return;
  }
  const prompt = userInput.value.trim();
  if (!prompt) {
    return;
  }
  userInput.value = "";
  appendMessage("user", prompt);
  lastPrompt = prompt;
  isStreaming = true;
  setStatus("Streaming", true);

  try {
    await streamResponse(prompt);
    setStatus("Online", true);
  } catch (error) {
    appendMessage("system", "Transmission failed. Check the API connection.");
    setStatus("Error", false);
  } finally {
    isStreaming = false;
  }
};

const clearMemory = async () => {
  setStatus("Resetting", false);
  await fetch("/api/memory/clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  if (messageLog) {
    messageLog.innerHTML = "";
  }
  appendMessage(
    "system",
    "Memory cleared. Ready for new mission parameters."
  );
  lastPrompt = "";
  lastAssistantText = "";
  setStatus("Standby", false);
};

const regenerateLast = async () => {
  if (!lastPrompt || isStreaming) {
    return;
  }
  appendMessage("user", lastPrompt);
  isStreaming = true;
  setStatus("Streaming", true);
  try {
    await streamResponse(lastPrompt);
    setStatus("Online", true);
  } catch (error) {
    appendMessage("system", "Transmission failed. Check the API connection.");
    setStatus("Error", false);
  } finally {
    isStreaming = false;
  }
};

const copyLastReply = async () => {
  if (!lastAssistantText) {
    return;
  }
  try {
    await navigator.clipboard.writeText(lastAssistantText);
    setStatus("Copied", true);
    setTimeout(() => setStatus("Standby", false), 1200);
  } catch (error) {
    appendMessage("system", "Copy failed. Select the response manually.");
  }
};

const updateTemperatureLabel = () => {
  if (temperatureInput && temperatureValue) {
    temperatureValue.textContent = temperatureInput.value;
  }
};

const updateToolsStatus = () => {
  if (toolsStatus && toolsToggle) {
    toolsStatus.textContent = toolsToggle.checked ? "enabled" : "disabled";
  }
};

if (chatForm) {
  chatForm.addEventListener("submit", sendMessage);
}

if (clearMemoryButton) {
  clearMemoryButton.addEventListener("click", clearMemory);
}

if (regenerateButton) {
  regenerateButton.addEventListener("click", regenerateLast);
}

if (copyLastButton) {
  copyLastButton.addEventListener("click", copyLastReply);
}

if (temperatureInput) {
  temperatureInput.addEventListener("input", updateTemperatureLabel);
  updateTemperatureLabel();
}

if (toolsToggle) {
  toolsToggle.addEventListener("change", updateToolsStatus);
  updateToolsStatus();
}

if (modelSelect && modelName) {
  modelSelect.addEventListener("change", () => {
    modelName.textContent = modelSelect.value;
  });
}

if (glow) {
  window.addEventListener("mousemove", (event) => {
    const x = (event.clientX / window.innerWidth - 0.5) * 20;
    const y = (event.clientY / window.innerHeight - 0.5) * 20;
    glow.style.transform = `translate(${x}px, ${y}px)`;
  });
}
