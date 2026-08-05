#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program
  .name("{{PROJECT_NAME}}")
  .description("{{DESCRIPTION}}")
  .version("0.1.0");

program
  .command("hello")
  .argument("[name]", "who to greet", "world")
  .description("Print a greeting")
  .action((name: string) => {
    console.log(`Hello, ${name}!`);
  });

program.parse(process.argv);
