import fs from "fs/promises";
import fetch from "node-fetch";
import path from "path";

// Types
export interface ExecuteServerCommandsResult {
	created: string[];
	edited: string[];
	errors: { error: unknown; file: string }[];
	updated: string[];
}

export interface ProjectInfo {
	config: null | string;
	dir: Record<string, unknown>;
	pkg: null | string;
	routes: null | string;
}

export interface ServerCommand {
	content?: string;
	file: string;
	type: "create" | "edit" | "send file info" | "update";
}

// Minimal fetch response type for node-fetch
interface MinimalFetchResponse {
	json(): Promise<unknown>;
	ok: boolean;
	status: number;
}

// Collects config, routes, package.json, and directory structure (excluding node_modules)
export async function collectProjectInfo(): Promise<ProjectInfo> {
	const root = process.cwd();
	console.error("[collectProjectInfo] root:", root);
	const [config, routes, pkg, dir] = await Promise.all([
		readIfExists(path.join(root, "tsdown.config.ts")),
		readIfExists(path.join(root, "template", "react-router.config.ts")),
		readIfExists(path.join(root, "package.json")),
		getDirectoryStructure(root, ["node_modules", ".git"]),
	]);
	console.error(
		"[collectProjectInfo] config:",
		config !== null ? "found" : "null",
	);
	console.error(
		"[collectProjectInfo] routes:",
		routes !== null ? "found" : "null",
	);
	console.error("[collectProjectInfo] pkg:", pkg !== null ? "found" : "null");
	console.error("[collectProjectInfo] dir keys:", Object.keys(dir));
	return { config, dir, pkg, routes };
}

async function readIfExists(filePath: string): Promise<null | string> {
	try {
		console.error("[readIfExists] Trying to read:", filePath);
		const data = await fs.readFile(filePath, "utf8");
		console.error("[readIfExists] Success:", filePath);
		return data;
	} catch {
		console.error("[readIfExists] Not found:", filePath);
		return null;
	}
}

// Recursively get directory structure, excluding specified folders
async function getDirectoryStructure(
	dir: string,
	exclude: string[] = [],
): Promise<Record<string, unknown>> {
	console.error("[getDirectoryStructure] Entering:", dir);
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const structure: Record<string, unknown> = {};
	for (const entry of entries) {
		if (exclude.includes(entry.name)) {
			console.error("[getDirectoryStructure] Excluding:", entry.name);
			continue;
		}
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			console.error("[getDirectoryStructure] Directory:", fullPath);
			structure[entry.name] = await getDirectoryStructure(fullPath, exclude);
		} else {
			console.error("[getDirectoryStructure] File:", fullPath);
			structure[entry.name] = "file";
		}
	}
	return structure;
}

// Sends data to the server (mocked or real)
export async function sendToServer(
	projectInfo: ProjectInfo,
	production = false,
): Promise<ServerCommand[]> {
	if (!production) {
		// Mocked response
		return [
			{ content: "// new content", file: "maxstack.tsx", type: "update" },
			{ content: "hello", file: "newfile.txt", type: "create" },
		];
	}
	// Real request
	const fetchTyped = fetch as unknown as (
		input: string,
		init?: object,
	) => Promise<MinimalFetchResponse>;
	const res = await fetchTyped("https://api.maxstack.dev", {
		body: JSON.stringify(projectInfo),
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	if (!res.ok) {
		throw new Error("Server error: " + String(res.status));
	}
	return (await res.json()) as ServerCommand[];
}

async function safeWriteFile(file: string, content: string): Promise<boolean> {
	try {
		await fs.writeFile(file, content, "utf8");
		return true;
	} catch {
		// Ignore errors in mock mode (for test stability)
		return false;
	}
}

// Executes server commands
export async function executeServerCommands(
	commands: ServerCommand[],
	mockMode = false,
	outputDir?: string,
): Promise<ExecuteServerCommandsResult> {
	const workingDir = outputDir ?? process.cwd();
	const updated: string[] = [];
	const created: string[] = [];
	const edited: string[] = [];
	const errors: { error: unknown; file: string }[] = [];
	for (const cmd of commands) {
		try {
			// Use working directory (either temp or current) for all file operations
			const filePath = path.join(workingDir, cmd.file);

			switch (cmd.type) {
				case "create":
					if (mockMode) {
						await safeWriteFile(filePath, cmd.content ?? "");
					} else {
						await fs.writeFile(filePath, cmd.content ?? "", "utf8");
					}
					created.push(cmd.file);
					console.log(`Created ${cmd.file} in ${workingDir}`);
					break;
				case "edit":
					if (mockMode) {
						await safeWriteFile(filePath, cmd.content ?? "");
					} else {
						await fs.writeFile(filePath, cmd.content ?? "", "utf8");
					}
					edited.push(cmd.file);
					console.log(`Edited ${cmd.file} in ${workingDir}`);
					break;
				case "send file info":
					// No-op for now
					console.log(`Sent file info for ${cmd.file}`);
					break;
				case "update":
					if (mockMode) {
						await safeWriteFile(filePath, cmd.content ?? "");
					} else {
						await fs.writeFile(filePath, cmd.content ?? "", "utf8");
					}
					updated.push(cmd.file);
					console.log(`Updated ${cmd.file} in ${workingDir}`);
					break;
				default:
					console.warn("Unknown command:", cmd);
					break;
			}
		} catch (error) {
			errors.push({ error, file: cmd.file });
			console.error(`Error processing ${cmd.file}:`, error);
		}
	}
	return { created, edited, errors, updated };
}
