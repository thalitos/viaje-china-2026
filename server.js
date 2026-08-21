// Sirve la guía cifrada, guarda las notas y hace de puente para los archivos
// de la cartera.
//
// Notas: fichero JSON en DATA_DIR (por defecto /data, que es donde Railway
// monta el volumen). Si ese directorio no existe o no se puede escribir, cae
// a /tmp y lo avisa en /health: entonces los datos se pierden en cada
// redespliegue.
//
// Archivos de la cartera: si hay credenciales GOOGLE_* van al Drive personal
// (ver drive.js); si no, al mismo volumen. Suben y bajan ya cifrados por el
// navegador, así que aquí y en Drive sólo hay bytes ilegibles.
//
// Autenticación: cabecera Authorization: Bearer <NOTES_TOKEN>. Sin esa
// variable de entorno la API queda en modo solo lectura y rechaza escrituras.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const drive = require("./drive.js");

const HTML = fs.readFileSync(path.join(__dirname, "index.html"));
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.NOTES_TOKEN || "";
const MAX_BODY = 512 * 1024;
const MAX_FILE = 60 * 1024 * 1024;   // por archivo, ya cifrado

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

// ---- Dónde se guardan los archivos de la cartera -------------------------
// Dos implementaciones con la misma forma: listar / bajar / subir / borrar.
// El resto del servidor no sabe cuál está usando.

const dirArchivos = DATA_DIR ? path.join(DATA_DIR, "archivos") : null;
const idxArchivos = dirArchivos ? path.join(dirArchivos, "indice.json") : null;

const almacenDisco = {
  nombre: "volumen",
  persistente: PERSISTENT,
  leerIdx() { try { return JSON.parse(fs.readFileSync(idxArchivos, "utf8")); } catch { return {}; } },
  grabarIdx(o) {
    fs.mkdirSync(dirArchivos, { recursive: true });
    const tmp = idxArchivos + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(o));
    fs.renameSync(tmp, idxArchivos);
  },
  async listar() { return this.leerIdx(); },
  async bajar(clave) {
    const bin = path.join(dirArchivos, clave + ".bin");
    if (!this.leerIdx()[clave] || !fs.existsSync(bin)) return null;
    return fs.readFileSync(bin);
  },
  async subir(clave, buf, meta) {
    fs.mkdirSync(dirArchivos, { recursive: true });
    const bin = path.join(dirArchivos, clave + ".bin");
    const tmp = bin + ".tmp";
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, bin);
    const idx = this.leerIdx();
    idx[clave] = { ...meta, cifrado: buf.length };
    this.grabarIdx(idx);
    return idx[clave];
  },
  async borrar(clave) {
    const idx = this.leerIdx();
    delete idx[clave];
    this.grabarIdx(idx);
    try { fs.unlinkSync(path.join(dirArchivos, clave + ".bin")); } catch {}
    return true;
  }
};

const almacenDrive = {
  nombre: "drive",
  persistente: true,                       // Drive no depende del redespliegue
  listar: () => drive.listar(),
  bajar: clave => drive.bajar(clave),
  subir: (clave, buf, meta) => drive.subir(clave, buf, meta),
  borrar: clave => drive.borrar(clave)
};

const ALMACEN = drive.ACTIVO ? almacenDrive : (DATA_DIR ? almacenDisco : null);

// ---- Notas ---------------------------------------------------------------
// La verdad vive en memoria mientras el proceso está en pie. Con Drive detrás
// se sube con un pequeño retardo (varias teclas seguidas = una sola subida) y
// se vuelca a disco de paso, como copia local. Sin Drive, el disco es todo.

const NOTAS_EN_DRIVE = drive.ACTIVO;
// Se calcula en cada respuesta: si Drive deja de contestar, las notas pasan a
// depender del volumen y el móvil debe enterarse.
const notasPersistentes = () => (NOTAS_EN_DRIVE && estadoNotas === "drive") || PERSISTENT;
const VACIO = { notes: {}, fields: {} };
let MEM = null;
let estadoNotas = NOTAS_EN_DRIVE ? "arrancando" : (DATA_FILE ? "disco" : "sin almacén");

function leerDisco() {
  if (!DATA_FILE) return { ...VACIO };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return { ...VACIO }; }
}
function grabarDisco(obj) {
  if (!DATA_FILE) return;
  try {
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, DATA_FILE);         // atómico: nunca deja el fichero a medias
  } catch (e) { console.error("notas en disco:", e.message); }
}

// Arranque: leer lo que haya en Drive y, si Drive está en blanco pero el
// volumen tenía notas, subirlas (así la mudanza no pierde nada).
const arranque = (async () => {
  const local = leerDisco();
  if (!NOTAS_EN_DRIVE) { MEM = local; return; }
  try {
    const texto = await drive.leerNotas();
    if (texto === null) {
      MEM = local;
      estadoNotas = "drive";
      const hay = Object.keys(local.notes || {}).length || Object.keys(local.fields || {}).length;
      if (hay) { await drive.grabarNotas(JSON.stringify(MEM)); console.log("Notas: mudadas al Drive las que había en el volumen"); }
    } else {
      MEM = merge(local, JSON.parse(texto));   // gana la versión más reciente de cada clave
      estadoNotas = "drive";
      grabarDisco(MEM);
    }
  } catch (e) {
    MEM = local;                            // se sigue sirviendo; Drive se reintenta al guardar
    estadoNotas = "drive no responde: " + e.message;
    console.error("Notas: no se han podido leer de Drive:", e.message);
  }
})();

let subidaTimer = null, subiendo = false, otraVez = false;
function programarSubida(ms = 1500) {
  if (!NOTAS_EN_DRIVE) return;
  clearTimeout(subidaTimer);
  subidaTimer = setTimeout(subirNotas, ms);
}
async function subirNotas() {
  if (subiendo) { otraVez = true; return; }
  subiendo = true; otraVez = false;
  try {
    await drive.grabarNotas(JSON.stringify(MEM));
    estadoNotas = "drive";
  } catch (e) {
    estadoNotas = "drive no responde: " + e.message;
    console.error("Notas: no se han podido guardar en Drive:", e.message);
    programarSubida(15000);                 // se reintenta solo
  } finally {
    subiendo = false;
    if (otraVez) programarSubida();         // llegaron cambios mientras subía
  }
}

async function leerNotas() { await arranque; return MEM || { ...VACIO }; }
async function guardarNotas(incoming) {
  await arranque;
  MEM = merge(MEM || VACIO, incoming || {});
  grabarDisco(MEM);
  programarSubida();
  return MEM;
}

// Railway manda SIGTERM al redesplegar: se sube lo que quede pendiente antes
// de morir, que si no se pierde el último minuto y medio de escritura.
for (const senal of ["SIGTERM", "SIGINT"]) {
  process.on(senal, async () => {
    clearTimeout(subidaTimer);
    if (NOTAS_EN_DRIVE && MEM) {
      try { await drive.grabarNotas(JSON.stringify(MEM)); console.log("Notas: guardadas antes de cerrar"); }
      catch (e) { console.error("Notas: no dio tiempo a guardarlas:", e.message); }
    }
    process.exit(0);
  });
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
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Nombre, X-Tipo, X-Peso",
      "Access-Control-Max-Age": "86400"
    });
    return res.end();
  }

  if (url === "/health") {
    const base = {
      ok: true,
      almacenamiento: DATA_DIR,
      persistente: notasPersistentes(),
      notas: authorised(req) ? estadoNotas : estadoNotas.split(":")[0],
      volumen: VOLUME || "sin montar",
      archivos: ALMACEN ? ALMACEN.nombre : "sin almacén",
      sincronizacion: TOKEN ? "activa" : "sin NOTES_TOKEN"
    };
    if (!drive.ACTIVO) return json(res, 200, base);
    // Con Drive configurado se comprueba de verdad: credenciales y hueco libre.
    // El detalle (correo, carpeta, motivo del fallo) sólo con token: /health es
    // público y ahí no pinta nada la cuenta de Google de nadie.
    const detalle = authorised(req);
    drive.comprobar()
      .then(d => json(res, 200, { ...base, drive: detalle ? d : { activo: true, ok: !d.error } }))
      .catch(e => json(res, 200, { ...base, drive: detalle ? { activo: true, error: String(e.message || e) } : { activo: true, ok: false } }));
    return;
  }

  // Calendario de avisos. Va con token en la query porque iOS se suscribe
  // con la URL tal cual y no puede mandar cabeceras.
  if (url === "/avisos.ics") {
    const k = new URL(req.url, "http://x").searchParams.get("k") || "";
    if (!TOKEN || k !== TOKEN) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("no encontrado");
    }
    let ics;
    try { ics = fs.readFileSync(path.join(__dirname, "avisos.ics")); }
    catch { res.writeHead(404); return res.end(); }
    res.writeHead(200, {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="china-2026.ics"',
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*"
    });
    return res.end(ics);
  }

  // ---- Archivos compartidos ----------------------------------------------
  // Los sube el navegador YA CIFRADOS: aquí sólo se manejan bytes opacos.
  // Con credenciales de Google van al Drive personal; si no, al volumen.
  if (url === "/api/files" || url.startsWith("/api/files/")) {
    if (!ALMACEN) return json(res, 503, { ok: false, error: "sin almacenamiento" });
    if (!TOKEN) return json(res, 503, { ok: false, error: "falta NOTES_TOKEN en el servidor" });
    if (!authorised(req)) return json(res, 401, { ok: false, error: "token incorrecto" });

    const clave = url === "/api/files" ? "" : decodeURIComponent(url.slice("/api/files/".length));
    if (clave && !/^[a-z0-9-]{1,40}$/.test(clave))
      return json(res, 400, { ok: false, error: "clave no válida" });

    // Un fallo de Drive no puede tumbar el servidor: se responde 502 y ya.
    const falló = e => {
      console.error("archivos:", e && e.message ? e.message : e);
      json(res, 502, { ok: false, error: "el almacén no respondió", detalle: String((e && e.message) || e).slice(0, 200) });
    };

    if (req.method === "GET" && !clave) {
      ALMACEN.listar()
        .then(archivos => json(res, 200, { ok: true, persistente: ALMACEN.persistente, almacen: ALMACEN.nombre, archivos }))
        .catch(falló);
      return;
    }

    if (req.method === "GET" && clave) {
      ALMACEN.bajar(clave)
        .then(buf => {
          if (!buf) return json(res, 404, { ok: false, error: "no está" });
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": buf.length,
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store"
          });
          res.end(buf);
        })
        .catch(falló);
      return;
    }

    if (req.method === "PUT" && clave) {
      const trozos = []; let bytes = 0, pasado = false;
      req.on("data", c => {
        bytes += c.length;
        if (bytes > MAX_FILE) { pasado = true; req.destroy(); return; }
        trozos.push(c);
      });
      req.on("end", () => {
        if (pasado) return json(res, 413, { ok: false, error: "demasiado grande" });
        const meta = {
          nombre: String(req.headers["x-nombre"] || "").slice(0, 200),
          tipo:   String(req.headers["x-tipo"] || "application/octet-stream").slice(0, 100),
          peso:   parseInt(req.headers["x-peso"] || "0", 10) || bytes,
          fecha:  Date.now()
        };
        ALMACEN.subir(clave, Buffer.concat(trozos), meta)
          .then(archivo => json(res, 200, { ok: true, persistente: ALMACEN.persistente, almacen: ALMACEN.nombre, archivo }))
          .catch(falló);
      });
      return;
    }

    if (req.method === "DELETE" && clave) {
      ALMACEN.borrar(clave).then(() => json(res, 200, { ok: true })).catch(falló);
      return;
    }
    return json(res, 405, { ok: false, error: "método no permitido" });
  }

  if (url === "/api/notes") {
    if (!DATA_FILE && !NOTAS_EN_DRIVE) return json(res, 503, { ok: false, error: "sin almacenamiento" });
    if (!TOKEN) return json(res, 503, { ok: false, error: "falta NOTES_TOKEN en el servidor" });
    if (!authorised(req)) return json(res, 401, { ok: false, error: "token incorrecto" });

    if (req.method === "GET") {
      leerNotas()
        .then(data => json(res, 200, { ok: true, persistente: notasPersistentes(), data }))
        .catch(() => json(res, 500, { ok: false, error: "no se pudo leer" }));
      return;
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
        guardarNotas(incoming)
          .then(data => json(res, 200, { ok: true, persistente: notasPersistentes(), data }))
          .catch(() => json(res, 500, { ok: false, error: "no se pudo guardar" }));
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
  console.log("Notas: " + (NOTAS_EN_DRIVE ? "Google Drive (copia local en " + DATA_DIR + ")"
                                           : DATA_DIR + (PERSISTENT ? " (persistente)" : " (EFÍMERO: falta el volumen)")));
  console.log("Archivos: " + (drive.ACTIVO ? "Google Drive" : (DATA_DIR ? "volumen local" : "sin almacén")));
  console.log("Sincronización: " + (TOKEN ? "activa" : "desactivada, falta NOTES_TOKEN"));
});
