const connection = {
  host: process.env.PGHOST || "127.0.0.1",
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "notasmax",
  user: process.env.PGUSER || "notasmax",
  password: process.env.PGPASSWORD
};

module.exports = {
  development: {
    client: "pg",
    connection,
    pool: {
      min: 0,
      max: 5,
      acquireTimeoutMillis: 2500
    },
    migrations: {
      directory: "./migrations",
      extension: "js"
    }
  }
};
