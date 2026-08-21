# Guía de viaje (privada)

Página estática de una sola pieza. El contenido va cifrado con AES-256-GCM
dentro de `index.html`; la clave se deriva de una contraseña con PBKDF2-SHA256
(310.000 iteraciones) en el navegador. Sin la contraseña, el repositorio no
contiene nada legible.
