export interface GreetOptions {
	logger?: (message: string) => void;
	message: string;
	times?: number;
}

export interface MaxStackConfig {
	build?: {
		minify?: boolean;
		outDir?: string;
		sourcemap?: boolean;
		target?: string;
	};
	description?: string;
	dev?: {
		host?: string;
		https?: boolean;
		open?: boolean;
		port?: number;
	};
	env?: Record<string, string>;
	name: string;
	plugins?: unknown[];
	version?: string;
}

export function defineConfig(config: MaxStackConfig): MaxStackConfig {
	return config;
}
