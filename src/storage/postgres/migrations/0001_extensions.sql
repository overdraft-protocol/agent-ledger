-- Extensions required by ARCHITECTURE.md § Storage schema.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gin;
-- pg_stat_statements is loaded via shared_preload_libraries; CREATE EXTENSION installs the view.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
