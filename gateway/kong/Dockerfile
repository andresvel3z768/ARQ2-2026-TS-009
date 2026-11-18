FROM kong:3.9
USER root
COPY plugins /usr/local/share/lua/5.1/kong/plugins
ENV KONG_PLUGINS=bundled,idempotency,jwt-revocation
USER kong
