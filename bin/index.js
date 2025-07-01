#!/usr/bin/env node
import { bin } from "../lib/bin/index.js";

process.exitCode = bin(process.argv[2]);
