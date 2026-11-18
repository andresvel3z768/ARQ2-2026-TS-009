# Docker Compose

## Estado actual: Fase 1

La Fase 1 deja el esqueleto del proyecto. El archivo `docker-compose.yml` define:

- Nombre del proyecto: `aerobooking`.
- Red bridge: `aerobooking-net`.
- Volumenes nombrados para PostgreSQL, RabbitMQ, Valkey, Loki y Grafana.
- Politica comun de logs (`max-size: 10m`, `max-file: 3`).
- Un mapa `services: {}` vacio, que se completa en las siguientes fases.

Todavia no se levantan contenedores. Esto es intencional: primero se valida la
convencion de red, volumenes, variables y documentacion.

## Servicios planificados

| Servicio | Fase | Perfil | Puerto host | Funcion |
| --- | --- | --- | --- | --- |
| `postgres` | 2 | core | `127.0.0.1:5432` | Estado de bookings, saga, outbox/inbox y auditoria |
| `valkey` | 2 | core | `127.0.0.1:6379` | Cache de tarifas, seat locks e idempotencia |
| `rabbitmq` | 2 | core | `127.0.0.1:5672`, `127.0.0.1:15672` | Bus de eventos AMQP y consola de administracion |
| `kong` | 3 | core | `0.0.0.0:8000`, `127.0.0.1:8001` | Unico punto de entrada, JWT, rate limiting e idempotencia |
| `jaeger` | 4 | core | `127.0.0.1:16686`, `4317`, `4318` | Trazas distribuidas y UI de diagnostico |
| `loki` | 5 | observability | `127.0.0.1:3100` | Almacen de logs |
| `grafana` | 5 | observability | `127.0.0.1:3000` | Visualizacion de logs y trazas |
| `alloy` | 5 | observability | `127.0.0.1:12345` | Envio de logs Docker hacia Loki |
| `mock-airline` | 6 | mock | `127.0.0.1:8089` | Simulacion de la aerolinea externa |

Los puertos de administracion se publican solo en loopback. El unico puerto
pensado para clientes externos es el proxy de Kong (`8000`).

## Perfiles

Docker Compose permite activar grupos de servicios con `--profile`:

| Perfil | Servicios | Uso |
| --- | --- | --- |
| core (sin perfil) | PostgreSQL, Valkey, RabbitMQ, Kong, Jaeger | Base obligatoria |
| `observability` | Loki, Grafana, Alloy | Logs centralizados opcionales |
| `mock` | WireMock | Pruebas sin aerolinea real |

Jaeger no pertenece al perfil `observability`: arranca siempre con el stack
base porque es un requisito academico.

## Comandos

```bash
# Crear el archivo de variables local
cp .env.example .env

# Validar el compose (no levanta nada)
docker compose config -q

# Verificar archivos y configuracion
./scripts/verify.sh

# Levantar el stack base
./scripts/up.sh

# Levantar con observabilidad opcional
./scripts/up.sh --profile observability

# Levantar con observabilidad y mock de aerolinea
./scripts/up.sh --profile observability --profile mock

# Detener todo
docker compose down

# Detener y borrar volumenes (pierde datos locales)
docker compose down -v
```

## Convenciones

- **Red:** todos los servicios comparten `aerobooking-net` y se resuelven por
  nombre de servicio (por ejemplo, `postgres:5432`).
- **Volumenes:** los datos no se guardan dentro del repositorio. Se usan
  volumenes nombrados para evitar perder informacion al recrear contenedores.
- **Logs:** cada servicio debe usar el ancla `x-logging` para limitar el tamano
  de los archivos de log.
- **Secretos:** las credenciales viven en `.env`; los valores de `.env.example`
  son solo plantillas.

## Siguiente fase

La Fase 2 agrega PostgreSQL, Valkey y RabbitMQ, junto con sus healthchecks,
scripts de inicializacion y topologia de eventos.
