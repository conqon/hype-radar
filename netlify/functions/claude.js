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
        headers: { "accept": "application/json" },
      };
      const req = https.request(options, (res) => {
        const chunks = [];
        let totalSize = 0;
        const MAX = 5 * 1024 * 1024; // 5MB limit

        res.on("data", chunk => {
          totalSize += chunk.length;
          if (totalSize <= MAX) chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            const raw = Buffer.concat(chunks).toString("utf8");
            // Validate it parses as JSON
            JSON.parse(raw);
            resolve({ statusCode: 200, headers, body: raw });
          } catch(e) {
            resolve({ statusCode: 500, headers, body: JSON.stringify({ error: "Failed to parse response: " + e.message }) });
          }
        });
      });
      req.on("error", err => {
        resolve({ statusCode: 500, headers, body: JSON.stringify({ error: err.message }) });
      });
      req.setTimeout(25000, () => {
        req.destroy();
        resolve({ statusCode: 504, headers, body: JSON.stringify({ error: "Timed out fetching data" }) });
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
