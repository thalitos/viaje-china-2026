// Sirve la guía cifrada y guarda las notas de forma persistente.
//
// Almacenamiento: fichero JSON en DATA_DIR (por defecto /data, que es donde
// Railway monta el volumen). Si ese directorio no existe o no se puede
// escribir, cae a /tmp y lo avisa en /health: entonces los datos se pierden
// en cada redespliegue.
//
// Autenticación: cabecera Authorization: Bearer <NOTES_TOKEN>. Sin esa
// variable de entorno la API queda en modo solo lectura y rechaza escrituras.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const HTML = fs.readFileSync(path.join(__dirname, "index.html"));
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.NOTES_TOKEN || "";
const MAX_BODY = 512 * 1024;

// Railway define RAILWAY_VOLUME_MOUNT_PATH sólo cuando hay un volumen montado
// de verdad. Sin esa variable, /data existe igualmente pero es efímero.
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || "";
function pickDataDir() {
  for (const dir of [VOLUME, process.env.DATA_DIR, "/data", require("node:os").tmpdir()]) {
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch { /* siguiente */ }
  }
  return null;
}
const DATA_DIR = pickDataDir();
const DATA_FILE = DATA_DIR ? path.join(DATA_DIR, "notas.json") : null;
const PERSISTENT = Boolean(VOLUME && DATA_DIR === VOLUME) || Boolean(process.env.DATA_DIR && DATA_DIR === process.env.DATA_DIR);

function readStore() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return { notes: {}, fields: {} }; }
}
function writeStore(obj) {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, DATA_FILE);           // atómico: nunca deja el fichero a medias
}
// Se queda con la entrada más reciente de cada clave.
function merge(base, incoming) {
  const out = { notes: { ...base.notes }, fields: { ...base.fields } };
  for (const kind of ["notes", "fields"]) {
    for (const [k, e] of Object.entries(incoming[kind] || {})) {
      if (!e || typeof e.v !== "string" || typeof e.t !== "number") continue;
      if (k.length > 64 || e.v.length > 20000) continue;
      const cur = out[kind][k];
      if (!cur || e.t > cur.t) out[kind][k] = { t: e.t, v: e.v };
    }
  }
  return out;
}
function authorised(req) {
  if (!TOKEN) return false;
  const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400"
    });
    return res.end();
  }

  if (url === "/health") {
    return json(res, 200, {
      ok: true,
      almacenamiento: DATA_DIR,
      persistente: PERSISTENT,
      volumen: VOLUME || "sin montar",
      sincronizacion: TOKEN ? "activa" : "sin NOTES_TOKEN"
    });
  }

  if (url === "/api/notes") {
    if (!DATA_FILE) return json(res, 503, { ok: false, error: "sin almacenamiento" });
    if (!TOKEN) return json(res, 503, { ok: false, error: "falta NOTES_TOKEN en el servidor" });
    if (!authorised(req)) return json(res, 401, { ok: false, error: "token incorrecto" });

    if (req.method === "GET") {
      return json(res, 200, { ok: true, persistente: PERSISTENT, data: readStore() });
    }
    if (req.method === "POST") {
      let body = "", tooBig = false;
      req.on("data", c => {
        body += c;
        if (body.length > MAX_BODY) { tooBig = true; req.destroy(); }
      });
      req.on("end", () => {
        if (tooBig) return json(res, 413, { ok: false, error: "demasiado grande" });
        let incoming;
        try { incoming = JSON.parse(body); } catch { return json(res, 400, { ok: false, error: "JSON inválido" }); }
        try {
          const merged = merge(readStore(), incoming || {});
          writeStore(merged);
          return json(res, 200, { ok: true, persistente: PERSISTENT, data: merged });
        } catch (e) {
          return json(res, 500, { ok: false, error: "no se pudo guardar" });
        }
      });
      return;
    }
    return json(res, 405, { ok: false, error: "método no permitido" });
  }

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=300",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer"
  });
  res.end(HTML);
}).listen(PORT, () => {
  console.log("Guía en el puerto " + PORT);
  console.log("Almacenamiento: " + DATA_DIR + (PERSISTENT ? " (persistente)" : " (EFÍMERO: falta el volumen)"));
  console.log("Sincronización: " + (TOKEN ? "activa" : "desactivada, falta NOTES_TOKEN"));
});
