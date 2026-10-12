import { after, describe, test } from "node:test";
import * as lib from "../../dist/index.js";
import scenarios from "./scenarios.cjs";

scenarios.defineScenarios(lib, { describe, test, after });
