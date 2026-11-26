import { URL } from "node:url";

export const AGI_API_PATH = "/api/agi";
const MAX_BODY_BYTES = 64 * 1024;

function jsonFetchResponse(status, payload) {
  return Response.json(payload, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function isLoopbackHostHeader(hostHeader) {
  if (!hostHeader) return true;
  const host = String(hostHeader).split(":")[0].trim().toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function isLoopbackOrigin(originHeader) {
  if (!originHeader) return true;
  try {
    const parsed = new URL(originHeader);
    return (
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "::1" ||
      parsed.hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

export async function handleAgiFetchRequest(request, guiService) {
  const method = String(request.method || "GET").toUpperCase();
  if (method === "GET") {
    try {
      const parsedUrl = new URL(request.url || AGI_API_PATH, "http://127.0.0.1");
      const probe = parsedUrl.searchParams.get("probe") === "1";
      const state = await guiService.getState({ probe });
      return jsonFetchResponse(200, state);
    } catch (err) {
      return jsonFetchResponse(err?.statusCode || 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (method !== "POST") {
    return jsonFetchResponse(405, { ok: false, error: `Method not allowed: ${method}` });
  }

  const declared = Number(request.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return jsonFetchResponse(413, { ok: false, error: "Request body too large" });
  }

  let body;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
      return jsonFetchResponse(413, { ok: false, error: "Request body too large" });
    }
    body = text.trim() ? JSON.parse(text) : {};
  } catch {
    return jsonFetchResponse(400, { ok: false, error: "Request body must be valid JSON" });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonFetchResponse(400, { ok: false, error: "Request body must be a JSON object" });
  }

  try {
    const result = await guiService.handleAction(body.action, body);
    return jsonFetchResponse(200, result);
  } catch (err) {
    const status =
      typeof err?.statusCode === "number"
        ? err.statusCode
        : /invalid|required|does not exist|already|refusing/i.test(String(err?.message || ""))
          ? 400
          : 500;
    return jsonFetchResponse(status, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function readNodeRequestText(req, limitBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        const err = new Error("Request body too large");
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function registerDshGuiRoutes(ctx, guiService) {
  if (!ctx || typeof ctx.inject !== "function") {
    return () => {};
  }

  let registered = false;
  const disposers = [];

  try {
    ctx.inject(["connection"], (host) => {
      const reg = host?.connection?.fetch?.register;
      if (typeof reg !== "function") return;
      registered = true;
      const dispose = reg({
        path: AGI_API_PATH,
        methods: ["GET", "POST"],
        requestBody: "buffered",
        fetch: (request) => handleAgiFetchRequest(request, guiService),
      });
      if (typeof dispose === "function") {
        disposers.push(dispose);
      }
    });
  } catch {
    // connection service may be absent in older hosts or tests
  }

  if (!registered) {
    try {
      ctx.inject(["webServer"], (host) => {
        if (registered) return;
        const reg = host?.webServer?.register;
        if (typeof reg !== "function") return;
        registered = true;
        const dispose = reg(AGI_API_PATH, async (req, res) => {
          if (!isLoopbackHostHeader(req.headers?.host) || !isLoopbackOrigin(req.headers?.origin)) {
            res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ ok: false, error: "Forbidden non-loopback origin" }));
            return;
          }
          try {
            const method = String(req.method || "GET").toUpperCase();
            const text = method === "POST" ? await readNodeRequestText(req) : "";
            const fakeReq = {
              method,
              url: req.url || AGI_API_PATH,
              headers: {
                get: (k) => req.headers?.[String(k).toLowerCase()] ?? null,
              },
              text: async () => text,
            };
            const fetchRes = await handleAgiFetchRequest(fakeReq, guiService);
            const outText = await fetchRes.text();
            res.writeHead(fetchRes.status, {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
            });
            res.end(outText);
          } catch (err) {
            res.writeHead(err?.statusCode || 500, {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
            });
            res.end(JSON.stringify({ ok: false, error: err?.message || "Internal error" }));
          }
        });
        if (typeof dispose === "function") {
          disposers.push(dispose);
        }
      });
    } catch {
      // webServer service may be absent
    }
  }

  return () => {
    while (disposers.length > 0) {
      const fn = disposers.pop();
      try {
        fn();
      } catch {
        // ignore
      }
    }
  };
}
