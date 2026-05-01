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
    const zlib = require("zlib");

    const doGet = (urlStr) => new Promise((resolve) => {
      const url = new URL(urlStr);
      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "GET",
        headers: { "accept": "application/json", "user-agent": "Mozilla/5.0" },
      };
      const req = https.request(options, (res) => {
        // Follow redirects (301, 302, 307, 308)
        if ([301,302,307,308].includes(res.statusCode) && res.headers.location) {
          resolve(doGet(res.headers.location));
          return;
        }
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => {
          try {
            const buf = Buffer.concat(chunks);
            const enc = (res.headers["content-encoding"] || "").toLowerCase();
            let raw;
            if (enc === "gzip")    raw = zlib.gunzipSync(buf).toString("utf8");
            else if (enc === "br") raw = zlib.brotliDecompressSync(buf).toString("utf8");
            else                   raw = buf.toString("utf8");

            const parsed = JSON.parse(raw);
            const arr = Array.isArray(parsed) ? parsed
              : Array.isArray(parsed.data) ? parsed.data
              : Array.isArray(parsed.transactions) ? parsed.transactions
              : Object.values(parsed).find(v => Array.isArray(v)) || [];

            const sorted = arr
              .filter(t => {
                const tk = (t.ticker||"").trim().toUpperCase();
                return tk && tk !== "--" && /^[A-Z]{1,5}$/.test(tk);
              })
              .sort((a,b) => new Date(b.transaction_date||b.disclosure_date||0) - new Date(a.transaction_date||a.disclosure_date||0))
              .slice(0, 1500);

            resolve({ statusCode: 200, headers, body: JSON.stringify(sorted) });
          } catch(e) {
            const buf = Buffer.concat(chunks);
            resolve({ statusCode: 500, headers, body: JSON.stringify({
              error: `Parse error: ${e.message} | HTTP ${res.statusCode} | encoding: ${res.headers["content-encoding"]||"none"} | first 200 chars: ${buf.slice(0,200).toString("utf8")}`
            })});
          }
        });
      });
      req.on("error", err => resolve({ statusCode: 500, headers, body: JSON.stringify({ error: `Request error: ${err.message}` }) }));
      req.setTimeout(30000, () => { req.destroy(); resolve({ statusCode: 504, headers, body: JSON.stringify({ error: "Timed out" }) }); });
      req.end();
    });

    return doGet(proxyUrl);
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
