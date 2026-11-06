# Operacion y verificacion

## Fase 1

La Fase 1 no levanta servicios. Su objetivo es validar que la base del proyecto
sea correcta antes de agregar contenedores.

### Verificacion

```bash
# Valida el YAML, la interpolacion de variables y los archivos base
./scripts/verify.sh

# Equivalente directo con Docker Compose
docker compose config -q

# Prueba el script de arranque (avisa que aun no hay servicios)
./scripts/up.sh
```

Salida esperada de `up.sh` en Fase 1:

```text
[up] Fase 1: no hay servicios definidos todavia.
[up] La configuracion base es valida. Los servicios llegan en la Fase 2.
```

### Que revisar manualmente

- `docker-compose.yml` define `name`, `aerobooking-net` y los volumenes.
- `.env.example` contiene todas las variables que se usaran en las fases 2 a 6.
- `.gitignore` excluye `.env`, claves privadas y el config generado de Kong.
- `infra/` contiene las carpetas de configuracion con `.gitkeep`.
- `docs/infra/` contiene esta documentacion.

## Endpoints

Todavia no hay endpoints activos. La siguiente tabla se completa a medida que
avancen las fases:

| Fase | Servicio | URL local | Estado |
| --- | --- | --- | --- |
| 2 | RabbitMQ Management | `http://localhost:15672` | Pendiente |
| 3 | Kong Admin API | `http://localhost:8001/status` | Pendiente |
| 3 | Kong Proxy | `http://localhost:8000` | Pendiente |
| 4 | Jaeger UI | `http://localhost:16686` | Pendiente |
| 5 | Grafana | `http://localhost:3000` | Pendiente |
| 5 | Loki | `http://localhost:3100/ready` | Pendiente |
| 6 | WireMock | `http://localhost:8089` | Pendiente |

## Troubleshooting

### `docker: command not found`

Docker Desktop no esta instalado o la terminal no tiene el CLI en el `PATH`.
Abrir Docker Desktop y ejecutar los comandos desde Git Bash o WSL.

### `permission denied` al ejecutar scripts

```bash
chmod +x scripts/*.sh
```

### Los scripts fallan por finales de linea CRLF

```bash
git config core.autocrlf false
git add --renormalize .
```

`.gitattributes` ya fuerza `eol=lf` para los scripts y archivos YAML. Revisa el
resultado antes de hacer commit.

### Un puerto esta ocupado

En fases posteriores, cambiar el puerto en `.env` (por ejemplo
`POSTGRES_PORT=5433`) y volver a ejecutar `./scripts/up.sh`.

## Siguiente fase

La Fase 2 agrega los servicios de estado y mensajeria. Al terminar, este
documento debe incluir sus healthchecks y comandos de verificacion reales.
