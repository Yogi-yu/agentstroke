// One-time provisioning INSIDE the user-approved existing Postgres instance.
// Never runs automatically in the app. Does not inspect or mutate business tables.
// Usage: node --env-file=/path/to/.env.local scripts/provision-noema-database.cjs --create
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');
const expectedHost = 'dpg-d9462rnlk1mc73ahpv9g-a';
const databaseName = 'noema';
const roleName = 'noema_app';
const output = path.resolve('.noema/provisioned.env');

async function main() {
  if (process.argv[2] !== '--create') throw new Error('Explicit --create required.');
  if (!process.env.NOEMA_ADMIN_DATABASE_URL) throw new Error('Missing admin configuration.');
  if (fs.existsSync(output)) throw new Error('Credential output already exists; verify existing provisioning instead of rotating credentials.');
  const url = new URL(process.env.NOEMA_ADMIN_DATABASE_URL);
  if (!url.hostname.startsWith(expectedHost + '.') || decodeURIComponent(url.pathname.slice(1)) !== 'easymoney_mlb_trade') throw new Error('Unexpected PostgreSQL target.');
  // External Render URL uses TLS with certificate and hostname verification.
  url.searchParams.delete('sslmode');
  const admin = new Client({connectionString:url.href,ssl:{rejectUnauthorized:true},connectionTimeoutMillis:15000,application_name:'noema-provision'});
  await admin.connect();
  const password = crypto.randomBytes(32).toString('hex');
  let provisioned = false;
  try {
    const collision = await admin.query('SELECT datname AS name FROM pg_database WHERE datname=$1 UNION ALL SELECT rolname AS name FROM pg_roles WHERE rolname=$2',[databaseName,roleName]);
    if (collision.rows.length) throw new Error('Noema database or role already exists; refusing to change it.');
    const adminRole = (await admin.query('SELECT rolname AS name, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0];
    if (!adminRole?.rolcreatedb || !adminRole?.rolcreaterole) throw new Error('Admin role lacks provisioning privileges.');
    const self = adminRole.name;
    const quote = value => '"' + value.replaceAll('"','""') + '"';
    // All object names and password alphabet are fixed or generated locally.
    await admin.query(`CREATE ROLE ${quote(roleName)} LOGIN PASSWORD '${password}' NOCREATEDB NOCREATEROLE NOINHERIT`);
    // Record the new credential immediately for recovery if CREATE DATABASE fails.
    const external = new URL(url); external.username=roleName; external.password=password; external.pathname='/'+databaseName; external.searchParams.set('sslmode','verify-full');
    const internal = new URL(external); internal.hostname=expectedHost; internal.search='';
    fs.mkdirSync(path.dirname(output),{recursive:true,mode:0o700});
    fs.writeFileSync(output,`DATABASE_URL=${external.href}\nNOEMA_RENDER_DATABASE_URL=${internal.href}\n`,{flag:'wx',mode:0o600});
    // Required by PostgreSQL CREATE DATABASE OWNER; no existing role is changed.
    await admin.query(`GRANT ${quote(roleName)} TO ${quote(self)}`);
    await admin.query(`CREATE DATABASE ${quote(databaseName)} OWNER ${quote(roleName)}`);
    provisioned = true;
    // Prevent PUBLIC use of the new database. The app role remains its owner.
    await admin.query(`REVOKE ALL ON DATABASE ${quote(databaseName)} FROM PUBLIC`);
    await admin.query(`REVOKE ${quote(roleName)} FROM ${quote(self)}`);
    console.log(JSON.stringify({database:databaseName,role:roleName,credentialFile:output,existingBusinessTables:'unchanged'}));
  } finally { await admin.end(); }
  if (!provisioned) throw new Error('Provisioning was not completed.');
}
main().catch(() => {
  console.error('Provisioning stopped. No existing business tables were changed. Check whether a Noema role/database or protected .noema/provisioned.env already exists before retrying.');
  process.exitCode=1;
});
