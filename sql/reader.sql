-- The agent's database role: SELECT on commerce tables and nothing else. Run by the operator CLI as the branch owner.
-- The CLI sets the password separately (ALTER ROLE ... PASSWORD) and writes it only to the local .env file.
-- Branches created from this one inherit the role and its grants.

do $$
begin
  if not exists (select from pg_roles where rolname = 'agent_reader') then
    create role agent_reader login;
  end if;
end $$;

-- A new role is already NOSUPERUSER, NOREPLICATION and NOBYPASSRLS; a non-superuser owner (Neon's neondb_owner) may
-- not even name those attributes, so only the ones it may set are listed.
alter role agent_reader nocreatedb nocreaterole noinherit connection limit 10;
alter role agent_reader set default_transaction_read_only = on;
alter role agent_reader set statement_timeout = '5s';
alter role agent_reader set idle_in_transaction_session_timeout = '10s';

-- No object creation anywhere, no temporary tables.
revoke create on schema public from public;
revoke all on schema public from agent_reader;
do $$
begin
  execute format('revoke temporary on database %I from public', current_database());
  execute format('revoke temporary on database %I from agent_reader', current_database());
  execute format('grant connect on database %I to agent_reader', current_database());
end $$;

grant usage on schema commerce to agent_reader;
revoke create on schema commerce from agent_reader;
grant select on all tables in schema commerce to agent_reader;
alter default privileges in schema commerce grant select on tables to agent_reader;
