import { Command } from "commander";
import { existsSync, writeFileSync } from "fs";
import { resolve } from "path";

interface InitOptions {
	force?: boolean;
	template?: string;
}

export const initCommand = new Command("init")
	.description("Initialize a new MaxStack configuration file")
	.option("-f, --force", "overwrite existing maxstack.ts file")
	.option("-t, --template <type>", "configuration template to use", "default")
	.action((options: InitOptions) => {
		const configPath = resolve(process.cwd(), "maxstack.ts");

		// Check if file already exists
		if (existsSync(configPath) && !options.force) {
			console.error("❌ maxstack.ts already exists. Use --force to overwrite.");
			return;
		}

		try {
			const configContent = generateConfigTemplate(
				options.template ?? "default",
			);
			writeFileSync(configPath, configContent, "utf8");
			console.log("✅ Created maxstack.ts configuration file");
		} catch (error) {
			console.error(
				"❌ Failed to create configuration file:",
				(error as Error).message,
			);
		}
	});

function generateConfigTemplate(templateType: string): string {
	const templates = {
		default: `import { defineConfig } from 'maxstack';

export default defineConfig({
  // Your MaxStack configuration
  name: 'my-project',
  version: '1.0.0',
  
  // Development server configuration
  dev: {
    port: 3000,
    host: 'localhost',
  },
  
  // Build configuration
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  
  // Add your custom configuration here
});`,

		full: `import { defineConfig } from 'maxstack';

export default defineConfig({
  name: 'my-project',
  version: '1.0.0',
  description: 'A MaxStack project',
  
  dev: {
    port: 3000,
    host: 'localhost',
    https: false,
    open: true,
  },
  
  build: {
    outDir: 'dist',
    sourcemap: true,
    minify: true,
    target: 'es2020',
  },
  
  plugins: [
    // Add your plugins here
  ],
  
  env: {
    // Environment variables
  },
});`,

		minimal: `import { defineConfig } from 'maxstack';

export default defineConfig({
  name: 'my-project',
});`,
	};

	return templates[templateType as keyof typeof templates] || templates.default;
}
