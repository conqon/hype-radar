const https = require("https");

module.exports = async function(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-api-key, x-proxy-url");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const proxyUrl = req.headers["x-proxy-url"];

  // Congress S3 proxy
  if (proxyUrl) {
    const zlib = require("zlib");
    const result = await new Promise((resolve) => {
      const doGet = (urlStr) => {
        const url = new URL(urlStr);
        const request = https.request(
          { hostname: url.hostname, path: url.pathname + url.search, method: "GET", headers: { "accept": "application/json", "user-agent": "Mozilla/5.0" } },
          (response) => {
            if ([301,302,307,308].includes(response.statusCode) && response.headers.location) {
              return doGet(response.headers.location);
            }
            const chunks = [];
            response.on("data", c => chunks.push(c));
            response.on("end", () => {
              try {
                const buf = Buffer.concat(chunks);
                const enc = (response.headers["content-encoding"] || "").toLowerCase();
                const raw = enc === "gzip" ? zlib.gunzipSync(buf).toString("utf8")
                          : enc === "br"   ? zlib.brotliDecompressSync(buf).toString("utf8")
                          : buf.toString("utf8");
                const parsed = JSON.parse(raw);
                const raw_arr = Array.isArray(parsed) ? parsed
                  : Array.isArray(parsed.data) ? parsed.data
                  : Object.values(parsed).find(v => Array.isArray(v)) || [];

                // Handle nested Senate format: [{senator, transactions:[{ticker,...}]}]
                // vs flat format: [{ticker, senator, ...}]
                let flat = [];
                if (raw_arr.length && Array.isArray(raw_arr[0].transactions)) {
                  // Nested — flatten filings into individual trades
                  raw_arr.forEach(f => {
                    const name = f.senator || [f.first_name, f.last_name].filter(Boolean).join(" ") || "Unknown";
                    (f.transactions || []).forEach(tx => {
                      flat.push(Object.assign({}, tx, {
                        senator: name,
                        name: name,
                        disclosure_date: f.date_recieved || f.disclosure_date || "",
                      }));
                    });
                  });
                } else {
                  // Already flat
                  flat = raw_arr;
                }

                const sorted = flat
                  .filter(t => { const tk=(t.ticker||"").trim().toUpperCase(); return tk&&tk!=="--"&&/^[A-Z]{1,5}$/.test(tk); })
                  .sort((a,b) => new Date(b.transaction_date||b.disclosure_date||0)-new Date(a.transaction_date||a.disclosure_date||0))
                  .slice(0,1500);
                resolve({ ok:true, data:sorted });
              } catch(e) { resolve({ ok:false, error:"Parse error: "+e.message }); }
            });
          }
        );
        request.on("error", e => resolve({ ok:false, error:e.message }));
        request.setTimeout(25000, () => { request.destroy(); resolve({ ok:false, error:"Timed out" }); });
        request.end();
      };
      doGet(proxyUrl);
    });
    if (!result.ok) return res.status(500).json({ error: result.error });
    return res.status(200).json(result.data);
  }

  // Anthropic proxy — key comes from server environment variable, never from the client
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: "API key not configured on server." } });

  const bodyData = JSON.stringify(req.body);
  await new Promise((resolve) => {
    const request = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(bodyData),
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
      },
      (response) => {
        let data = "";
        response.on("data", c => { data += c; });
        response.on("end", () => {
          try { res.status(response.statusCode).json(JSON.parse(data)); }
          catch(e) { res.status(500).json({ error: { message: "Invalid Anthropic response" } }); }
          resolve();
        });
      }
    );
    request.on("error", e => { res.status(500).json({ error: { message: e.message } }); resolve(); });
    request.setTimeout(55000, () => { request.destroy(); res.status(504).json({ error: { message: "Timed out" } }); resolve(); });
    request.write(bodyData);
    request.end();
  });
};
