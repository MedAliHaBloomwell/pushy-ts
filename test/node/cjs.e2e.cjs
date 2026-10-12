const { after, describe, test } = require("node:test");
const lib = require("../../dist/index.cjs");
const { defineScenarios } = require("./scenarios.cjs");

defineScenarios(lib, { describe, test, after });
