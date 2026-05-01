const https = require("https");

// Proxy any URL passed in the request body, or default to Anthropic API
exports.handler = async (event) => {
  const headers = {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-api-key, x-proxy-url",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // If x-proxy-url header is set, proxy that URL with a GET request (for Congress data)
  const proxyUrl = event.headers["x-proxy-url"];
  if (proxyUrl) {
    return new Promise((resolve) => {
      const url = new URL(proxyUrl);
      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "GET",
        headers: { "accept": "application/json", "accept-encoding": "identity" },
      };
      const req = https.request(options, (res) => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => {
          try {
            const raw = Buffer.concat(chunks).toString("utf8");
            const parsed = JSON.parse(raw);

            // Normalise to array
            const arr = Array.isArray(parsed) ? parsed
              : Array.isArray(parsed.data) ? parsed.data
              : Array.isArray(parsed.transactions) ? parsed.transactions
              : Object.values(parsed).find(v => Array.isArray(v)) || [];

            // Sort newest first, keep only 1500 most recent — keeps response under ~1MB
            const sorted = arr
              .filter(t => t.ticker && t.ticker !== "--" && /^[A-Z]{1,5}$/.test((t.ticker||"").trim()))
              .sort((a,b) => new Date(b.transaction_date||b.disclosure_date||0) - new Date(a.transaction_date||a.disclosure_date||0))
              .slice(0, 1500);

            resolve({ statusCode: 200, headers, body: JSON.stringify(sorted) });
          } catch(e) {
            resolve({ statusCode: 500, headers, body: JSON.stringify({ error: "Parse error: " + e.message }) });
          }
        });
      });
      req.on("error", err => {
        resolve({ statusCode: 500, headers, body: JSON.stringify({ error: err.message }) });
      });
      req.setTimeout(30000, () => {
        req.destroy();
        resolve({ statusCode: 504, headers, body: JSON.stringify({ error: "Timed out fetching Congress data" }) });
      });
      req.end();
    });
  }

  // Otherwise proxy to Anthropic API
  const apiKey = event.headers["x-api-key"];
  if (!apiKey) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: { message: "Missing API key" } }) };
  }
  if (!event.body) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: { message: "Missing request body" } }) };
  }

  return new Promise((resolve) => {
    const bodyData = event.body;
    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(bodyData),
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        try {
          JSON.parse(data);
          resolve({ statusCode: res.statusCode, headers, body: data });
        } catch {
          resolve({ statusCode: 500, headers, body: JSON.stringify({ error: { message: "Invalid response from Anthropic: " + data.slice(0, 200) } }) });
        }
      });
    });
    req.on("error", err => {
      resolve({ statusCode: 500, headers, body: JSON.stringify({ error: { message: "Request failed: " + err.message } }) });
    });
    req.setTimeout(55000, () => {
      req.destroy();
      resolve({ statusCode: 504, headers, body: JSON.stringify({ error: { message: "Request timed out" } }) });
    });
    req.write(bodyData);
    req.end();
  });
};
