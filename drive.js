// Almacén en Google Drive (la cuenta personal de Fadel). Guarda dos cosas en
// la misma carpeta:
//
//   <ranura>.bin  los documentos de la cartera. Llegan YA CIFRADOS desde el
//                 navegador (AES-GCM con la clave derivada del token de
//                 sincronización): aquí sólo se manejan bytes opacos.
//   notas.json    las notas y los campos rellenables, en claro, porque el
//                 servidor tiene que fusionarlos por fecha.
//
// Variables de entorno necesarias:
//   GOOGLE_CLIENT_ID       \
//   GOOGLE_CLIENT_SECRET    | del cliente OAuth "aplicación de escritorio"
//   GOOGLE_REFRESH_TOKEN   /  que genera fuente/drive-token.mjs
//   GOOGLE_FOLDER_ID       (opcional) carpeta donde guardar; si falta, se
//                          crea/reutiliza una llamada GOOGLE_FOLDER_NAME.
//
// Sin esas variables el módulo queda inactivo y el servidor sigue usando el
// disco del volumen como hasta ahora.

const crypto = require("node:crypto");

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || "";
const FOLDER_ID_ENV = process.env.GOOGLE_FOLDER_ID || "";
const FOLDER_NAME   = process.env.GOOGLE_FOLDER_NAME || "China 2026 - archivos";

const ACTIVO = Boolean(CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN);
const MARCA = "cn26";                      // etiqueta para no tocar otros ficheros

let tokenCache = { valor: "", caduca: 0 };
let carpetaId = FOLDER_ID_ENV;
let idPorClave = new Map();                // clave -> id de Drive
let ultimoError = "";

async function pedir(url, opts = {}, reintento = true) {
  const token = await accessToken();
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: "Bearer " + token, ...(opts.headers || {}) }
  });
  // 401: el access token se ha quedado viejo; se pide otro y se repite una vez.
  if (res.status === 401 && reintento) {
    tokenCache = { valor: "", caduca: 0 };
    return pedir(url, opts, false);
  }
  return res;
}

async function accessToken() {
  const ahora = Date.now();
  if (tokenCache.valor && ahora < tokenCache.caduca) return tokenCache.valor;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: "refresh_token"
    })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    ultimoError = "no se pudo renovar el token: " + (j.error_description || j.error || res.status);
    throw new Error(ultimoError);
  }
  // Se descuenta un minuto para no apurar el vencimiento.
  tokenCache = { valor: j.access_token, caduca: ahora + Math.max(60, (j.expires_in || 3600) - 60) * 1000 };
  return tokenCache.valor;
}

async function carpeta() {
  if (carpetaId) return carpetaId;
  const q = `mimeType = 'application/vnd.google-apps.folder' and name = '${FOLDER_NAME.replace(/'/g, "\\'")}' and trashed = false`;
  const buscar = await pedir("https://www.googleapis.com/drive/v3/files?" + new URLSearchParams({
    q, fields: "files(id,name)", pageSize: "1", spaces: "drive"
  }));
  const encontrado = await buscar.json().catch(() => ({}));
  // Si la búsqueda falla no se crea nada: un fallo pasajero de Drive no puede
  // acabar en dos carpetas con los archivos repartidos entre las dos.
  if (!buscar.ok) throw new Error("no se pudo buscar la carpeta en Drive (" + buscar.status + ")");
  if (encontrado.files && encontrado.files.length) {
    carpetaId = encontrado.files[0].id;
    return carpetaId;
  }
  const crear = await pedir("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" })
  });
  const nueva = await crear.json().catch(() => ({}));
  if (!crear.ok || !nueva.id) throw new Error("no se pudo crear la carpeta en Drive");
  carpetaId = nueva.id;
  return carpetaId;
}

function aMeta(f) {
  const p = f.appProperties || {};
  return {
    nombre: p.nombre || f.name || "",
    tipo: p.tipo || "application/octet-stream",
    peso: parseInt(p.peso || "0", 10) || 0,
    cifrado: parseInt(f.size || p.cifrado || "0", 10) || 0,
    fecha: parseInt(p.fecha || "0", 10) || Date.parse(f.modifiedTime || "") || 0
  };
}

async function listar() {
  const dir = await carpeta();
  const res = await pedir("https://www.googleapis.com/drive/v3/files?" + new URLSearchParams({
    q: `'${dir}' in parents and trashed = false and appProperties has { key='app' and value='${MARCA}' }`,
    fields: "files(id,name,size,modifiedTime,appProperties)",
    pageSize: "1000",
    spaces: "drive"
  }));
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("no se pudo listar Drive: " + (j.error?.message || res.status));
  const indice = {};
  idPorClave = new Map();
  for (const f of j.files || []) {
    const clave = (f.appProperties || {}).clave || f.name.replace(/\.bin$/, "");
    idPorClave.set(clave, f.id);
    indice[clave] = aMeta(f);
  }
  return indice;
}

async function idDe(clave) {
  if (idPorClave.has(clave)) return idPorClave.get(clave);
  await listar();                          // repuebla el mapa entero de una vez
  return idPorClave.get(clave) || null;
}

// Subida reanudable: vale para cualquier tamaño (la simple sólo hasta 5 MB).
async function subir(clave, buf, meta) {
  const dir = await carpeta();
  const id = await idDe(clave);
  const propiedades = {
    app: MARCA,
    clave,
    nombre: String(meta.nombre || "").slice(0, 200),
    tipo: String(meta.tipo || "application/octet-stream").slice(0, 100),
    peso: String(meta.peso || buf.length),
    fecha: String(meta.fecha || Date.now())
  };
  const cuerpo = id
    ? { name: clave + ".bin", appProperties: propiedades }
    : { name: clave + ".bin", parents: [dir], mimeType: "application/octet-stream", appProperties: propiedades };

  const inicio = await pedir(
    "https://www.googleapis.com/upload/drive/v3/files" + (id ? "/" + id : "") + "?uploadType=resumable",
    {
      method: id ? "PATCH" : "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "application/octet-stream",
        "X-Upload-Content-Length": String(buf.length)
      },
      body: JSON.stringify(cuerpo)
    }
  );
  if (!inicio.ok) {
    const e = await inicio.text().catch(() => "");
    throw new Error("Drive rechazó la subida (" + inicio.status + "): " + e.slice(0, 200));
  }
  const destino = inicio.headers.get("location");
  if (!destino) throw new Error("Drive no devolvió dónde subir");

  const fin = await fetch(destino, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", "Content-Length": String(buf.length) },
    body: buf
  });
  const j = await fin.json().catch(() => ({}));
  if (!fin.ok) throw new Error("Drive falló al recibir el archivo (" + fin.status + ")");
  if (j.id) idPorClave.set(clave, j.id);
  return { ...aMeta({ ...j, appProperties: propiedades, size: String(buf.length) }), cifrado: buf.length };
}

async function bajar(clave) {
  const id = await idDe(clave);
  if (!id) return null;
  const res = await pedir("https://www.googleapis.com/drive/v3/files/" + id + "?alt=media");
  if (res.status === 404) { idPorClave.delete(clave); return null; }
  if (!res.ok) throw new Error("Drive no devolvió el archivo (" + res.status + ")");
  return Buffer.from(await res.arrayBuffer());
}

async function borrar(clave) {
  const id = await idDe(clave);
  if (!id) return true;
  const res = await pedir("https://www.googleapis.com/drive/v3/files/" + id, { method: "DELETE" });
  idPorClave.delete(clave);
  if (!res.ok && res.status !== 404) throw new Error("Drive no pudo borrar (" + res.status + ")");
  return true;
}

// ---- Notas ---------------------------------------------------------------
// Van en el mismo sitio pero como fichero suelto (notas.json) y con otra
// etiqueta, para que no salgan mezcladas con los archivos de la cartera.

const NOTAS = "notas.json";
let idNotas = null;

async function buscarNotas() {
  if (idNotas) return idNotas;
  const dir = await carpeta();
  const res = await pedir("https://www.googleapis.com/drive/v3/files?" + new URLSearchParams({
    q: `'${dir}' in parents and name = '${NOTAS}' and trashed = false`,
    fields: "files(id)", pageSize: "1", spaces: "drive"
  }));
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("no se pudo buscar las notas en Drive (" + res.status + ")");
  idNotas = (j.files && j.files[0] && j.files[0].id) || null;
  return idNotas;
}

async function leerNotas() {
  const id = await buscarNotas();
  if (!id) return null;                    // aún no hay nada guardado
  const res = await pedir("https://www.googleapis.com/drive/v3/files/" + id + "?alt=media");
  if (res.status === 404) { idNotas = null; return null; }
  if (!res.ok) throw new Error("Drive no devolvió las notas (" + res.status + ")");
  return await res.text();
}

// Subida multipart: metadatos y contenido en una sola llamada. Las notas son
// unos pocos KB, así que no compensa el ida y vuelta de la reanudable.
async function grabarNotas(texto) {
  const dir = await carpeta();
  const id = await buscarNotas();
  const linde = "cn26-" + crypto.randomUUID();
  const meta = id
    ? { name: NOTAS, appProperties: { app: MARCA + "-notas" } }
    : { name: NOTAS, parents: [dir], mimeType: "application/json", appProperties: { app: MARCA + "-notas" } };
  const cuerpo =
    "--" + linde + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(meta) +
    "\r\n--" + linde + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + texto +
    "\r\n--" + linde + "--";
  const res = await pedir(
    "https://www.googleapis.com/upload/drive/v3/files" + (id ? "/" + id : "") + "?uploadType=multipart&fields=id",
    {
      method: id ? "PATCH" : "POST",
      headers: { "Content-Type": "multipart/related; boundary=" + linde },
      body: cuerpo
    }
  );
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Drive no guardó las notas (" + res.status + ")");
  if (j.id) idNotas = j.id;
  return true;
}

// Para /health: comprueba credenciales y carpeta sin tocar ningún archivo.
// Con caché de un minuto, que Railway llama a /health más de lo que parece y
// no hace falta preguntarle a Google cada vez.
let cacheSalud = { hasta: 0, valor: null };
async function comprobar() {
  if (!ACTIVO) return { activo: false, motivo: "faltan las variables GOOGLE_*" };
  if (cacheSalud.valor && Date.now() < cacheSalud.hasta) return cacheSalud.valor;
  const guardar = v => { cacheSalud = { hasta: Date.now() + 60000, valor: v }; return v; };
  try {
    const dir = await carpeta();
    const res = await pedir("https://www.googleapis.com/drive/v3/about?fields=storageQuota,user(emailAddress)");
    const j = await res.json().catch(() => ({}));
    const q = j.storageQuota || {};
    return guardar({
      activo: true,
      carpeta: dir,
      cuenta: j.user?.emailAddress || "",
      usado: q.usage ? Number(q.usage) : null,
      limite: q.limit ? Number(q.limit) : null
    });
  } catch (e) {
    return guardar({ activo: true, error: String(e.message || e) });
  }
}

module.exports = { ACTIVO, listar, subir, bajar, borrar, leerNotas, grabarNotas, comprobar, ultimoError: () => ultimoError };
