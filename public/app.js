const $ = (id) => document.getElementById(id);

const state = {
  file: null,
  sceneFacts: "",
  director: null,
  busy: false
};

function showError(message = "") {
  const box = $("errorBox");
  if (!message) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  box.textContent = message;
  box.hidden = false;
}

function setBusy(busy) {
  state.busy = busy;
  $("send").disabled = busy;
  $("fileInput").disabled = busy;
}

async function optimizeImage(file) {
  const bitmap = await createImageBitmap(file);
  const maxEdge = 1024;
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
  if (!blob) throw new Error("Could not optimize image.");
  return new File([blob], "reference.jpg", { type: "image/jpeg" });
}

async function analyzeReference(file) {
  showError("");
  setBusy(true);
  $("visionStatus").textContent = "Analyzing reference…";

  try {
    const optimized = await optimizeImage(file);
    const form = new FormData();
    form.append("image", optimized);

    const response = await fetch("/api/vision", { method: "POST", body: form });
    const payload = await response.json();

    if (!response.ok) throw new Error(payload.error || `Vision HTTP ${response.status}`);

    state.sceneFacts = payload.report;
    $("sceneFacts").textContent = payload.report;
    $("visionStatus").textContent = "Reference analyzed";
  } catch (error) {
    state.sceneFacts = "";
    $("visionStatus").textContent = "Vision failed";
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
}

$("fileInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  state.file = file;
  const url = URL.createObjectURL(file);
  $("preview").src = url;
  $("preview").hidden = false;
  $("emptyState").hidden = true;

  await analyzeReference(file);
});

$("prompt").addEventListener("input", (event) => {
  event.target.style.height = "auto";
  event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`;
});

$("send").addEventListener("click", async () => {
  const userRequest = $("prompt").value.trim();
  if (!userRequest) {
    showError("Describe what should happen first.");
    return;
  }

  const sceneFacts = state.sceneFacts ||
    "No reference image was provided. Build the scene only from the user's written request.";

  showError("");
  setBusy(true);
  $("directorStatus").textContent = "Directing…";

  try {
    const response = await fetch("/api/director", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sceneFacts, userRequest })
    });

    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Director HTTP ${response.status}`);

    state.director = payload;
    $("inferredGoal").textContent = payload.inferred_goal || "—";
    $("storyBeats").textContent = JSON.stringify(payload.story_beats || [], null, 2);
    $("shotList").textContent = JSON.stringify(payload.shot_list || [], null, 2);
    $("finalPrompt").textContent = payload.final_prompt || "—";
    $("hash").textContent = payload.sha256 || "—";
    $("directorStatus").textContent = "Script ready";
    $("debugPanel").open = true;
  } catch (error) {
    $("directorStatus").textContent = "Director failed";
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
});
