"use strict";

const { isIP } = require("node:net");

function isLoopbackHost(host) {
  if (typeof host !== "string" || host.trim() === "") {
    return false;
  }

  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "localhost.") {
    return true;
  }

  if (isIP(normalized) === 4) {
    return normalized.split(".")[0] === "127";
  }

  if (isIP(normalized) !== 6) {
    return false;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) {
    return false;
  }

  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return false;
  }

  const words = [...left, ...Array(Math.max(0, missing)).fill("0"), ...right];
  return words.length === 8 && words.slice(0, 7).every((word) => Number.parseInt(word, 16) === 0)
    && Number.parseInt(words[7], 16) === 1;
}

function assertLoopbackHost(host) {
  if (!isLoopbackHost(host)) {
    throw new Error("Database commands are restricted to loopback PostgreSQL hosts.");
  }
}

module.exports = { assertLoopbackHost, isLoopbackHost };
