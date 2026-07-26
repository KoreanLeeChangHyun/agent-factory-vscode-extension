"use strict";

const { mkdirSync } = require("node:fs");
const { join } = require("node:path");

mkdirSync(join(__dirname, "..", "dist"), { recursive: true });
