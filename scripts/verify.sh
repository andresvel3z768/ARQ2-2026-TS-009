#!/usr/bin/env bash
# =============================================================================
# AeroBooking - verificacion de la infraestructura
# =============================================================================
# Fase 1: valida que los archivos base existan, que el YAML de Compose sea
# correcto y que las variables de entorno se interpolen sin errores.
#
# En las siguientes fases este script crecera con healthchecks, consultas a
# PostgreSQL/Valkey/RabbitMQ y pruebas de las rutas de Kong.
# =============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Falla temprano con un mensaje claro si Docker Desktop no esta disponible.
if ! docker compose version >/dev/null 2>&1; then
  echo "[verify] Error: se requiere Docker Desktop con Docker Compose v2." >&2
  echo "[verify] Instala Docker Desktop y abre una terminal nueva." >&2
  exit 1
fi

echo "[verify] Revisando archivos base..."
for file in docker-compose.yml .env.example .gitignore .gitattributes; do
  if [ ! -f "$ROOT_DIR/$file" ]; then
    echo "[verify] Error: falta $file" >&2
    exit 1
  fi
done

echo "[verify] Validando docker-compose.yml..."
docker compose --project-directory "$ROOT_DIR" config -q

if [ -f "$ROOT_DIR/.env" ]; then
  echo "[verify] .env presente."
else
  echo "[verify] Aviso: .env no existe. Ejecuta ./scripts/up.sh o copia .env.example."
fi

echo "[verify] OK: la configuracion base es valida."
