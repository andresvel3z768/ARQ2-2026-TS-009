#!/usr/bin/env bash
# =============================================================================
# AeroBooking - arranque del stack local
# =============================================================================
# Uso:
#   ./scripts/up.sh
#   ./scripts/up.sh --profile observability
#   ./scripts/up.sh --profile mock
#   ./scripts/up.sh --profile observability --profile mock
#   ./scripts/up.sh postgres valkey
#
# El script:
#   1. Crea .env desde .env.example si no existe.
#   2. Valida la configuracion de Compose.
#   3. Levanta los servicios en segundo plano.
# =============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Falla temprano con un mensaje claro si Docker Desktop no esta disponible.
if ! docker compose version >/dev/null 2>&1; then
  echo "[up] Error: se requiere Docker Desktop con Docker Compose v2." >&2
  echo "[up] Instala Docker Desktop y abre una terminal nueva." >&2
  exit 1
fi

if [ ! -f "$ROOT_DIR/.env" ]; then
  cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
  echo "[up] .env creado desde .env.example. Revisa las credenciales antes de usar el stack."
fi

# Los argumentos se separan en dos grupos porque Docker Compose exige que
# --profile vaya antes del subcomando `up`, mientras que los nombres de
# servicios van despues.
PROFILE_ARGS=()
SERVICE_ARGS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      if [ "$#" -lt 2 ]; then
        echo "[up] Error: falta el nombre del perfil despues de --profile." >&2
        exit 1
      fi
      PROFILE_ARGS+=(--profile "$2")
      shift 2
      ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      SERVICE_ARGS+=("$1")
      shift
      ;;
  esac
done

# Valida el YAML y la interpolacion de variables antes de tocar contenedores.
docker compose --project-directory "$ROOT_DIR" "${PROFILE_ARGS[@]}" config -q

# En la Fase 1 no hay servicios definidos. Este mensaje evita que el equipo
# interprete el resultado como un error y confirma que la base es valida.
AVAILABLE_SERVICES="$(docker compose --project-directory "$ROOT_DIR" "${PROFILE_ARGS[@]}" config --services)"
if [ -z "$AVAILABLE_SERVICES" ]; then
  echo "[up] Fase 1: no hay servicios definidos todavia."
  echo "[up] La configuracion base es valida. Los servicios llegan en la Fase 2."
  exit 0
fi

docker compose --project-directory "$ROOT_DIR" "${PROFILE_ARGS[@]}" up -d "${SERVICE_ARGS[@]}"
