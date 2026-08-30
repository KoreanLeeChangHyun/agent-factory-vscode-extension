"use strict";

if (typeof globalThis.File === "undefined") {
  const { File } = require("node:buffer");
  Object.defineProperty(globalThis, "File", {
    configurable: true,
    value: File,
    writable: true
  });
}
