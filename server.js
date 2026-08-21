// Servidor mínimo, sin dependencias: sirve la guía cifrada en cualquier ruta.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const HTML = fs.readFileSync(path.join(__dirname, "index.html"));
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=300",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer"
  });
  res.end(HTML);
}).listen(PORT, () => console.log("Guía escuchando en el puerto " + PORT));
