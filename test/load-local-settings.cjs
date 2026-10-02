const fs = require("node:fs");
const path = require("node:path");

const settingsPath = path.join(__dirname, "..", "local.settings.json");
if (fs.existsSync(settingsPath)) {
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  for (const [name, value] of Object.entries(settings.Values || {})) {
    if (typeof value === "string" && process.env[name] === undefined) {
      process.env[name] = value;
    }
  }
}
