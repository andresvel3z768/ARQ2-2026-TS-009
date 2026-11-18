# Configuracion

## Archivo `.env`

Docker Compose lee automaticamente el archivo `.env` de la raiz del proyecto.
El repositorio solo versiona `.env.example`; el `.env` real queda ignorado por
`.gitignore` porque contiene credenciales de desarrollo.

```bash
cp .env.example .env
```

Los valores `change-me-*` son marcadores. No deben usarse fuera del entorno
local.

## Variables por fase

### Base

| Variable | Valor por defecto | Uso |
| --- | --- | --- |
| `COMPOSE_PROJECT_NAME` | `aerobooking` | Prefijo de red, contenedores y volumenes |

### Fase 2 - PostgreSQL

| Variable | Valor por defecto | Uso |
| --- | --- | --- |
| `POSTGRES_DB` | `booking_db` | Base de datos principal |
| `POSTGRES_USER` | `postgres` | Superusuario inicial del contenedor |
| `POSTGRES_PASSWORD` | `change-me-postgres` | Password del superusuario |
| `POSTGRES_APP_USER` | `aerobooking_app` | Rol de la aplicacion |
| `POSTGRES_APP_PASSWORD` | `change-me-app` | Password del rol de aplicacion |
| `POSTGRES_AUDIT_USER` | `aerobooking_audit` | Rol de escritura de auditoria |
| `POSTGRES_AUDIT_PASSWORD` | `change-me-audit` | Password del rol de auditoria |
| `POSTGRES_PORT` | `5432` | Puerto publicado en loopback |

### Fase 2 - Valkey

| Variable | Valor por defecto | Uso |
| --- | --- | --- |
| `VALKEY_PASSWORD` | `change-me-valkey` | Password de Valkey |
| `VALKEY_PORT` | `6379` | Puerto publicado en loopback |

### Fase 2 - RabbitMQ

| Variable | Valor por defecto | Uso |
| --- | --- | --- |
| `RABBITMQ_DEFAULT_USER` | `aerobooking` | Usuario administrador |
| `RABBITMQ_DEFAULT_PASS` | `change-me-rabbitmq` | Password del administrador |
| `RABBITMQ_PORT` | `5672` | Puerto AMQP |
| `RABBITMQ_MANAGEMENT_PORT` | `15672` | Consola de administracion |

### Fase 3 - Kong

| Variable | Valor por defecto | Uso |
| --- | --- | --- |
| `KONG_PROXY_PORT` | `8000` | Puerto de entrada para agencias |
| `KONG_ADMIN_PORT` | `8001` | API de administracion (solo loopback) |
| `KONG_LOG_LEVEL` | `info` | Nivel de logs del gateway |

### Fase 4 - Jaeger

| Variable | Valor por defecto | Uso |
| --- | --- | --- |
| `JAEGER_UI_PORT` | `16686` | Interfaz web de trazas |
| `JAEGER_OTLP_GRPC_PORT` | `4317` | Recepcion OTLP gRPC |
| `JAEGER_OTLP_HTTP_PORT` | `4318` | Recepcion OTLP HTTP |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://jaeger:4318` | Endpoint para los servicios Node |

### Fase 5 - Observabilidad

| Variable | Valor por defecto | Uso |
| --- | --- | --- |
| `GRAFANA_ADMIN_USER` | `admin` | Usuario administrador de Grafana |
| `GRAFANA_ADMIN_PASSWORD` | `change-me-grafana` | Password de Grafana |
| `GRAFANA_PORT` | `3000` | Puerto de Grafana |
| `LOKI_PORT` | `3100` | Puerto de Loki |
| `ALLOY_PORT` | `12345` | Interfaz de Grafana Alloy |

### Fase 6 - Mock de aerolinea

| Variable | Valor por defecto | Uso |
| --- | --- | --- |
| `MOCK_AIRLINE_PORT` | `8089` | Puerto de WireMock |
| `AIRLINE_API_URL` | `http://mock-airline:8080` | URL que usara el Airline Connector |

## Archivos generados

Estos archivos se crean durante las siguientes fases y no se versionan:

| Archivo | Fase | Motivo |
| --- | --- | --- |
| `infra/kong/kong.generated.yml` | 3 | Se renderiza con la clave publica JWT |
| `infra/kong/keys/jwt-private.pem` | 3 | Clave privada de desarrollo |
| `infra/kong/keys/jwt-public.pem` | 3 | Clave publica derivada de la privada |

La clave privada nunca debe subirse al repositorio. La clave publica puede
compartirse, pero se genera junto con la privada para mantener el par.

## Volumenes nombrados

| Volumen | Servicio | Contenido |
| --- | --- | --- |
| `aerobooking-pgdata` | PostgreSQL | Bases de datos y WAL |
| `aerobooking-rabbitmqdata` | RabbitMQ | Definiciones, colas y mensajes persistentes |
| `aerobooking-valkeydata` | Valkey | AOF con cache, locks e idempotencia |
| `aerobooking-loki-data` | Loki | Logs almacenados |
| `aerobooking-grafana-data` | Grafana | Usuarios, dashboards y estado |

## Notas para Windows

- Los scripts usan finales de linea LF. `.gitattributes` evita que Git los
  convierta a CRLF.
- Ejecutar los scripts desde Git Bash o WSL.
- Si aparece `permission denied`, ejecutar `chmod +x scripts/*.sh`.
