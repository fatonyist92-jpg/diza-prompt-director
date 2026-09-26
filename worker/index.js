const VISION_MODEL = "dots-studio/dots-3-note-preview:free";
const DIRECTOR_MODEL = "community/AkshayCoder48/L3-70B-Euryale-v2.1";

const VISION_INSTRUCTION = [
  "You are a factual visual observer for a downstream video director.",
  "Describe only what is visibly present in the reference image.",
  "Do not write a story. Do not suggest future actions. Do not infer hidden details.",
  "Use exactly these headings:",
  "SUBJECTS: number of visible people and each person's visible appearance, hairstyle, and clothing.",
  "POSE: pose, body orientation, visible hand/leg position, and facial expression.",
  "RELATIONS: relative position of visible people.",
  "SCENE: visible location, background, props, and objects.",
  "LIGHTING: visible lighting, time-of-day cues, and weather if visible.",
  "CAMERA: framing and approximate viewpoint.",
  "UNCERTAIN: only genuinely occluded or uncertain details.",
  "Keep the report compact."
].join("\n");

const DIRECTOR_INSTRUCTION = `
You are DIZA Director Brain, a visual screenwriter and video director.

Inputs:
1. SCENE_FACTS is a factual observation of the reference image and is the locked starting state.
2. USER_REQUEST is the user's desired scene.

Your job is to understand the requested scene, infer useful missing transitions, and produce a coherent visual script for a video renderer.

Rules:
- Preserve the factual starting state unless USER_REQUEST explicitly changes it.
- Build a natural start-to-finish sequence instead of merely paraphrasing the user.
- Translate short instructions into concrete visual story beats.
- When multiple camera angles are requested, create genuinely distinct shots.
- Track body state, clothing state, props, environment, and spatial continuity across shots.
- Infer body mechanics, secondary motion, timing, and transitions only when useful.
- Do not add unrelated characters, location changes, wardrobe, props, dialogue, or events.
- final_prompt is canonical. The orchestration layer passes it through unchanged.

Return JSON only, exactly in this structure:
{
  "scene_facts": "string",
  "user_intent": "string",
  "inferred_goal": "string",
  "story_beats": ["string"],
  "shot_list": [
    {
      "index": 1,
      "framing": "string",
      "camera_position": "string",
      "camera_motion": "string",
      "action": "string",
      "continuity_state": "string"
    }
  ],
  "motion_plan": {
    "primary_action": "string",
    "body_mechanics": ["string"],
    "secondary_motion": ["string"],
    "tempo": "string",
    "intensity": "string"
  },
  "continuity": {
    "identity": ["string"],
    "wardrobe": ["string"],
    "props": ["string"],
    "environment": ["string"],
    "spatial_state": ["string"]
  },
  "final_prompt": "one complete renderer-ready prompt"
}
`.trim();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function extractChatText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => typeof item === "string" ? item : item?.text || "")
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

function parseDirectorJson(raw) {
  const cleaned = raw
    .trim()
    .replace(/^\`\`\`(?:json)?\s*/i, "")
    .replace(/\s*\`\`\`$/i, "");

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("Director returned invalid JSON.");

  const parsed = JSON.parse(cleaned.slice(first, last + 1));
  if (!parsed || typeof parsed !== "object") throw new Error("Director package is not an object.");
  if (typeof parsed.final_prompt !== "string" || !parsed.final_prompt.trim()) {
    throw new Error("Director package has no final_prompt.");
  }
  return parsed;
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function fetchWithRetry(url, init, retries = 3) {
  let response;
  for (let attempt = 0; attempt < retries; attempt++) {
    response = await fetch(url, init);
    if (![429, 502, 503, 504].includes(response.status) || attempt === retries - 1) {
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, 600 * (2 ** attempt)));
  }
  return response;
}

async function handleVision(request, env) {
  if (!env.OPENROUTER_API_KEY) {
    return json({ error: "OPENROUTER_API_KEY is not configured." }, 503);
  }

  const form = await request.formData();
  const image = form.get("image");

  if (!(image instanceof File)) return json({ error: "Image is required." }, 400);
  if (!image.type.startsWith("image/")) return json({ error: "File must be an image." }, 400);
  if (image.size > 5 * 1024 * 1024) return json({ error: "Image must be 5 MB or smaller." }, 413);

  const bytes = new Uint8Array(await image.arrayBuffer());
  const dataUrl = `data:${image.type};base64,${bytesToBase64(bytes)}`;

  const response = await fetchWithRetry(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "content-type": "application/json",
        "http-referer": new URL(request.url).origin,
        "x-title": "DIZA Prompt Director"
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          { role: "system", content: VISION_INSTRUCTION },
          {
            role: "user",
            content: [
              { type: "text", text: "Return the factual scene report for this reference image." },
              { type: "image_url", image_url: { url: dataUrl } }
            ]
          }
        ],
        temperature: 0,
        max_tokens: 1200
      })
    },
    3
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    return json(
      { error: payload?.error?.message || payload?.message || `Vision provider HTTP ${response.status}` },
      response.status
    );
  }

  const report = extractChatText(payload);
  if (!report) return json({ error: "Vision returned an empty response." }, 502);

  return json({ report, engine: payload?.model || VISION_MODEL });
}

async function handleDirector(request, env) {
  if (!env.POLLINATIONS_API_KEY) {
    return json({ error: "POLLINATIONS_API_KEY is not configured." }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const sceneFacts = typeof body?.sceneFacts === "string" ? body.sceneFacts.trim() : "";
  const userRequest = typeof body?.userRequest === "string" ? body.userRequest.trim() : "";

  if (!sceneFacts) return json({ error: "sceneFacts is required." }, 400);
  if (!userRequest) return json({ error: "userRequest is required." }, 400);

  const response = await fetchWithRetry(
    "https://gen.pollinations.ai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.POLLINATIONS_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: DIRECTOR_MODEL,
        messages: [
          { role: "system", content: DIRECTOR_INSTRUCTION },
          {
            role: "user",
            content:
              `SCENE_FACTS:\n${sceneFacts}\n\n` +
              `USER_REQUEST:\n${userRequest}\n\n` +
              "Return the director package as JSON only."
          }
        ],
        max_tokens: 6000,
        temperature: 0.35
      })
    },
    4
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    return json(
      { error: payload?.error?.message || payload?.message || `Director provider HTTP ${response.status}` },
      response.status
    );
  }

  const raw = extractChatText(payload);
  if (!raw) return json({ error: "Director returned an empty response." }, 502);

  let directorPackage;
  try {
    directorPackage = parseDirectorJson(raw);
  } catch (error) {
    return json({
      error: error instanceof Error ? error.message : "Director JSON parse failed.",
      raw_preview: raw.slice(0, 800)
    }, 502);
  }

  const integrityHash = await sha256(directorPackage.final_prompt);

  return json({
    ...directorPackage,
    engine: payload?.model || DIRECTOR_MODEL,
    sha256: integrityHash,
    immutable: true,
    rewrite_allowed: false
  });
}

async function handleApi(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/api/health" && request.method === "GET") {
    return json({
      ok: true,
      vision_model: VISION_MODEL,
      director_model: DIRECTOR_MODEL,
      openrouter_configured: Boolean(env.OPENROUTER_API_KEY),
      pollinations_configured: Boolean(env.POLLINATIONS_API_KEY),
      silent_fallback: false
    });
  }

  if (url.pathname === "/api/vision" && request.method === "POST") {
    return handleVision(request, env);
  }

  if (url.pathname === "/api/director" && request.method === "POST") {
    return handleDirector(request, env);
  }

  return json({ error: "API route not found." }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env);
      } catch (error) {
        console.error(error);
        return json({
          error: error instanceof Error ? error.message : "Internal server error."
        }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  }
};
