#!/usr/bin/env bash
#
# One database and one login role per service.
#
# Runs once, on first start of an empty data volume. To re-run it after
# changing this file: `npm run infra:reset` (this deletes all local data).
set -euo pipefail

admin() {
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" "$@"
}

# create_service_database <service> <password> [extension ...]
#
# Creates nursery_<service> plus a nursery_<service>_shadow twin. The shadow
# database is scratch space for `prisma migrate dev`, which replays every
# migration into an empty database to detect drift.
create_service_database() {
  local service="$1" password="$2"
  shift 2
  local role="svc_${service}"
  local database="nursery_${service}"
  local shadow="nursery_${service}_shadow"

  admin --dbname postgres <<SQL
CREATE ROLE ${role} LOGIN PASSWORD '${password}';

-- template0, not the default template1: the postgis image preloads
-- extensions into template1, and a database that inherits extensions it
-- never asked for shows up as drift on the first Prisma migration.
CREATE DATABASE ${database} OWNER ${role} TEMPLATE template0;
CREATE DATABASE ${shadow}   OWNER ${role} TEMPLATE template0;

-- THE isolation rule. CONNECT is granted to PUBLIC by default, which would
-- let svc_inventory open nursery_catalogue and join across the boundary
-- the architecture is built on. Revoke it, then give it back to the owner.
REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC;
REVOKE CONNECT ON DATABASE ${shadow}   FROM PUBLIC;
GRANT  CONNECT ON DATABASE ${database} TO ${role};
GRANT  CONNECT ON DATABASE ${shadow}   TO ${role};
SQL

  # Extensions are created here, as superuser, rather than in a Prisma
  # migration. PostGIS is not a "trusted" extension, so the service's own
  # least-privilege role cannot CREATE EXTENSION it — and on managed
  # Postgres the same is true, where it is preinstalled for you.
  local extension db
  for extension in "$@"; do
    for db in "$database" "$shadow"; do
      admin --dbname "$db" -c "CREATE EXTENSION IF NOT EXISTS ${extension};"
    done
  done

  echo ">> created ${database} (owner ${role}) $([ $# -gt 0 ] && echo "with: $*")"
}

# Partner owns nursery locations, so it is the only service needing PostGIS.
create_service_database partner   "${PARTNER_DB_PASSWORD:?missing}"   postgis
create_service_database inventory "${INVENTORY_DB_PASSWORD:?missing}"
create_service_database catalogue "${CATALOGUE_DB_PASSWORD:?missing}"
