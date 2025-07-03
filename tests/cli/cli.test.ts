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

	it("creates maxstack.tsx in the output directory", async () => {
		const fs = await import("fs/promises");
		const outdir = "tmp-test-app";
		const outdirAbs = path.resolve(__dirname, "../../", outdir);

		let debugInfo = "";
		debugInfo += `__dirname: ${__dirname}\n`;
		debugInfo += `CLI_PATH: ${CLI_PATH}\n`;
		debugInfo += `outdir: ${outdir}\n`;
		debugInfo += `outdirAbs: ${outdirAbs}\n`;

		// Remove outdir if it exists from previous runs
		await fs.rm(outdirAbs, { force: true, recursive: true });

		const parentDirFiles = await fs
			.readdir(path.dirname(outdirAbs))
			.catch(() => []);
		debugInfo += `outdirAbs after rm: ${outdirAbs}, parentDirFiles: ${JSON.stringify(parentDirFiles)}\n`;

		const { exitCode, stderr, stdout } = await execa("node", [
			CLI_PATH,
			"init",
			"--outdir",
			outdir,
		]);
		const afterCliFiles = await fs.readdir(outdirAbs).catch(() => []);
		debugInfo += `after CLI run, outdirAbs: ${outdirAbs}, files: ${JSON.stringify(afterCliFiles)}\n`;
		const configPath = path.join(outdirAbs, "maxstack.tsx");
		debugInfo += `configPath: ${configPath}\n`;
		const exists = await fs.stat(configPath).then(
			() => true,
			() => false,
		);

		if (!exists) {
			const files = await fs.readdir(outdirAbs).catch(() => []);
			throw new Error(
				`maxstack.tsx not found. Directory listing for ${outdirAbs}: ${JSON.stringify(files)}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}\nDEBUG:\n${debugInfo}`,
			);
		}

		// Clean up
		await fs.rm(outdirAbs, { force: true, recursive: true });

		expect(exists).toBe(true);
		expect(exitCode).toBe(0);
	});
});
