const https = require("https");

exports.handler = async (event) => {
  const headers = {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-api-key",
  };

  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: { message: "Method not allowed" } }) };
  }

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
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        // Make sure we always return valid JSON
        try {
          JSON.parse(data); // Validate it's JSON
          resolve({
            statusCode: res.statusCode,
            headers,
            body: data,
          });
        } catch {
          resolve({
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: { message: "Invalid response from Anthropic: " + data.slice(0, 200) } }),
          });
        }
      });
    });

    req.on("error", (err) => {
      resolve({
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: { message: "Request failed: " + err.message } }),
      });
    });

    req.setTimeout(55000, () => {
      req.destroy();
      resolve({
        statusCode: 504,
        headers,
        body: JSON.stringify({ error: { message: "Request timed out" } }),
      });
    });

    req.write(bodyData);
    req.end();
  });
};
