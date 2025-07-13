import { execa } from "execa";
import path from "path";
import { describe, expect, it } from "vitest";

const CLI_PATH = path.resolve(__dirname, "../../bin/index.js");

describe("CLI", () => {
	it("shows help with --help", async () => {
		const { exitCode, stdout } = await execa("node", [CLI_PATH, "--help"]);
		expect(stdout).toMatch(/Usage|Help/i);
		expect(exitCode).toBe(0);
	});

	it("shows version with --version", async () => {
		const { exitCode, stdout } = await execa("node", [CLI_PATH, "--version"]);
		expect(stdout).toMatch(/\d+\.\d+\.\d+/);
		expect(exitCode).toBe(0);
	});

	it("shows init command help", async () => {
		const { exitCode, stdout } = await execa("node", [
			CLI_PATH,
			"init",
			"--help",
		]);
		expect(stdout).toMatch(/Initialize a new MaxStack application/i);
		expect(exitCode).toBe(0);
	});
});
