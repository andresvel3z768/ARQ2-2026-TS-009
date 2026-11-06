# Infraestructura local de AeroBooking

Esta carpeta documenta el stack Docker Compose que da soporte al caso
AeroBooking. No reemplaza al `spec.md` ni a los ADRs: los traduce a decisiones
de infraestructura ejecutables en local.

## Estado por fases

| Fase | Alcance | Estado |
| --- | --- | --- |
| 1 | Esqueleto, red, volumenes, scripts y documentacion base | Completada |
| 2 | PostgreSQL, Valkey y RabbitMQ | Pendiente |
| 3 | Kong y plugins de entrada | Pendiente |
| 4 | Jaeger obligatorio y trazas desde Kong | Pendiente |
| 5 | Loki, Grafana y Alloy (perfil `observability`) | Pendiente |
| 6 | Mock de aerolinea (perfil `mock`) | Pendiente |
| 7 | Documentacion final, verificacion y guion de demo | Pendiente |

## Estructura de carpetas

```text
infra/
├── kong/                 # Declarativo, plugins Lua y claves JWT
├── postgres/             # Init de roles y base de datos
├── rabbitmq/             # Configuracion y topologia del broker
├── valkey/               # Persistencia y politicas de cache/locks
├── observability/        # Jaeger, Loki, Grafana y Alloy
└── mock-airline/         # WireMock para simular la aerolinea
scripts/                  # Arranque, generacion de claves y verificacion
docs/infra/               # Esta documentacion
```

Las carpetas vacias se conservan con `.gitkeep` para que la estructura sea
visible en el repositorio desde la Fase 1.

## Documentacion

- [docker-compose.md](docker-compose.md): servicios, perfiles, puertos y comandos.
- [configuration.md](configuration.md): variables de entorno, volumenes y archivos generados.
- [operations.md](operations.md): verificacion, healthchecks y troubleshooting.

## Inicio rapido

```bash
cp .env.example .env
./scripts/verify.sh
./scripts/up.sh
```

En la Fase 1 todavia no hay servicios: `up.sh` valida la configuracion base y
avisa que los contenedores se agregan en la Fase 2.

## Decisiones que se mantienen durante todo el proyecto

- **Valkey** se usa como almacen de cache, locks e idempotencia. Los ADR 003 y
  004 originales mencionan Redis, pero `spec.md` y el diagrama C4 fijan Valkey.
  Valkey conserva el protocolo RESP, por lo que los clientes de Redis y los
  plugins de Kong funcionan sin cambios.
- **Jaeger** queda en el perfil `core` porque es un requisito explicito del
  profesor. Loki y Grafana son opcionales mediante el perfil `observability`.
- La infraestructura es **solo para desarrollo local**. No incluye TLS,
  hardening de produccion ni alta disponibilidad.
