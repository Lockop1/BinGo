// API gateway for the local backend harness (stands in for Supabase's Kong).
//
//   /auth/v1/*              -> Supabase Auth (GoTrue), prefix stripped
//   /rest/v1/*              -> PostgREST, prefix stripped, all headers forwarded
//   /storage/v1/*           -> 501 (Storage is not emulated)
//   /realtime/v1/websocket  -> minimal Phoenix stub: joins succeed, no events ever arrive
//   anything else           -> 404
//
// LOCAL DEVELOPMENT ONLY.

import { createHash } from "node:crypto";
import http from "node:http";
import { AUTH_PORT, HOST, POSTGREST_PORT, PROXY_PORT } from "./config.mjs";

const CORS_ALLOW_HEADERS = [
  "authorization",
  "apikey",
  "content-type",
  "prefer",
  "x-client-info",
  "range",
  "content-profile",
  "accept-profile",
  // Sent by supabase-js auth on every request; browsers reject the preflight without it.
  "x-supabase-api-version",
].join(", ");
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD",
  "access-control-expose-headers": "content-range, content-location, x-total-count, x-supabase-api-version",
  "access-control-max-age": "600",
};

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

/** Returns the remainder of `pathname` after `prefix`, or null if it does not match. */
function stripPrefix(pathname, prefix) {
  if (pathname === prefix) return "/";
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  return null;
}

function forward(req, res, { name, port, path }) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(key)) headers[key] = value;
  }
  headers.host = `${HOST}:${port}`;
  headers["x-forwarded-for"] = req.socket.remoteAddress ?? "127.0.0.1";
  headers["x-forwarded-host"] = req.headers.host ?? `${HOST}:${PROXY_PORT}`;
  headers["x-forwarded-proto"] = "http";

  const upstream = http.request(
    { host: HOST, port, method: req.method, path, headers },
    (upRes) => {
      const outHeaders = { ...CORS_HEADERS };
      for (const [key, value] of Object.entries(upRes.headers)) {
        // Upstream CORS headers are replaced by ours (duplicates break browsers).
        if (HOP_BY_HOP.has(key) || key.startsWith("access-control-")) continue;
        outHeaders[key] = value;
      }
      res.writeHead(upRes.statusCode ?? 502, outHeaders);
      upRes.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    if (res.headersSent) {
      res.destroy(err);
      return;
    }
    sendJson(res, 502, { error: `${name} unavailable in local backend`, detail: err.message });
  });
  // Client went away before the response finished: drop the upstream request too.
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
}

function handleRequest(req, res) {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PROXY_PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...CORS_HEADERS,
      "access-control-allow-headers": req.headers["access-control-request-headers"]
        ? `${CORS_ALLOW_HEADERS}, ${req.headers["access-control-request-headers"]}`
        : CORS_ALLOW_HEADERS,
      "content-length": "0",
    });
    res.end();
    return;
  }

  const authPath = stripPrefix(url.pathname, "/auth/v1");
  if (authPath !== null) {
    forward(req, res, { name: "auth", port: AUTH_PORT, path: authPath + url.search });
    return;
  }
  const restPath = stripPrefix(url.pathname, "/rest/v1");
  if (restPath !== null) {
    forward(req, res, { name: "rest", port: POSTGREST_PORT, path: restPath + url.search });
    return;
  }
  if (stripPrefix(url.pathname, "/storage/v1") !== null) {
    req.resume();
    sendJson(res, 501, { error: "storage not available in local backend" });
    return;
  }
  if (url.pathname === "/realtime/v1/websocket") {
    req.resume();
    sendJson(res, 426, { error: "websocket upgrade required" });
    return;
  }
  req.resume();
  sendJson(res, 404, { error: "not found", path: url.pathname });
}

// WebSocket (RFC 6455), server side, hand-rolled --------------------------------

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 1024 * 1024;

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Wraps an upgraded socket. Calls onText(string) for each complete text
 * message; answers pings and close frames itself.
 */
function websocket(socket, onText) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode = 0;
  let closed = false;

  const ws = {
    sendText(text) {
      if (!closed) socket.write(encodeFrame(0x1, Buffer.from(text, "utf8")));
    },
    close(code = 1000) {
      if (closed) return;
      closed = true;
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      socket.end(encodeFrame(0x8, payload));
    },
  };

  function handleFrame(fin, opcode, payload) {
    if (opcode === 0x8) {
      // Echo the close code, then close.
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
      return;
    }
    if (opcode === 0x9) {
      if (!closed) socket.write(encodeFrame(0xa, payload));
      return;
    }
    if (opcode === 0xa) return; // pong
    if (opcode === 0x1 || opcode === 0x2) {
      fragmentOpcode = opcode;
      fragments = [payload];
    } else if (opcode === 0x0) {
      fragments.push(payload);
    } else {
      ws.close(1002);
      return;
    }
    if (!fin) return;
    const message = Buffer.concat(fragments);
    fragments = [];
    // Binary frames (realtime-js v2 broadcast pushes) are accepted and ignored.
    if (fragmentOpcode === 0x1) onText(message.toString("utf8"), ws);
  }

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2 && !closed) {
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE_BYTES)) {
          ws.close(1009);
          return;
        }
        len = Number(big);
        offset = 10;
      }
      if (!masked) {
        // Clients must mask every frame.
        ws.close(1002);
        return;
      }
      if (len > MAX_MESSAGE_BYTES) {
        ws.close(1009);
        return;
      }
      if (buffer.length < offset + 4 + len) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      buffer = buffer.subarray(offset + 4 + len);
      handleFrame(fin, opcode, payload);
    }
  });
  socket.on("error", () => {
    closed = true;
    socket.destroy();
  });
  socket.on("close", () => {
    closed = true;
  });
  return ws;
}

// Phoenix protocol stub ---------------------------------------------------------
// Understands both serializers realtime-js uses: vsn 1.0.0 (JSON objects) and
// vsn 2.0.0 (JSON arrays [join_ref, ref, topic, event, payload]).

let nextBindingId = 1;

function decodePhoenix(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(raw)) {
    const [join_ref, ref, topic, event, payload] = raw;
    return { format: "array", join_ref, ref, topic, event, payload: payload ?? {} };
  }
  if (raw && typeof raw === "object") {
    return {
      format: "object",
      join_ref: raw.join_ref ?? null,
      ref: raw.ref ?? null,
      topic: raw.topic,
      event: raw.event,
      payload: raw.payload ?? {},
    };
  }
  return null;
}

function encodePhoenix(format, { join_ref, ref, topic, event, payload }) {
  return format === "array"
    ? JSON.stringify([join_ref ?? null, ref ?? null, topic, event, payload])
    : JSON.stringify({ join_ref: join_ref ?? null, ref: ref ?? null, topic, event, payload });
}

function onPhoenixMessage(text, ws) {
  const msg = decodePhoenix(text);
  if (!msg || typeof msg.event !== "string") return;
  const reply = (response = {}) =>
    ws.sendText(
      encodePhoenix(msg.format, {
        join_ref: msg.join_ref,
        ref: msg.ref,
        topic: msg.topic,
        event: "phx_reply",
        payload: { status: "ok", response },
      }),
    );

  switch (msg.event) {
    case "heartbeat":
      reply();
      return;
    case "phx_join": {
      const requested = msg.payload?.config?.postgres_changes;
      const postgres_changes = Array.isArray(requested)
        ? requested.map((binding) => ({ ...binding, id: nextBindingId++ }))
        : [];
      reply({ postgres_changes });
      return;
    }
    case "phx_leave":
      reply();
      return;
    case "broadcast":
    case "presence":
      // Acknowledge pushes so channel.send()/track() resolve; nothing is delivered.
      if (msg.ref != null) reply();
      return;
    default:
      // access_token and anything else: stay silent.
      return;
  }
}

function handleUpgrade(req, socket, head) {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PROXY_PORT}`);
  const key = req.headers["sec-websocket-key"];
  if (url.pathname !== "/realtime/v1/websocket" || typeof key !== "string") {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
  const lines = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
  ];
  const protocols = req.headers["sec-websocket-protocol"];
  if (typeof protocols === "string" && protocols.trim()) {
    lines.push(`Sec-WebSocket-Protocol: ${protocols.split(",")[0].trim()}`);
  }
  socket.setNoDelay(true);
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  if (head && head.length > 0) socket.unshift(head);
  websocket(socket, onPhoenixMessage);
}

/** Starts the gateway; resolves with the http.Server once listening. */
export function startProxy() {
  const server = http.createServer(handleRequest);
  server.on("upgrade", handleUpgrade);
  server.on("clientError", (_err, socket) => socket.destroy());
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PROXY_PORT, HOST, () => resolve(server));
  });
}
